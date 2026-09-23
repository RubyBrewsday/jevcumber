import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk';
import { mostRelevant } from './relevance.js';
import type { Assertion, ElementInfo, ResolveOutcome, ResolvedStep, Snapshot, Step } from './types.js';

const MODEL = 'jev-latest';
const MAX_ELEMENTS = 60;
export const PAGE_SOURCED_MIN_CONFIDENCE = 0.75;

export interface Judgment {
  holds: number;
  evidence?: string;
  /** Where the evidence lives: the document title is not visible text and is checked differently. */
  evidenceKind?: 'title' | 'text';
  evidenceConfidence?: number;
}

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevClient {
  systemOne(request: { state: unknown; questions: Record<string, unknown>; model?: string }): PromiseLike<{
    answers: Record<string, any>;
  }>;
}

export interface ResolveInput {
  step: Step;
  scenarioName: string;
  previousSteps: string[];
  snapshot: Snapshot;
  values: string[];
  client: JevClient;
  minConfidence: number;
}

const KIND = {
  navigate: 'Open a URL or path directly in the browser, e.g. "I am on /login" or "I visit the home page at /". Only for a Given or When step: a Then step saying "I am on the todos page" is a check that the page is showing (assert).',
  click: 'Click or tap an element such as a button, link, tab, or menu item.',
  fill: 'Type or enter text into an input field, replacing its content.',
  select: 'Choose an option from a dropdown or select box.',
  check: 'Turn a checkbox, radio button, or switch on.',
  uncheck: 'Turn a checkbox or switch off.',
  press: 'Press a single keyboard key such as Enter, Tab, or Escape.',
  assert: 'Check that something is true of the page without interacting with it. Typical of Then steps: "I should see…", "the field contains…", "the URL is…".',
  none: 'The step describes nothing a test runner could do or check in a web browser.',
} as const;

const ASSERTION = {
  text_visible: {
    what: 'The step expects a piece of text content from `values` to appear on the page: a message, heading, or other copy.',
    not_for: 'A control (field, button, link, checkbox) being shown, even when the control\'s name is quoted. That is element_visible.',
    examples: ['I should see "Welcome back"', 'the page says "Saved"'],
  },
  text_not_visible: {
    what: 'The step expects a piece of text content from `values` to be absent from the page.',
    examples: ['I should not see "Error"'],
  },
  element_visible: {
    what: 'The step expects one specific control from `page.elements` (a field, button, link, checkbox) to be present or visible, whatever it contains. The control may be named in quotes.',
    not_for: 'Content the step describes rather than names: results, lists, messages, images, sections. That is semantic.',
    examples: ['the "Save" button is shown', 'there is a search field', 'the "Remember me" checkbox is present'],
  },
  element_has_value: {
    what: 'The step expects a particular input from `page.elements` to contain a literal from `values`.',
    examples: ['the email field contains "a@b.c"', 'the "Country" dropdown shows "France"'],
  },
  url_contains: {
    what: 'The step expects the browser address to be, or contain, a URL or path given in `values`.',
    examples: ['the URL should contain "/todos"', 'I am redirected to "/login"'],
  },
  semantic: {
    what: 'The step describes what the page should show rather than quoting text or naming one control, so it cannot be reduced to any of the other forms.',
    examples: ['I see a friendly error', 'the list is sorted by date', 'search results about cats are shown', 'there are several products'],
  },
};

const KEY = {
  Enter: 'The Enter or Return key, including "submit with the keyboard".',
  Tab: 'The Tab key.',
  Escape: 'The Escape key, including "dismiss with the keyboard".',
  Space: 'The space bar.',
  Backspace: 'The Backspace key.',
  Delete: 'The Delete key.',
  ArrowUp: 'The up arrow key.',
  ArrowDown: 'The down arrow key.',
  ArrowLeft: 'The left arrow key.',
  ArrowRight: 'The right arrow key.',
  none: 'The step does not name any of these keys.',
} as const;

const AFTER_TYPING = {
  submit: {
    what: 'The step implies the typed text is then submitted, as a user would by pressing Enter.',
    examples: ['I search for "bagels"', 'I look up "order 1234"', 'I submit "hello" in the chat box'],
  },
  stay: {
    what: 'The step only asks for text to be entered into a field; submitting, if any, is a separate step.',
    examples: ['I fill in the email field with "a@b.c"', 'I type "secret" into the password box', 'I enter "Paris" as the city'],
  },
};

