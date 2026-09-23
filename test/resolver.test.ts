import { describe, expect, it } from 'vitest';
import { judge, resolve, shortlist, type JevClient } from '../src/resolver.js';
import type { ElementInfo, Snapshot, Step } from '../src/types.js';

const el = (id: string, role: string, name: string): ElementInfo => ({
  id, role, name, locator: { by: 'role', role, name },
});
const SNAP: Snapshot = {
  url: 'http://app/login',
  title: 'Login',
  text: 'Sign in',
  elements: [el('e1', 'textbox', 'Email'), el('e2', 'button', 'Log in')],
  evidence: [],
};
const answer = (choice: string, confidence = 0.95, probabilities: Record<string, number> = { [choice]: confidence }) => ({
  type: 'choice', choice, confidence, probabilities,
});

function fakeClient(answers: Record<string, unknown>) {
  const requests: any[] = [];
  const client: JevClient = {
    systemOne: async (request) => {
      requests.push(request);
      return { answers };
    },
  };
  return { client, requests };
}

const input = (step: Step, client: JevClient, values: string[], snapshot = SNAP) => ({
  step, scenarioName: 'logging in', previousSteps: ['I am on "/login"'], snapshot, values, client, minConfidence: 0.6,
});
const when = (text: string): Step => ({ keyword: 'When', text });

describe('resolve: request shape', () => {
  it('sends one request with step, scenario, page, and id-keyed values as state', async () => {
    const { client, requests } = fakeClient({ kind: answer('click'), element: answer('e2') });
    await resolve(input(when('I fill in email with "a@b.c"'), client, ['a@b.c']));

    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe('jev-latest');
    expect(requests[0].state).toEqual({
      step: { keyword: 'When', text: 'I fill in email with "a@b.c"' },
      scenario: { name: 'logging in', previous_steps: ['I am on "/login"'] },
      page: {
        url: 'http://app/login',
        title: 'Login',
        elements: [{ id: 'e1', role: 'textbox', name: 'Email' }, { id: 'e2', role: 'button', name: 'Log in' }],
        text: 'Sign in',
      },
      values: { v1: 'a@b.c' },
    });
    const { questions } = requests[0];
    expect(Object.keys(questions).sort()).toEqual(
      ['after_typing', 'assertion', 'element', 'expected_text', 'input_text', 'key', 'kind', 'target_url'],
    );
    expect(Object.keys(questions.kind.criteria)).toEqual(
      ['navigate', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'assert', 'none'],
    );
    expect(Object.keys(questions.element.criteria)).toEqual(['e1', 'e2', 'none']);
    for (const id of ['target_url', 'input_text', 'expected_text']) {
      expect(Object.keys(questions[id].criteria), id).toEqual(['v1', 'none']);
    }
  });

  it('omits every question whose answer could not be acted on when there is nothing to choose from', async () => {
    const { client, requests } = fakeClient({ kind: answer('none') });
    await resolve(input(when('something'), client, [], { ...SNAP, elements: [] }));
    expect(Object.keys(requests[0].questions).sort()).toEqual(['key', 'kind']);
  });
});

describe('resolve: only feasible assertion forms are offered', () => {
  const forms = (request: any) => Object.keys(request.questions.assertion.criteria);

  it('offers every form when the step has literals and the page has elements', async () => {
    const { client, requests } = fakeClient({ kind: answer('none') });
    await resolve(input(when('x'), client, ['lit']));
    expect(forms(requests[0])).toEqual(
      ['text_visible', 'text_not_visible', 'element_visible', 'element_has_value', 'url_contains', 'semantic'],
    );
  });

  it('drops forms that need a literal when the step has none', async () => {
    const { client, requests } = fakeClient({ kind: answer('none') });
    await resolve(input(when('I see a list of bagels'), client, []));
    expect(forms(requests[0])).toEqual(['element_visible', 'semantic']);
  });

  it('drops forms that need an element when the page has none', async () => {
    const { client, requests } = fakeClient({ kind: answer('none') });
    await resolve(input(when('x'), client, ['lit'], { ...SNAP, elements: [] }));
    expect(forms(requests[0])).toEqual(['text_visible', 'text_not_visible', 'url_contains', 'semantic']);
  });

  it('resolves to semantic without asking when it is the only feasible form', async () => {
    const { client, requests } = fakeClient({ kind: answer('assert', 0.9) });
    const outcome = await resolve(input(when('the page looks calm'), client, [], { ...SNAP, elements: [] }));
    expect(requests[0].questions.assertion).toBeUndefined();
    expect(outcome).toEqual({ ok: true, resolved: { kind: 'assert', assertion: { form: 'semantic' } }, confidence: 0.9 });
  });
});

