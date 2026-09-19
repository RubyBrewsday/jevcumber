import { describe, expect, it } from 'vitest';
import { resolve, semanticCheck, shortlist, type JevClient } from '../src/resolver.js';
import type { ElementInfo, Snapshot, Step } from '../src/types.js';

const el = (id: string, role: string, name: string): ElementInfo => ({
  id, role, name, locator: { by: 'role', role, name },
});
const SNAP: Snapshot = {
  url: 'http://app/login',
  title: 'Login',
  text: 'Sign in',
  elements: [el('e1', 'textbox', 'Email'), el('e2', 'button', 'Log in')],
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
    expect(Object.keys(questions).sort()).toEqual(['assertion', 'element', 'key', 'kind', 'value']);
    expect(Object.keys(questions.kind.criteria)).toEqual(
      ['navigate', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'assert', 'none'],
    );
    expect(Object.keys(questions.element.criteria)).toEqual(['e1', 'e2', 'none']);
    expect(Object.keys(questions.value.criteria)).toEqual(['v1', 'none']);
  });

  it('omits the element and value questions when there is nothing to choose from', async () => {
    const { client, requests } = fakeClient({ kind: answer('none') });
    await resolve(input(when('something'), client, [], { ...SNAP, elements: [] }));
    expect(Object.keys(requests[0].questions).sort()).toEqual(['assertion', 'key', 'kind']);
  });
});

describe('resolve: mapping answers to steps', () => {
  const cases: [string, Record<string, unknown>, string[], unknown][] = [
    ['navigate', { kind: answer('navigate'), value: answer('v1') }, ['/login'], { kind: 'navigate', value: '/login' }],
    ['click', { kind: answer('click'), element: answer('e2') }, [], { kind: 'click', locator: SNAP.elements[1].locator }],
    ['fill', { kind: answer('fill'), element: answer('e1'), value: answer('v2') }, ['Email', 'a@b.c'],
      { kind: 'fill', locator: SNAP.elements[0].locator, value: 'a@b.c' }],
    ['press with element', { kind: answer('press'), key: answer('Enter'), element: answer('e1') }, [],
      { kind: 'press', key: 'Enter', locator: SNAP.elements[0].locator }],
    ['press without element', { kind: answer('press'), key: answer('Escape'), element: answer('none') }, [],
      { kind: 'press', key: 'Escape' }],
    ['assert text', { kind: answer('assert'), assertion: answer('text_visible'), value: answer('v1') }, ['Welcome'],
      { kind: 'assert', assertion: { form: 'text_visible', value: 'Welcome' } }],
    ['assert element value', { kind: answer('assert'), assertion: answer('element_has_value'), element: answer('e1'), value: answer('v1') },
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
      value: answer('v1', 0.1), // irrelevant to click: must be ignored
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

describe('semanticCheck', () => {
  it('asks one noul over the step and page text and returns its probability', async () => {
    const { client, requests } = fakeClient({ holds: { type: 'noul', noul: 0.93 } });
    expect(await semanticCheck(client, 'I see a friendly error', SNAP)).toBe(0.93);
    expect(requests[0].state).toEqual({ expectation: 'I see a friendly error', page: { url: SNAP.url, title: SNAP.title, text: SNAP.text } });
    expect(requests[0].questions.holds.type).toBe('noul');
  });
});