// What each assertion form needs in order to be executable; code never offers Jev a form it could not act on.
const ASSERTION_NEEDS: Record<keyof typeof ASSERTION, { element?: true; value?: true }> = {
  text_visible: { value: true },
  text_not_visible: { value: true },
  element_visible: { element: true },
  element_has_value: { element: true, value: true },
  url_contains: { value: true },
  semantic: {},
};

type ValueQuestionId = 'target_url' | 'input_text' | 'expected_text';

// [question id, instructions, description of the no-match option]
const VALUE_QUESTIONS: [ValueQuestionId, string, string][] = [
  [
    'target_url',
    'Assume the Gherkin step in `step.text` asks the browser to open a page. Which literal in `values` is the URL or path to open?',
    'None of the literals is a URL or path.',
  ],
  [
    'expected_text',
    'Assume the Gherkin step in `step.text` checks the page. Which literal in `values` is the text, field value, or URL fragment the step expects to find, or expects to be absent? A literal that only names the element being checked is not it.',
    'None of the literals is an expected text, value, or URL fragment.',
  ],
];

const INPUT_TEXT_INSTRUCTIONS =
  'Assume the Gherkin step in `step.text` asks for text to be typed into a field, or an option to be chosen. Which entry is the text to type or the option to choose? Literals from the step are in `values`; `page_text` holds things the page says, for when the step describes the text (e.g. "his wife") rather than quoting it. A literal that only names the field is not it.';
const INPUT_TEXT_NONE = 'Neither the literals nor the page text give what to type; the literals only name the field.';

/** Cap a large page to the elements sharing the most words with the step, preserving page order. */
export function shortlist(elements: ElementInfo[], stepText: string, max: number): ElementInfo[] {
  return mostRelevant(elements, stepText, (element) => `${element.role} ${element.name}`, max);
}