describe('resolve: typing that implies submitting', () => {
  const fillAnswers = { kind: answer('fill'), element: answer('e1'), input_text: answer('v1') };

  it('marks a fill as submit when the step implies pressing Enter afterwards', async () => {
    const { client } = fakeClient({ ...fillAnswers, after_typing: answer('submit', 0.8) });
    const outcome = await resolve(input(when('I search for "bagels"'), client, ['bagels']));
    expect(outcome).toEqual({
      ok: true,
      resolved: { kind: 'fill', locator: SNAP.elements[0].locator, value: 'bagels', submit: true },
      confidence: 0.8,
    });
  });

  it('leaves a plain fill unmarked, and does not consult after_typing for select', async () => {
    const stay = await resolve(input(when('x'), fakeClient({ ...fillAnswers, after_typing: answer('stay') }).client, ['a']));
    expect((stay as any).resolved).toEqual({ kind: 'fill', locator: SNAP.elements[0].locator, value: 'a' });

    const select = await resolve(
      input(when('x'), fakeClient({ ...fillAnswers, kind: answer('select'), after_typing: answer('submit', 0.1) }).client, ['a']),
    );
    expect(select).toMatchObject({ ok: true, resolved: { kind: 'select', value: 'a' }, confidence: 0.95 });
  });
});

describe('resolve: mapping answers to steps', () => {
  const cases: [string, Record<string, unknown>, string[], unknown][] = [
    ['navigate', { kind: answer('navigate'), target_url: answer('v1') }, ['/login'], { kind: 'navigate', value: '/login' }],
    ['click', { kind: answer('click'), element: answer('e2') }, [], { kind: 'click', locator: SNAP.elements[1].locator }],
    ['fill', { kind: answer('fill'), element: answer('e1'), input_text: answer('v2') }, ['Email', 'a@b.c'],
      { kind: 'fill', locator: SNAP.elements[0].locator, value: 'a@b.c' }],
    ['press with element', { kind: answer('press'), key: answer('Enter'), element: answer('e1') }, [],
      { kind: 'press', key: 'Enter', locator: SNAP.elements[0].locator }],
    ['press without element', { kind: answer('press'), key: answer('Escape'), element: answer('none') }, [],
      { kind: 'press', key: 'Escape' }],
    ['assert text', { kind: answer('assert'), assertion: answer('text_visible'), expected_text: answer('v1') }, ['Welcome'],
      { kind: 'assert', assertion: { form: 'text_visible', value: 'Welcome' } }],
    ['assert element value', { kind: answer('assert'), assertion: answer('element_has_value'), element: answer('e1'), expected_text: answer('v1') },
      ['a@b.c'], { kind: 'assert', assertion: { form: 'element_has_value', locator: SNAP.elements[0].locator, value: 'a@b.c' } }],
    ['assert semantic', { kind: answer('assert'), assertion: answer('semantic') }, [],
      { kind: 'assert', assertion: { form: 'semantic' } }],
  ];
  it.each(cases)('%s', async (_name, answers, values, expected) => {
    const outcome = await resolve(input(when('step'), fakeClient(answers).client, values));
    expect(outcome).toMatchObject({ ok: true, resolved: expected });
  });

  it('reports the minimum confidence across only the answers it consumed', async () => {
    const { client } = fakeClient({
      kind: answer('click', 0.9),
      element: answer('e2', 0.7),
      input_text: answer('v1', 0.1), // irrelevant to click: must be ignored
      target_url: answer('v1', 0.1),
      expected_text: answer('v1', 0.1),
      assertion: answer('semantic', 0.2),
      key: answer('none', 0.3),
    });
    const outcome = await resolve(input(when('I click Log in'), client, ['x']));
    expect(outcome).toEqual({ ok: true, resolved: { kind: 'click', locator: SNAP.elements[1].locator }, confidence: 0.7 });
  });
});

