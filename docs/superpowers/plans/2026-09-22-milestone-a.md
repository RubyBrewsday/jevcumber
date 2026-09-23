# Milestone A Implementation Plan — everything deterministic in CI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Described `Then` steps get pinned to concrete page evidence so they replay under `--frozen`; fill/click steps can select values and targets described by the step from page text; lockfile v2 records confidence.

**Architecture:** `snapshot` collects an `evidence` list (title, headings, link/button names) in the same in-page pass. `judge()` in the resolver asks Jev two questions at once — does the page satisfy the expectation, and which evidence item shows it. The executor returns a `pinned` assertion when a semantic check passes with evidence; the runner writes it to the lockfile and re-judges a failing pinned assertion before failing it. The `input_text` question is offered page text candidates with a stricter confidence bar.

**Tech Stack:** unchanged (TypeScript ESM, @playwright/test, @typesafe-ai/sdk 0.6, vitest).

**Spec:** `docs/superpowers/specs/2026-09-22-v0.2-milestones-design.md` (Milestone A) on top of `docs/superpowers/specs/2026-09-18-jevcumber-design.md`.

## Global Constraints

- Node ≥ 20; ESM; relative imports end in `.js`; `src/resolver.ts` is the only module importing `@typesafe-ai/sdk`.
- Semantic pass threshold 0.8. Pinning needs evidence confidence ≥ 0.6. Page-sourced (`p…`) picks need confidence ≥ 0.75. Default `--min-confidence` 0.6.
- Evidence list: title, `h1`–`h3`, link and button names; deduplicated; each trimmed to 80 chars; ≤ 40 items ranked by `mostRelevant` against the step.
- Lockfile `"version": 2`; v1 loads and is rewritten as v2 on save; other versions error. Entries: `{ text, resolved, confidence? }`.
- Never call Jev under `--frozen`; a failing pinned assertion under `--frozen` is a plain failure.
- Never modify `features/` (user's scratch). Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run `npm test` and `npm run typecheck` before each commit. Live tests skip without `TYPESAFE_API_KEY`; the controller runs them separately via `zsh -ic`.

## File Structure

```
src/types.ts      Assertion.pinned, Snapshot.evidence, StepResult.note, ExecuteResult
src/lockfile.ts   v2 + confidence
src/snapshot.ts   evidence collection
src/resolver.ts   judge() (replaces semanticCheck), page_text candidates, element instructions
src/executor.ts   ctx.judge, returns { pinned? }
src/runner.ts     pin on pass, re-judge healing, note
src/reporter.ts   "(pinned to …)"
fixtures/…        new eval scenarios; examples/ gains a pinned expectation
```

---

### Task 1: Types and lockfile v2

**Files:** Modify `src/types.ts`, `src/lockfile.ts`; Test `test/lockfile.test.ts`

**Interfaces produced:**
```ts
// types.ts additions
export type Assertion =
  | { form: 'text_visible' | 'text_not_visible' | 'url_contains'; value: string; pinned?: true }
  | { form: 'element_visible'; locator: LocatorSpec }
  | { form: 'element_has_value'; locator: LocatorSpec; value: string }
  | { form: 'semantic' };
export interface Snapshot { url: string; title: string; elements: ElementInfo[]; text: string; evidence: string[] }
export interface StepResult { step: Step; status: StepStatus; detail?: string; note?: string }
export interface ExecuteResult { pinned?: Assertion }
// lockfile.ts
set(key: string, text: string, resolved: ResolvedStep, confidence?: number): void
getEntry(key: string): { resolved: ResolvedStep; confidence?: number } | undefined   // touches like get()
```

- [ ] **Step 1: Failing tests** — append to `test/lockfile.test.ts` inside `describe('Lockfile')`:
```ts
  it('writes version 2 and keeps confidence', () => {
    const path = tmp();
    const lock = Lockfile.load(path);
    lock.set('a', 'first', { kind: 'navigate', value: '/a' }, 0.93);
    lock.save(false);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(data.version).toBe(2);
    expect(data.steps.a.confidence).toBe(0.93);
    expect(Lockfile.load(path).getEntry('a')).toEqual({ resolved: { kind: 'navigate', value: '/a' }, confidence: 0.93 });
  });

  it('loads a version 1 lockfile and rewrites it as version 2', () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ version: 1, steps: { a: { text: 't', resolved: { kind: 'navigate', value: '/a' } } } }));
    const lock = Lockfile.load(path);
    expect(lock.get('a')).toEqual({ kind: 'navigate', value: '/a' });
    lock.save(false);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(2);
  });
```
  and change the existing `'rejects an unknown lockfile version'` test to write `version: 99` (already does) — keep. Update the existing `'round-trips entries…'` assertion `expect(JSON.parse(raw).version).toBe(1)` → `toBe(2)`.
- [ ] **Step 2: Run** `npx vitest run test/lockfile.test.ts` — expect the two new tests and the version assertion to FAIL.
- [ ] **Step 3: Implement.** In `src/types.ts` apply the interfaces above (add `pinned?: true` to the text/url assertion variant; add `evidence: string[]` to `Snapshot`; add `note?: string` to `StepResult`; add `export interface ExecuteResult { pinned?: Assertion }`). In `src/lockfile.ts`:
```ts
const VERSION = 2;
const READABLE_VERSIONS = new Set([1, 2]);

interface LockEntry {
  text: string;
  resolved: ResolvedStep;
  confidence?: number;
}
```
  `load`: `if (!READABLE_VERSIONS.has(data.version)) throw …(expected ${VERSION})`; when `data.version !== VERSION` construct with `dirty = true` (add an optional constructor param `dirty = false`, or set `lock.dirty = true` after construction — make `dirty` `private` but settable inside the class via a static). `set(key, text, resolved, confidence?)` stores `{ text, resolved, ...(confidence === undefined ? {} : { confidence }) }`. Add `getEntry(key)` that touches and returns `{ resolved, confidence }` (omit `confidence` when undefined) or `undefined`.
- [ ] **Step 4: Run** `npx vitest run test/lockfile.test.ts && npm run typecheck` — PASS (snapshot.test/fixtures may now fail typecheck on `Snapshot.evidence`: fix by adding `evidence: []` to `SNAP` in `test/resolver.test.ts` and any other Snapshot literal — `grep -rn "elements:" test e2e | grep -v "\.elements"`).
- [ ] **Step 5: Commit** `git add src test && git commit -m "Lockfile v2 with confidence; types for pinning"`

---

### Task 2: Snapshot evidence

**Files:** Modify `src/snapshot.ts`; Test `test/snapshot.test.ts`

**Interfaces:** `collect()` returns `{ title, text, elements, headings: string[] }`; `snapshot()` returns `evidence: string[]` always (also with `elements: false`).

- [ ] **Step 1: Failing tests** — append to `test/snapshot.test.ts` top-level `describe('snapshot')`:
```ts
  it('collects evidence: title, headings, link and button names, deduplicated and trimmed', async () => {
    const p = await browser.newPage();
    await p.setContent(`<title>Bagel - Wikipedia</title><h1>Bagel</h1><h2>History</h2><h4>ignored</h4>
      <a href="/a">Bagel</a> <a href="/b">${'x'.repeat(100)}</a> <button>Search</button>`);
    const { evidence } = await snapshot(p, { elements: false });
    expect(evidence).toEqual(['Bagel - Wikipedia', 'Bagel', 'History', 'x'.repeat(80), 'Search']);
    await p.close();
  });

  it('caps evidence at 40 items ranked by relevance to the step', async () => {
    const p = await browser.newPage();
    const links = Array.from({ length: 100 }, (_, i) => `<a href="/${i}">Topic ${i}</a>`).join('');
    await p.setContent(`<title>T</title><h1>Michelle Obama</h1>${links}`);
    const { evidence } = await snapshot(p, { relevantTo: 'Then I see an article about Michelle Obama' });
    expect(evidence.length).toBeLessThanOrEqual(40);
    expect(evidence).toContain('Michelle Obama');
    await p.close();
  });
```
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In `collect()`, before the final `return`, add:
```ts
  const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map((h) => clean((h as HTMLElement).innerText)).filter(Boolean);
```
  and return `{ title: document.title, text: clean(content?.innerText), elements, headings }`. Add module-level:
```ts
const MAX_EVIDENCE = 40;
const MAX_EVIDENCE_LENGTH = 80;

// Things a described expectation could be pinned to: what the page says it is about.
function evidenceOf(raw: { title: string; headings: string[]; elements: RawElement[] }, relevantTo: string): string[] {
  const items = [
    raw.title,
    ...raw.headings,
    ...raw.elements.filter((e) => e.role === 'link' || e.role === 'button').map((e) => e.name),
  ]
    .map((s) => s.trim().slice(0, MAX_EVIDENCE_LENGTH))
    .filter(Boolean);
  return mostRelevant([...new Set(items)], relevantTo, (s) => s, MAX_EVIDENCE);
}
```
  In `snapshotOnce`, compute `const evidence = evidenceOf(raw, options.relevantTo ?? '');` and include it in both return statements.
- [ ] **Step 4: Run** `npx vitest run test/snapshot.test.ts && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `"Collect page evidence in snapshots"`

---

### Task 3: Resolver — judge() and page-sourced candidates

**Files:** Modify `src/resolver.ts`; Test `test/resolver.test.ts`

**Interfaces produced:**
```ts
export interface Judgment { holds: number; evidence?: string; evidenceConfidence?: number }
export function judge(client: JevClient, stepText: string, snapshot: Snapshot): Promise<Judgment>
export const PAGE_SOURCED_MIN_CONFIDENCE = 0.75;
// semanticCheck is removed (judge replaces it)
```

- [ ] **Step 1: Failing tests.** In `test/resolver.test.ts`: change the import to `{ judge, resolve, shortlist, type JevClient }`; add `evidence: []` to `SNAP` if not already. Replace the `describe('semanticCheck')` block with:
```ts
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
```
  Also update the existing `'omits every question…'` test (expects `['key','kind']` when no elements/values): keep, since with no elements the `input_text` question is not asked — **rule: page_text candidates are offered only when the page has elements** (nothing to fill otherwise). And in `'sends one request…'`, the `input_text` criteria for `SNAP` (evidence `[]`) stays `['v1','none']`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
  - Add `export const PAGE_SOURCED_MIN_CONFIDENCE = 0.75;` and `export interface Judgment { holds: number; evidence?: string; evidenceConfidence?: number }`.
  - State gains `page_text: pageTextById` where `pageTextById = Object.fromEntries(snapshot.evidence.map((t, i) => [`p${i + 1}`, t]))`.
  - Value questions: build `literalOptions` as today; for `input_text` **only**, when `elements.length > 0`, options are `{ ...literalOptions, ...Object.fromEntries(Object.entries(pageTextById).map(([id, t]) => [id, { page_text: t }])), none }`; the `input_text` question is asked when `values.length > 0 || (elements.length > 0 && snapshot.evidence.length > 0)`. Update the `input_text` instructions: `'Assume the Gherkin step in \`step.text\` asks for text to be typed into a field, or an option to be chosen. Which entry is the text to type or the option to choose? Literals from the step are in \`values\`; \`page_text\` holds things the page says, for when the step describes the text (e.g. "his wife") rather than quoting it. A literal that only names the field is not it.'` and its `none`: `'Neither the literals nor the page text give what to type; the literals only name the field.'`. The `target_url` and `expected_text` questions are unchanged (literal options only, asked when `values.length > 0`).
  - `pickValue(question)` resolves `v…` from `valueById` and `p…` from `pageTextById`. Record page-sourced picks: keep a `let pageSourced = false`; set it when a `p…` id is consumed.
  - Element question instructions: `'Which element of \`page.elements\` is the Gherkin step in \`step.text\` acting on or checking? The step may name the element as a user would (by its role and name), or describe it (e.g. "the link to his wife"): use \`page.text\` to work out which element that is.'`
  - Confidence gate: `const bar = pageSourced ? Math.max(minConfidence, PAGE_SOURCED_MIN_CONFIDENCE) : minConfidence;` use `bar` in the comparison and in the detail text (`… (${conf} < ${bar})`). `describe()` also maps `p…` labels to their page text in quotes.
  - Replace `semanticCheck` with:
```ts
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
      'Assume the web page in `page` satisfies `expectation`. Which single item of `page.evidence` — a title, heading, or link on the page — best shows that it does? Prefer the item that names what the expectation is about.',
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
  return item ? { holds: holds.noul, evidence: item.text, evidenceConfidence: picked!.confidence } : { holds: holds.noul };
}
```
- [ ] **Step 4: Run** `npx vitest run test/resolver.test.ts && npm run typecheck` — PASS (runner.ts / e2e still import `semanticCheck`: typecheck fails there until Task 4/5 — acceptable only if `npx vitest run test/resolver.test.ts` passes; fix imports in `src/runner.ts` and `e2e/resolve-eval.test.ts` minimally now by importing `judge` and using `(await judge(...)).holds` so typecheck is clean).
- [ ] **Step 5: Commit** `"Resolver: judge() with evidence; page-sourced fill values"`

---

### Task 4: Executor — judge and pin

**Files:** Modify `src/executor.ts`; Test `test/executor.test.ts`

**Interfaces:** `ExecuteContext.judge?: (stepText: string) => Promise<Judgment>` (replaces `semantic`); `execute(): Promise<ExecuteResult>`; `export const PIN_MIN_CONFIDENCE = 0.6`.

- [ ] **Step 1: Failing tests.** In `test/executor.test.ts` replace the semantic test with:
```ts
  it('judges described expectations against the 0.8 threshold and pins them to evidence', async () => {
    const semantic = { kind: 'assert', assertion: { form: 'semantic' } } as const;
    const pinned = await execute(page, semantic, { ...ctx, judge: async () => ({ holds: 0.9, evidence: 'Email', evidenceConfidence: 0.8 }) });
    expect(pinned).toEqual({ pinned: { form: 'text_visible', value: 'Email', pinned: true } });
    expect(await execute(page, semantic, { ...ctx, judge: async () => ({ holds: 0.9 }) })).toEqual({});
    expect(await execute(page, semantic, { ...ctx, judge: async () => ({ holds: 0.9, evidence: 'Email', evidenceConfidence: 0.5 }) })).toEqual({});
    await expect(execute(page, semantic, { ...ctx, judge: async () => ({ holds: 0.5 }) })).rejects.toThrow(/0\.50/);
    await expect(execute(page, semantic, ctx)).rejects.toThrow(/--frozen/);
  });

  it('does not pin evidence that is not actually visible on the page', async () => {
    const semantic = { kind: 'assert', assertion: { form: 'semantic' } } as const;
    expect(await execute(page, semantic, { ...ctx, judge: async () => ({ holds: 0.9, evidence: 'Secret', evidenceConfidence: 0.9 }) })).toEqual({});
  });

  it('replays a pinned assertion as a plain text check', async () => {
    await execute(page, { kind: 'assert', assertion: { form: 'text_visible', value: 'Email', pinned: true } }, ctx);
  });