export async function resolve(input: ResolveInput): Promise<ResolveOutcome> {
  const { step, snapshot, values, client, minConfidence } = input;
  const elements = shortlist(snapshot.elements, step.text, MAX_ELEMENTS);
  const valueById: Record<string, string> = Object.fromEntries(values.map((value, i) => [`v${i + 1}`, value]));
  const pageTextById: Record<string, string> = Object.fromEntries(snapshot.evidence.map((t, i) => [`p${i + 1}`, t]));

  const state = {
    step: { keyword: step.keyword, text: step.text },
    scenario: { name: input.scenarioName, previous_steps: input.previousSteps },
    page: {
      url: snapshot.url,
      title: snapshot.title,
      elements: elements.map(({ id, role, name, value }) => (value === undefined ? { id, role, name } : { id, role, name, value })),
      text: snapshot.text,
    },
    values: valueById,
    ...(Object.keys(pageTextById).length > 0 ? { page_text: pageTextById } : {}),
  };

  const questions: Record<string, unknown> = {
    kind: choice(
      'A test runner is executing the Gherkin step in `step.text` against the web page in `page`. Which single browser interaction or check does the step call for?',
      KIND,
    ),
    key: choice('Assume the Gherkin step in `step.text` asks for a keyboard key to be pressed. Which key?', KEY),
  };
  const feasibleForms = (Object.keys(ASSERTION) as (keyof typeof ASSERTION)[]).filter(
    (form) => (!ASSERTION_NEEDS[form].element || elements.length > 0) && (!ASSERTION_NEEDS[form].value || values.length > 0),
  );
  // With a single feasible form (always `semantic`) there is nothing to ask.
  if (feasibleForms.length > 1) {
    questions.assertion = choice(
      'Assume the Gherkin step in `step.text` is a check on the web page in `page`. Which form of check expresses what it expects?',
      Object.fromEntries(feasibleForms.map((form) => [form, ASSERTION[form]])),
    );
  }
  if (elements.length > 0 && values.length > 0) {
    questions.after_typing = choice(
      'Assume the Gherkin step in `step.text` asks for text to be typed into a field. Once the text is typed, does the step imply submitting it?',
      AFTER_TYPING,
    );
  }
  if (elements.length > 0) {
    questions.element = choice(
      'Which element of `page.elements` is the Gherkin step in `step.text` acting on or checking? The step may name the element as a user would (by its role and name), or describe it (e.g. "the link to his wife"): use `page.text` to work out which element that is.',
      {
        ...Object.fromEntries(elements.map((e) => [e.id, { role: e.role, name: e.name }])),
        none: 'None of the listed elements is what the step refers to, or the step does not refer to an element.',
      },
    );
  }
  if (values.length > 0) {
    // One question per purpose: a generic "which literal is the data?" let `none` look plausible
    // for navigation, because a path can also be read as naming the step's target.
    const options = Object.fromEntries(Object.entries(valueById).map(([id, value]) => [id, { literal: value }]));
    for (const [id, instructions, none] of VALUE_QUESTIONS) {
      questions[id] = choice(instructions, { ...options, none });
    }
  }
  if (values.length > 0 || (elements.length > 0 && snapshot.evidence.length > 0)) {
    const literalOptions = Object.fromEntries(Object.entries(valueById).map(([id, value]) => [id, { literal: value }]));
    const pageTextOptions =
      elements.length > 0 ? Object.fromEntries(Object.entries(pageTextById).map(([id, t]) => [id, { page_text: t }])) : {};
    questions.input_text = choice(INPUT_TEXT_INSTRUCTIONS, { ...literalOptions, ...pageTextOptions, none: INPUT_TEXT_NONE });
  }

  const { answers } = await client.systemOne({ state, questions, model: MODEL });

  const kindAnswer = answers.kind as ChoiceAnswer | undefined;
  if (!kindAnswer || typeof kindAnswer.choice !== 'string') {
    throw new Error('Unexpected response from Jev: no answer for "kind".');
  }

  // Record every answer we actually rely on; confidence is the least certain of these.
  const consumed: { id: string; answer: ChoiceAnswer; pageSourced?: boolean }[] = [];
  const pick = (id: string): string | undefined => {
    const answer = answers[id] as ChoiceAnswer | undefined;
    if (!answer) return undefined;
    consumed.push({ id, answer });
    return answer.choice === 'none' ? undefined : answer.choice;
  };
  const pickElement = () => {
    const id = pick('element');
    return elements.find((element) => element.id === id);
  };
  const pickValue = (question: ValueQuestionId) => {
    const id = pick(question);
    if (id === undefined) return undefined;
    if (id in pageTextById) {
      const entry = consumed.find((e) => e.id === question);
      if (entry) entry.pageSourced = true;
      return pageTextById[id];
    }
    return valueById[id];
  };
  const undefinedStep = (detail: string): ResolveOutcome => ({ ok: false, reason: 'undefined', detail });
  const NO_ELEMENT = 'No element on the page matches this step. Name the control as it appears on the page.';
  const NO_VALUE = 'The step has no literal value to use. Put the value in quotes, e.g. "alice@example.com".';

  // pick() maps 'none' to undefined, so 'none' never reaches the switch.
  const kind = pick('kind') as Exclude<keyof typeof KIND, 'none'> | undefined;
  let resolved: ResolvedStep;
  switch (kind) {
    case undefined:
      return undefinedStep(
        values.length > 0
          ? 'Jev found no browser interaction or check in this step.'
          : 'Jev found no browser interaction or check in this step. jevcumber never invents values: if the step should type or look for something, put it in quotes, e.g. I search for "Michelle Obama".',
      );
    case 'navigate': {
      const value = pickValue('target_url');
      if (value === undefined) {
        return undefinedStep('Navigation steps need a literal path or URL, e.g. Given I am on "/login".');
      }
      resolved = { kind, value };
      break;
    }
    case 'click':
    case 'check':
    case 'uncheck': {
      const element = pickElement();
      if (!element) return undefinedStep(NO_ELEMENT);
      resolved = { kind, locator: element.locator };
      break;
    }
    case 'fill':
    case 'select': {
      const element = pickElement();
      if (!element) return undefinedStep(NO_ELEMENT);
      const value = pickValue('input_text');
      if (value === undefined) return undefinedStep(NO_VALUE);
      resolved =
        kind === 'fill' && pick('after_typing') === 'submit'
          ? { kind, locator: element.locator, value, submit: true }
          : { kind, locator: element.locator, value };
      break;
    }
    case 'press': {
      const key = pick('key');
      if (!key) return undefinedStep('The step does not name a supported key (Enter, Tab, Escape, Space, Backspace, Delete, arrows).');
      const element = pickElement();
      resolved = element ? { kind, key, locator: element.locator } : { kind, key };
      break;
    }
    case 'assert': {
      const form = (pick('assertion') ?? 'semantic') as Assertion['form'];
      let assertion: Assertion;
      if (form === 'semantic') {
        assertion = { form };
      } else if (form === 'element_visible') {
        const element = pickElement();
        if (!element) return undefinedStep(NO_ELEMENT);
        assertion = { form, locator: element.locator };
      } else if (form === 'element_has_value') {
        const element = pickElement();
        if (!element) return undefinedStep(NO_ELEMENT);
        const value = pickValue('expected_text');
        if (value === undefined) return undefinedStep(NO_VALUE);
        assertion = { form, locator: element.locator, value };
      } else {
        const value = pickValue('expected_text');
        if (value === undefined) return undefinedStep(NO_VALUE);
        assertion = { form, value };
      }
      resolved = { kind, assertion };
      break;
    }
  }

  // Each answer is held to its own bar: a page-sourced pick (a `p…` id) needs the higher
  // page-sourced confidence; every other answer keeps the caller's minConfidence.
  const withBar = consumed.map((entry) => ({
    entry,
    bar: entry.pageSourced ? Math.max(minConfidence, PAGE_SOURCED_MIN_CONFIDENCE) : minConfidence,
  }));
  const failing = withBar.filter(({ entry, bar }) => entry.answer.confidence < bar);
  if (failing.length > 0) {
    const { entry: weakest, bar } = failing.reduce((worst, cur) =>
      cur.bar - cur.entry.answer.confidence > worst.bar - worst.entry.answer.confidence ? cur : worst,
    );
    const describe = (label: string): string => {
      const element = elements.find((e) => e.id === label);
      if (weakest.id === 'element' && element) return `${element.role} "${element.name}"`;
      if (weakest.id !== 'element' && label in valueById) return JSON.stringify(valueById[label]);
      if (weakest.id !== 'element' && label in pageTextById) return JSON.stringify(pageTextById[label]);
      return label;
    };
    const top = Object.entries(weakest.answer.probabilities)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([label, p]) => `${describe(label)} (${Math.round(p * 100)}%)`)
      .join(', ');
    return {
      ok: false,
      reason: 'ambiguous',
      detail: `Jev was not confident about the ${weakest.id.replace('_', ' ')} (${weakest.answer.confidence.toFixed(2)} < ${bar}). Candidates: ${top}. Reword the step to be more specific.`,
    };
  }

  const confidence = Math.min(...consumed.map((entry) => entry.answer.confidence));
  return { ok: true, resolved, confidence };
}