describe('resolve: refusing to guess', () => {
  it('is undefined when kind is none', async () => {
    const outcome = await resolve(input(when('the moon is full'), fakeClient({ kind: answer('none') }).client, []));
    expect(outcome).toMatchObject({ ok: false, reason: 'undefined' });
  });

  it('explains that values are never invented when an unresolvable step has no literals', async () => {
    const outcome = await resolve(input(when('I can search for his wife'), fakeClient({ kind: answer('none') }).client, []));
    expect(outcome).toMatchObject({ ok: false, reason: 'undefined' });
    expect((outcome as { detail: string }).detail).toMatch(/never invents/);
    expect((outcome as { detail: string }).detail).toMatch(/quotes/);
  });

  it('is undefined when a required element is none', async () => {
    const { client } = fakeClient({ kind: answer('click'), element: answer('none') });
    const outcome = await resolve(input(when('I click Sign up'), client, []));
    expect(outcome).toMatchObject({ ok: false, reason: 'undefined' });
    expect((outcome as { detail: string }).detail).toMatch(/element/i);
  });

  it('is undefined with a hint when navigate has no literal path', async () => {
    const { client } = fakeClient({ kind: answer('navigate') });
    const outcome = await resolve(input(when('I am on the login page'), client, []));
    expect(outcome).toMatchObject({ ok: false, reason: 'undefined' });
    expect((outcome as { detail: string }).detail).toContain('"/login"');
  });

  it('is ambiguous below the threshold, listing the top candidates readably', async () => {
    const { client } = fakeClient({
      kind: answer('click', 0.9),
      element: answer('e2', 0.4, { e1: 0.35, e2: 0.45, none: 0.2 }),
    });
    const outcome = await resolve(input(when('I click it'), client, []));
    expect(outcome).toMatchObject({ ok: false, reason: 'ambiguous' });
    const detail = (outcome as { detail: string }).detail;
    expect(detail).toContain('button "Log in" (45%)');
    expect(detail).toContain('textbox "Email" (35%)');
  });
});

describe('resolve: malformed responses', () => {
  it('throws when the kind answer is missing rather than reporting the step as undefined', async () => {
    const { client } = fakeClient({}); // no `kind` answer at all
    await expect(resolve(input(when('I click Go'), client, []))).rejects.toThrow(
      /Unexpected response from Jev: no answer for "kind"/,
    );
  });

  it('throws when the kind answer has no string choice', async () => {
    const { client } = fakeClient({ kind: { confidence: 0.9, probabilities: {} } });
    await expect(resolve(input(when('I click Go'), client, []))).rejects.toThrow(
      /Unexpected response from Jev: no answer for "kind"/,
    );
  });
});

describe('shortlist', () => {
  it('keeps everything at or under the cap, preserving order', () => {
    expect(shortlist(SNAP.elements, 'anything', 60)).toEqual(SNAP.elements);
  });

  it('keeps the elements with the most token overlap, in page order', () => {
    const many = Array.from({ length: 100 }, (_, i) => el(`e${i + 1}`, 'button', i === 80 ? 'Log in now' : `Filler ${i}`));
    const kept = shortlist(many, 'I click the Log in button', 10);
    expect(kept).toHaveLength(10);
    expect(kept.map((e) => e.id)).toContain('e81');
    expect(kept.map((e) => Number(e.id.slice(1)))).toEqual([...kept.map((e) => Number(e.id.slice(1)))].sort((a, b) => a - b));
  });
});

