import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk';
import type { Assertion, ElementInfo, ResolveOutcome, ResolvedStep, Snapshot, Step } from './types.js';

const MODEL = 'jev-latest';
const MAX_ELEMENTS = 60;

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
  navigate: 'Open a URL or path directly in the browser, e.g. "I am on /login" or "I visit the home page at /".',
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
  text_visible: 'The step expects specific literal text, given in `values`, to be visible on the page.',
  text_not_visible: 'The step expects specific literal text, given in `values`, to be absent from the page.',
  element_visible: 'The step expects a particular control from `page.elements` to be present, without caring about its content.',
  element_has_value: 'The step expects a particular input from `page.elements` to contain a literal from `values`.',
  url_contains: 'The step expects the browser address to be, or contain, a URL or path given in `values`.',
  semantic: 'The expectation is descriptive rather than literal (e.g. "a friendly error", "the list is sorted") and cannot be reduced to any of the other forms.',
} as const;

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

const tokens = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** Cap a large page to the elements sharing the most words with the step, preserving page order. */
export function shortlist(elements: ElementInfo[], stepText: string, max: number): ElementInfo[] {
  if (elements.length <= max) return elements;
  const stepTokens = tokens(stepText);
  const scored = elements.map((element, index) => {
    let overlap = 0;
    for (const token of tokens(`${element.role} ${element.name}`)) if (stepTokens.has(token)) overlap++;
    return { element, index, overlap };
  });
  return scored
    .sort((a, b) => b.overlap - a.overlap || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.element);
}

export async function resolve(input: ResolveInput): Promise<ResolveOutcome> {
  const { step, snapshot, values, client, minConfidence } = input;
  const elements = shortlist(snapshot.elements, step.text, MAX_ELEMENTS);
  const valueById: Record<string, string> = Object.fromEntries(values.map((value, i) => [`v${i + 1}`, value]));

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
  };

  const questions: Record<string, unknown> = {
    kind: choice(
      'A test runner is executing the Gherkin step in `step.text` against the web page in `page`. Which single browser interaction or check does the step call for?',
      KIND,
    ),
    assertion: choice(
      'Assume the Gherkin step in `step.text` is a check on the web page in `page`. Which form of check expresses what it expects?',
      ASSERTION,
    ),
    key: choice('Assume the Gherkin step in `step.text` asks for a keyboard key to be pressed. Which key?', KEY),
  };
  if (elements.length > 0) {
    questions.element = choice(
      'Which element of `page.elements` is the Gherkin step in `step.text` acting on or checking? Match on the element\'s role and name as a user would describe it.',
      {
        ...Object.fromEntries(elements.map((e) => [e.id, { role: e.role, name: e.name }])),
        none: 'None of the listed elements is what the step refers to, or the step does not refer to an element.',
      },
    );
  }
  if (values.length > 0) {
    questions.value = choice(
      'Which literal in `values` is the data the Gherkin step in `step.text` wants typed, selected, opened, or checked for? This is the data itself, not a literal that merely names the target element.',
      {
        ...Object.fromEntries(Object.entries(valueById).map(([id, value]) => [id, { literal: value }])),
        none: 'None of the literals is data for this step; any literals only name the target element.',
      },
    );
  }

  const { answers } = await client.systemOne({ state, questions, model: MODEL });

  // Record every answer we actually rely on; confidence is the least certain of these.
  const consumed: { id: string; answer: ChoiceAnswer }[] = [];
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
  const pickValue = () => {
    const id = pick('value');
    return id === undefined ? undefined : valueById[id];
  };
  const undefinedStep = (detail: string): ResolveOutcome => ({ ok: false, reason: 'undefined', detail });
  const NO_ELEMENT = 'No element on the page matches this step. Name the control as it appears on the page.';
  const NO_VALUE = 'The step has no literal value to use. Put the value in quotes, e.g. "alice@example.com".';

  // pick() maps 'none' to undefined, so 'none' never reaches the switch.
  const kind = pick('kind') as Exclude<keyof typeof KIND, 'none'> | undefined;
  let resolved: ResolvedStep;
  switch (kind) {
    case undefined:
      return undefinedStep('Jev found no browser interaction or check in this step.');
    case 'navigate': {
      const value = pickValue();
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
      const value = pickValue();
      if (value === undefined) return undefinedStep(NO_VALUE);
      resolved = { kind, locator: element.locator, value };
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
        const value = pickValue();
        if (value === undefined) return undefinedStep(NO_VALUE);
        assertion = { form, locator: element.locator, value };
      } else {
        const value = pickValue();
        if (value === undefined) return undefinedStep(NO_VALUE);
        assertion = { form, value };
      }
      resolved = { kind, assertion };
      break;
    }
  }

  const weakest = consumed.reduce((low, entry) => (entry.answer.confidence < low.answer.confidence ? entry : low));
  if (weakest.answer.confidence < minConfidence) {
    const describe = (label: string): string => {
      const element = elements.find((e) => e.id === label);
      if (weakest.id === 'element' && element) return `${element.role} "${element.name}"`;
      if (weakest.id === 'value' && label in valueById) return JSON.stringify(valueById[label]);
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
      detail: `Jev was not confident about the ${weakest.id} (${weakest.answer.confidence.toFixed(2)} < ${minConfidence}). Candidates: ${top}. Reword the step to be more specific.`,
    };
  }

  return { ok: true, resolved, confidence: weakest.answer.confidence };
}

/** Probability that the page satisfies a descriptive expectation. */
export async function semanticCheck(client: JevClient, stepText: string, snapshot: Snapshot): Promise<number> {
  const { answers } = await client.systemOne({
    state: { expectation: stepText, page: { url: snapshot.url, title: snapshot.title, text: snapshot.text } },
    questions: {
      holds: noul(
        'A test step states the expectation in `expectation`. Judging only from the web page in `page`, does the page satisfy that expectation?',
      ),
    },
    model: MODEL,
  });
  return answers.holds.noul as number;
}

export function createClient(): JevClient {
  if (!process.env.TYPESAFE_API_KEY) {
    throw new Error('TYPESAFE_API_KEY is not set; it is needed to resolve this step with Jev.');
  }
  const client = new TypeSafeClient();
  return { systemOne: (request) => client.systemOne(request as never) as never };
}