```
  and update all other `execute(...)` calls' expectations if they assert a `void` return (they don't — `await execute(...)` is fine).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `import type { Judgment } from './resolver.js'` (type-only import keeps the SDK boundary). Replace `semantic?` with `judge?: (stepText: string) => Promise<Judgment>`. `check()` returns `Promise<ExecuteResult>`; the `semantic` case:
```ts
    case 'semantic': {
      if (!ctx.judge) throw new Error('This step is a descriptive expectation that only Jev can judge, so it cannot run with --frozen.');
      const judgment = await ctx.judge(ctx.stepText);
      if (judgment.holds < SEMANTIC_THRESHOLD) {
        throw new Error(`Jev judged the expectation unmet (p=${judgment.holds.toFixed(2)}, needs ≥ ${SEMANTIC_THRESHOLD}).`);
      }
      // Pin to concrete evidence so later runs can replay this step without Jev — but only if that
      // evidence is really visible, or the pinned check would fail on the very next run.
      if (judgment.evidence && (judgment.evidenceConfidence ?? 0) >= PIN_MIN_CONFIDENCE) {
        const visible = await page.getByText(judgment.evidence, { exact: true }).first().isVisible().catch(() => false);
        if (visible) return { pinned: { form: 'text_visible', value: judgment.evidence, pinned: true } };
      }
      return {};
    }