describe('judge', () => {
  const snap: Snapshot = { ...SNAP, evidence: ['Login - MyApp', 'Sign in', 'Forgot password?'] };
  const noul = (p: number) => ({ type: 'noul', noul: p });

  it('asks holds and evidence together over the step and page, and returns both', async () => {
    const { client, requests } = fakeClient({ holds: noul(0.93), evidence: answer('x2', 0.9) });
    expect(await judge(client, 'I see the login page', snap)).toEqual({ holds: 0.93, evidence: 'Sign in', evidenceConfidence: 0.9 });
    expect(requests[0].state).toEqual({
      expectation: 'I see the login page',
      page: { url: snap.url, title: snap.title, text: snap.text, evidence: [{ id: 'x1', text: 'Login - MyApp' }, { id: 'x2', text: 'Sign in' }, { id: 'x3', text: 'Forgot password?' }] },
    });
    expect(requests[0].questions.holds.type).toBe('noul');
    expect(Object.keys(requests[0].questions.evidence.criteria)).toEqual(['x1', 'x2', 'x3', 'none']);
  });

  it('returns no evidence when Jev picks none, and skips the question when the page has no evidence', async () => {
    const { client } = fakeClient({ holds: noul(0.9), evidence: answer('none', 0.8) });
    expect(await judge(client, 'x', snap)).toEqual({ holds: 0.9 });
    const bare = fakeClient({ holds: noul(0.5) });
    expect(await judge(bare.client, 'x', { ...snap, evidence: [] })).toEqual({ holds: 0.5 });
    expect(bare.requests[0].questions.evidence).toBeUndefined();
  });

  it('throws on a malformed response instead of silently coercing a bad value to a number', async () => {
    const { client } = fakeClient({ holds: { type: 'noul', noul: 'yes' } });
    await expect(judge(client, 'x', snap)).rejects.toThrow(/no answer for "holds"/);
  });
});

describe('resolve: page-sourced values', () => {
  const snap: Snapshot = { ...SNAP, evidence: ['Michelle Obama', 'Barack Obama'] };
  const fill = { kind: answer('fill'), element: answer('e1') };

  it('offers page text as input_text candidates after the literals', async () => {
    const { client, requests } = fakeClient({ ...fill, input_text: answer('p1', 0.9) });
    await resolve(input(when('I search for his wife'), client, [], snap));
    expect(Object.keys(requests[0].questions.input_text.criteria)).toEqual(['p1', 'p2', 'none']);
    expect(requests[0].state.page_text).toEqual({ p1: 'Michelle Obama', p2: 'Barack Obama' });
    const withLiteral = fakeClient({ ...fill, input_text: answer('v1') });
    await resolve(input(when('I search for "x"'), withLiteral.client, ['x'], snap));
    expect(Object.keys(withLiteral.requests[0].questions.input_text.criteria)).toEqual(['v1', 'p1', 'p2', 'none']);
  });

  it('fills with the chosen page text', async () => {
    const outcome = await resolve(input(when('I search for his wife'), fakeClient({ ...fill, input_text: answer('p1', 0.9) }).client, [], snap));
    expect(outcome).toMatchObject({ ok: true, resolved: { kind: 'fill', value: 'Michelle Obama' } });
  });

  it('holds page-sourced picks to a higher bar than literals', async () => {
    const outcome = await resolve(input(when('I search for his wife'), fakeClient({ ...fill, input_text: answer('p1', 0.7) }).client, [], snap));
    expect(outcome).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect((outcome as { detail: string }).detail).toContain('0.75');
    const literal = await resolve(input(when('I search for "x"'), fakeClient({ ...fill, input_text: answer('v1', 0.7) }).client, ['x'], snap));
    expect(literal).toMatchObject({ ok: true });
  });
});