/** Does the page satisfy a described expectation — and which page item shows it? */
export async function judge(client: JevClient, stepText: string, snapshot: Snapshot): Promise<Judgment> {
  const evidence = snapshot.evidence.map((text, i) => ({ id: `x${i + 1}`, text }));
  const questions: Record<string, unknown> = {
    // Spelling out both answers matters: measured on live pages, it moved true expectations from
    // 0.67-0.88 to 0.95-0.98 while false ones stayed at or below 0.22.
    holds: noul('Does the web page in `page` show what `expectation` describes?', {
      true: "The page's title and content are what the expectation describes. A page mainly about the named subject counts, even if the expectation uses a short or informal name for it.",
      false: 'The page is about something else, or is an error page, a login wall, a bot check, or empty.',
    }),
  };
  if (evidence.length > 0) {
    questions.evidence = choice(
      'Assume the web page in `page` satisfies `expectation`. Which single item of `page.evidence` best shows that it does? Prefer the page title or a heading that names what the expectation is about; choose a link or button only when the expectation is about that control.',
      {
        ...Object.fromEntries(evidence.map((e) => [e.id, { text: e.text }])),
        none: 'No single item shows it; the expectation is about the page as a whole, an ordering, a count, or something not captured by any listed item.',
      },
    );
  }
  const { answers } = await client.systemOne({
    state: { expectation: stepText, page: { url: snapshot.url, title: snapshot.title, text: snapshot.text, evidence } },
    questions,
    model: MODEL,
  });
  const holds = answers.holds as { noul?: unknown } | undefined;
  if (typeof holds?.noul !== 'number') throw new Error('Unexpected response from Jev: no answer for "holds".');
  const picked = answers.evidence as ChoiceAnswer | undefined;
  const item = picked && picked.choice !== 'none' ? evidence.find((e) => e.id === picked.choice) : undefined;
  // Several items can legitimately show the same thing (a title and an h1 that agree), which spreads
  // probability and lowers the distribution's confidence even though any of them is a sound pin.
  // The chosen item's own probability is the better guard against pinning to something incidental.
  return item
    ? { holds: holds.noul, evidence: item.text, evidenceKind: item.text === snapshot.title ? 'title' : 'text', evidenceConfidence: picked!.probabilities[picked!.choice] }
    : { holds: holds.noul };
}

export function createClient(): JevClient {
  if (!process.env.TYPESAFE_API_KEY) {
    throw new Error('TYPESAFE_API_KEY is not set; it is needed to resolve this step with Jev.');
  }
  const client = new TypeSafeClient();
  return { systemOne: (request) => client.systemOne(request as never) as never };
}