```
  Other assertion cases `await` their expect and `return {}`. `execute()` returns `{}` after actions and the `check()` result for asserts. `text_visible` for a pinned value uses `getByText(value, { exact: true })` (pinned evidence is an exact string); non-pinned keeps substring matching as today.
- [ ] **Step 4: Run** `npx vitest run test/executor.test.ts && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `"Executor: judge described expectations and pin their evidence"`

---

### Task 5: Runner, reporter, wiring

**Files:** Modify `src/runner.ts`, `src/reporter.ts`, `e2e/resolve-eval.test.ts`; Test `test/runner.test.ts`, `test/reporter.test.ts`

**Interfaces:** `ScenarioDeps.execute(resolved, step): Promise<ExecuteResult | void>`; `ScenarioDeps.lock.set(...)` called with confidence.

- [ ] **Step 1: Failing tests.** `test/runner.test.ts` — the harness `execute` returns `undefined` today (fine). Add:
```ts
  it('pins a described expectation: writes the pinned assertion to the lockfile and notes it', async () => {
    const semantic: ResolvedStep = { kind: 'assert', assertion: { form: 'semantic' } };
    const pinned = { form: 'text_visible', value: 'Michelle Obama', pinned: true } as const;
    const { deps, lock } = harness({
      resolve: async () => ({ ok: true, resolved: semantic, confidence: 0.9 }),
      execute: async (r) => (r.kind === 'assert' && r.assertion.form === 'semantic' ? { pinned } : undefined),
    });
    const results = await runScenario(scenario, deps);
    expect(results[0]).toEqual({ step: scenario.steps[0], status: 'passed', note: 'pinned to "Michelle Obama"' });
    expect(lock.get(stepKey(scenario, 0))).toEqual({ kind: 'assert', assertion: pinned });
  });

  it('re-judges a failing pinned assertion and heals it when the expectation still holds', async () => {
    const stale: ResolvedStep = { kind: 'assert', assertion: { form: 'text_visible', value: 'Old heading', pinned: true } };
    const fresh = { form: 'text_visible', value: 'New heading', pinned: true } as const;
    const { deps, lock, calls } = harness(
      {
        execute: async (r) => {
          if (r.kind === 'assert' && r.assertion.form === 'text_visible' && r.assertion.value === 'Old heading') throw new Error('not visible');
          if (r.kind === 'assert' && r.assertion.form === 'semantic') return { pinned: fresh };
          return undefined;
        },
      },
      { 0: stale },
    );
    const results = await runScenario(scenario, deps);
    expect(results[0]).toMatchObject({ status: 'healed', note: 'pinned to "New heading"' });
    expect(calls.resolve).toEqual(['two', 'three']);
    expect(lock.get(stepKey(scenario, 0))).toEqual({ kind: 'assert', assertion: fresh });
  });

  it('fails a pinned assertion outright under --frozen', async () => {
    const stale: ResolvedStep = { kind: 'assert', assertion: { form: 'text_visible', value: 'Old', pinned: true } };
    const { deps, calls } = harness({ mode: 'frozen', execute: async () => { throw new Error('not visible'); } }, { 0: stale });
    const results = await runScenario(scenario, deps);
    expect(results[0]).toMatchObject({ status: 'failed', detail: 'not visible' });
    expect(calls.execute).toHaveLength(1);
  });

  it('records the resolution confidence in the lockfile', async () => {
    const { deps, lock } = harness();
    await runScenario(scenario, deps);
    expect(lock.getEntry(stepKey(scenario, 0))?.confidence).toBe(0.9);
  });
```
  `test/reporter.test.ts`: add a step result with `note: 'pinned to "X"'` and expect the line `    ✓ When step 0 (pinned to "X")`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In `runScenario`: `deps.lock.set(key, step.text, resolved, outcome.confidence)`. Wrap execution:
```ts
    let note: string | undefined;
    try {
      const result = await deps.execute(resolved, step);
      if (result?.pinned) {
        deps.lock.set(key, step.text, { kind: 'assert', assertion: result.pinned });
        note = `pinned to ${JSON.stringify(result.pinned.value)}`;
      }
    } catch (error) {
      const wasPinned = resolved.kind === 'assert' && 'pinned' in resolved.assertion && resolved.assertion.pinned;
      if (!wasPinned || deps.mode === 'frozen') return { step, status: 'failed', detail: message(error) };
      // The evidence this step was pinned to has gone. Ask Jev whether the expectation still holds
      // before failing: a heading rewrite should heal, a real regression should fail.
      try {
        const rejudged = await deps.execute({ kind: 'assert', assertion: { form: 'semantic' } }, step);
        if (rejudged?.pinned) {
          deps.lock.set(key, step.text, { kind: 'assert', assertion: rejudged.pinned });
          note = `pinned to ${JSON.stringify(rejudged.pinned.value)}`;
        } else {
          deps.lock.set(key, step.text, { kind: 'assert', assertion: { form: 'semantic' } });
        }
        healed = true;
      } catch (again) {
        return { step, status: 'failed', detail: message(again) };
      }
    }
    const result: StepResult = { step, status: healed ? 'healed' : 'passed' };
    if (note) result.note = note;
    return result;
```
  In `runAll`: `judge: frozen ? undefined : async (text) => judge(getClient(), text, await snapshot(page, { elements: false, relevantTo: text }))`. `src/reporter.ts` `step()`: after the healed/ambiguous suffix, append `` note ? ` (${note})` : '' `` (healed + note → `(healed — lockfile updated) (pinned to "…")` is acceptable). `e2e/resolve-eval.test.ts`: use `judge` the same way.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS (live tests skip).
- [ ] **Step 5: Commit** `"Runner: pin described expectations, re-judge stale pins"`

---

### Task 6: Fixtures, live tuning, docs, release prep (controller runs the live parts)

**Files:** Modify `fixtures/eval/live-only.feature`, `fixtures/expected.ts`, `e2e/resolve-eval.test.ts`, `e2e/frozen.test.ts`, `examples/wikipedia.feature`, `examples/wikipedia.feature.lock.json`, `README.md`, `site/index.html`, `docs/superpowers/specs/2026-09-18-jevcumber-design.md`, `package.json`

- [ ] **Step 1:** Add to `fixtures/eval/live-only.feature`:
```gherkin
  Scenario: a described expectation that can be pinned
    Then I see the todo list for dana

  Scenario: a value described rather than quoted
    When I fill in the new todo field with the name of the logged-in user
    And I click "Add"
    Then I should see "dana"
```
  (The todos page shows `Welcome, dana` as its h1; the fixture app's todos page must render the user name in an `h1` — it already does: `Welcome, <user>`.) In `fixtures/expected.ts` add: `'I see the todo list for dana': { kind: 'assert', assertion: { form: 'semantic' } }`, `'I fill in the new todo field with the name of the logged-in user': { kind: 'fill', locator: newTodo, value: 'Welcome, dana' }` — **note:** the value Jev picks from page text will be `Welcome, dana` (the h1) — if the live eval shows Jev picks that, keep; the point of the fixture is a page-sourced pick with confidence ≥ 0.75. Adjust `Then I should see "dana"` accordingly (substring match).
- [ ] **Step 2:** In `e2e/resolve-eval.test.ts`, after executing a semantic assertion, also assert that `judge()` returned evidence with confidence ≥ 0.6 for the scenarios named "…pinned" and print `evidence=<text> (<conf>)` lines. Add `e2e/frozen.test.ts` case: a lockfile entry `{ kind: 'assert', assertion: { form: 'text_visible', value: 'Welcome, alice', pinned: true } }` replays under `--frozen` and passes.
- [ ] **Step 3 (controller, needs key):** `zsh -ic 'npx vitest run e2e/resolve-eval.test.ts --silent=false --reporter=verbose'`; tune `judge()` evidence wording and the `input_text`/`element` instructions until: pinned scenario evidence conf ≥ 0.8; page-sourced fill conf ≥ 0.8; all previous steps still `ok`. Then `zsh -ic 'npm test'` (all live).
- [ ] **Step 4:** Re-record `examples/wikipedia.feature`: change the last two steps to `Then I see an article about bagels` and `And the URL should contain "/wiki/Bagel"`; run `zsh -ic 'node dist/cli.js examples --update'`; confirm the lockfile entry is `pinned: true` with value `Bagel`; run `env -u TYPESAFE_API_KEY node dist/cli.js examples --frozen` → passes.
- [ ] **Step 5:** Docs. README "Two kinds of Then" → explain pinning: a described expectation is judged by Jev on the first run and pinned to the page evidence that shows it (a title or heading), then replays without the API; only expectations with no single piece of evidence stay live. Add a "Describing values" bullet: `When I search for his wife` picks from headings/links on the page; needs higher confidence. `site/index.html`: update the "Pickled for later" and "Two kinds of Then" copy the same way. v0.1 spec: note `semantic` → `judge`/pinning and lockfile v2 (pointer to the v0.2 spec). `package.json` version → `0.2.0`.
- [ ] **Step 6:** `npm test && npm run typecheck && npm run build`; commit `"Milestone A: pinned expectations, page-sourced values, lockfile v2 (0.2.0)"`.
