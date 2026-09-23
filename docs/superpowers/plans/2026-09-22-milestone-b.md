# Milestone B Implementation Plan — vocabulary and failure evidence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five new step kinds (hover, clear, upload, scroll, wait) plus select-by-index and fill-on-select; on any non-passing step, a screenshot and the snapshot Jev saw are written to a report directory (optionally with a Playwright trace) and the path is printed.

**Architecture:** New kinds are additive: a `KIND` option each, a `ResolvedStep` variant each, a resolver branch each, an executor case each. Evidence capture lives in `runAll`'s `onStep` hook (which becomes awaitable), using the last snapshot taken for that scenario; tracing is started per browser context when `--trace` is on.

**Tech Stack:** unchanged. **Spec:** `docs/superpowers/specs/2026-09-22-v0.2-milestones-design.md` (Milestone B).

## Global Constraints

- ESM `.js` imports; `src/resolver.ts` is the only SDK importer; no question asks Jev to generate text; every new Choice has a `none`/no-match path.
- `wait`: literal text → `expect(getByText(text).first()).toBeVisible({ timeout: 15000 })`; else a number literal `N` (≤ 30) → `waitForTimeout(N*1000)`; else `waitForLoadState('networkidle')`.
- `upload` path resolves relative to the feature file's directory (`ctx.featureDir`); `input[type=file]` collected with role `file`.
- Report dir default `jevcumber-report`; layout `<report>/<feature-basename>/<scenario-slug>/<index+1>-<status>/{screenshot.png,snapshot.json}`; `--no-report` disables; `--trace` keeps `trace.zip` in the scenario dir only when a step did not pass.
- Never touch `features/`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. `npm test && npm run typecheck` before each commit.

---

### Task 1: New step kinds

**Files:** Modify `src/types.ts`, `src/resolver.ts`, `src/executor.ts`, `src/snapshot.ts`; Test `test/resolver.test.ts`, `test/executor.test.ts`, `test/snapshot.test.ts`

**Interfaces produced:**
```ts
// types.ts — ResolvedStep gains:
  | { kind: 'hover' | 'clear' | 'scroll'; locator: LocatorSpec }
  | { kind: 'upload'; locator: LocatorSpec; value: string }
  | { kind: 'wait'; text?: string; seconds?: number }
// executor.ts
export interface ExecuteContext { baseUrl?: string; stepText: string; judge?: …; featureDir?: string }
export const WAIT_FOR_TEXT_TIMEOUT = 15_000; export const MAX_WAIT_SECONDS = 30;
```

- [ ] **Step 1: Failing tests.**
  `test/resolver.test.ts` — in the `'sends one request…'` test extend the expected `kind` criteria keys to `['navigate','click','fill','select','check','uncheck','press','hover','clear','upload','scroll','wait','assert','none']`. Add to the `it.each` mapping cases:
```ts
    ['hover', { kind: answer('hover'), element: answer('e2') }, [], { kind: 'hover', locator: SNAP.elements[1].locator }],
    ['clear', { kind: answer('clear'), element: answer('e1') }, [], { kind: 'clear', locator: SNAP.elements[0].locator }],
    ['scroll', { kind: answer('scroll'), element: answer('e2') }, [], { kind: 'scroll', locator: SNAP.elements[1].locator }],
    ['upload', { kind: answer('upload'), element: answer('e1'), input_text: answer('v1') }, ['photo.png'], { kind: 'upload', locator: SNAP.elements[0].locator, value: 'photo.png' }],
    ['wait for text', { kind: answer('wait'), expected_text: answer('v1') }, ['Done'], { kind: 'wait', text: 'Done' }],
    ['wait seconds', { kind: answer('wait'), expected_text: answer('none') }, ['3'], { kind: 'wait', seconds: 3 }],
    ['wait for network', { kind: answer('wait') }, [], { kind: 'wait' }],
```
  and a test: `'caps a numeric wait at 30 seconds'` — values `['90']`, expect `{ kind: 'wait', seconds: 30 }`.
  `test/executor.test.ts` — extend `HTML` with `<input type="file" aria-label="Photo"> <div id="far" style="margin-top:3000px">Far away</div> <button onmouseover="document.getElementById('out').textContent='Hovered'">Hover me</button>`; add:
```ts
  it('hovers, clears, scrolls, uploads, and waits', async () => {
    await execute(page, { kind: 'hover', locator: role('button', 'Hover me') }, ctx);
    expect(await page.locator('#out').textContent()).toBe('Hovered');

    await page.getByLabel('Email').fill('x');
    await execute(page, { kind: 'clear', locator: role('textbox', 'Email') }, ctx);
    expect(await page.getByLabel('Email').inputValue()).toBe('');

    await execute(page, { kind: 'scroll', locator: { by: 'text', value: 'Far away' } }, ctx);
    expect(await page.locator('#far').evaluate((el) => el.getBoundingClientRect().top < window.innerHeight)).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-upload-'));
    writeFileSync(join(dir, 'photo.png'), 'not really a png');
    await execute(page, { kind: 'upload', locator: { by: 'label', value: 'Photo' }, value: 'photo.png' }, { ...ctx, featureDir: dir });
    expect(await page.getByLabel('Photo').evaluate((el) => (el as HTMLInputElement).files?.[0]?.name)).toBe('photo.png');

    const started = Date.now();
    await execute(page, { kind: 'wait', seconds: 1 }, ctx);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    await execute(page, { kind: 'wait' }, ctx);
    setTimeout(() => page.evaluate(() => (document.getElementById('out')!.textContent = 'Later')), 300);
    await execute(page, { kind: 'wait', text: 'Later' }, ctx);
  });

  it('selects by index when no label or value matches, and treats fill on a <select> as select', async () => {
    await execute(page, { kind: 'select', locator: role('combobox', 'Country'), value: '2' }, ctx);
    expect(await page.getByRole('combobox').inputValue()).toBe('fr');
    await execute(page, { kind: 'fill', locator: role('combobox', 'Country'), value: 'UK' }, ctx);
    expect(await page.getByRole('combobox').inputValue()).toBe('UK');
  });
```
  (add `mkdtempSync, writeFileSync` / `tmpdir` / `join` imports). `actionLocators` test: add `expect(actionLocators({ kind: 'hover', locator: role('button','Go') })).toEqual([role('button','Go')])` and `expect(actionLocators({ kind: 'wait' })).toEqual([])`.
  `test/snapshot.test.ts` — add `<label>Photo <input type="file"></label>` to `HTML`; expect `byName['Photo']` to have `role: 'file'` and no `value`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
  - `src/snapshot.ts` `roleOf`: `if (type === 'file') return 'file';` before the `textbox` default; value capture: skip when `type === 'file'`.
  - `src/types.ts`: the variants above.
  - `src/resolver.ts` `KIND` additions (keep `assert`/`none` last):
```ts
  hover: 'Move the mouse over an element without clicking, e.g. to reveal a tooltip or menu.',
  clear: 'Empty an input field of whatever it contains.',
  upload: 'Attach a file to a file input; the step names the file, e.g. "I upload \"photo.png\"".',
  scroll: 'Scroll an element into view.',
  wait: 'Pause until something appears, until the page settles, or for a number of seconds, e.g. "I wait for \"Done\" to appear", "I wait 3 seconds", "I wait for the page to load".',
```
    Branches: `hover`/`clear`/`scroll` like `click` (element required); `upload` like `fill` but value from `pickValue('input_text')`, no `after_typing`; `wait`:
```ts
    case 'wait': {
      const seconds = values.map(Number).find((n) => Number.isFinite(n) && n > 0);
      if (seconds !== undefined) { resolved = { kind, seconds: Math.min(seconds, MAX_WAIT_SECONDS) }; break; }
      const text = values.length > 0 ? pickValue('expected_text') : undefined;
      resolved = text === undefined ? { kind } : { kind, text };
      break;
    }
```
    with `const MAX_WAIT_SECONDS = 30;` in the resolver (export it from executor and import type-free constant? — keep a local constant in each file; the executor also clamps).
  - `src/executor.ts`: `featureDir?: string` in the context; `actionLocators` returns `[]` for `wait` and the locator for the others (`'locator' in resolved`). Cases:
```ts
    case 'hover': await toLocator(page, resolved.locator).hover(); break;
    case 'clear': await toLocator(page, resolved.locator).fill(''); break;
    case 'scroll': await toLocator(page, resolved.locator).scrollIntoViewIfNeeded(); break;
    case 'upload': await toLocator(page, resolved.locator).setInputFiles(resolvePath(ctx.featureDir ?? process.cwd(), resolved.value)); break;
    case 'wait':
      if (resolved.text !== undefined) await expect(page.getByText(resolved.text).first()).toBeVisible({ timeout: WAIT_FOR_TEXT_TIMEOUT });
      else if (resolved.seconds !== undefined) await page.waitForTimeout(Math.min(resolved.seconds, MAX_WAIT_SECONDS) * 1000);
      else await page.waitForLoadState('networkidle', { timeout: WAIT_FOR_TEXT_TIMEOUT }).catch(() => {});
      break;
```
    `fill`: before filling, `const tag = await field.evaluate((el) => el.tagName);` → if `'SELECT'`, `await select(field, resolved.value)` instead. `select()` helper: after label and value attempts fail, if `/^\d+$/.test(value)` try `selectOption({ index: Number(value) })`; rethrow the label error if that fails too. Import `resolve as resolvePath` from `node:path`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `"Add hover, clear, upload, scroll, and wait steps; select by index"`

---

### Task 2: Failure evidence and traces

**Files:** Modify `src/types.ts`, `src/runner.ts`, `src/reporter.ts`, `src/cli.ts`; Create `src/evidence.ts`; Test `test/evidence.test.ts`, `test/runner.test.ts`, `test/reporter.test.ts`, `e2e/frozen.test.ts`

**Interfaces produced:**
```ts
// types.ts
export interface StepResult { step; status; detail?; note?; evidenceDir?: string }
// evidence.ts
export function scenarioDir(reportDir: string, scenario: Scenario): string   // <reportDir>/<feature basename without .feature>/<slug(name)>[-<occurrence+1>]
export function stepDir(reportDir: string, scenario: Scenario, index: number, status: StepStatus): string
export async function captureStep(page: Page, dir: string, snapshot: Snapshot | undefined): Promise<void> // writes screenshot.png (fullPage, best effort) + snapshot.json
// runner.ts
export interface RunOptions { …; reportDir?: string; trace: boolean }
// ScenarioDeps.onStep may return a Promise; runScenario awaits it
```

- [ ] **Step 1: Failing tests.**
  `test/evidence.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { scenarioDir, stepDir } from '../src/evidence.js';
const scenario = { uri: 'features/login.feature', feature: 'Login', name: 'Wrong password!', occurrence: 0, tags: [], steps: [] };
describe('evidence paths', () => {
  it('slugs the scenario name under the feature basename', () => {
    expect(scenarioDir('out', scenario)).toBe('out/login/wrong-password');
    expect(scenarioDir('out', { ...scenario, occurrence: 1 })).toBe('out/login/wrong-password-2');
  });
  it('numbers steps from 1 and appends the status', () => {
    expect(stepDir('out', scenario, 2, 'failed')).toBe('out/login/wrong-password/3-failed');
  });
});
```
  `test/runner.test.ts`: `'awaits an async onStep hook'` — `onStep: async (r) => { await new Promise((r) => setTimeout(r, 10)); seen.push(r.status); }` and assert order `['passed','passed','passed']` after `runScenario` resolves.
  `test/reporter.test.ts`: a result with `evidenceDir: 'jevcumber-report/a/b/1-failed'` prints the line `        evidence: jevcumber-report/a/b/1-failed` after the detail lines.
  `e2e/frozen.test.ts`: `'writes a screenshot and snapshot for a failed step'` — workspace with a failing assertion override, run `main([dir, '--base-url', server.url, '--frozen', '--report-dir', join(dir, 'report')])` → exit 1; `existsSync(join(dir, 'report', 'login', 'successful-login', '5-failed', 'screenshot.png'))` and `snapshot.json` parse to an object with `url` and `text`. Also `'--no-report writes nothing'` (report dir absent) and `'--trace keeps a trace for a failed scenario only'` (with `--trace`: `trace.zip` exists in the failed scenario's dir and not in a passing one's).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
  `src/evidence.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Scenario, Snapshot, StepStatus } from './types.js';

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';

export function scenarioDir(reportDir: string, scenario: Scenario): string {
  const feature = basename(scenario.uri).replace(/\.feature$/, '');
  const name = scenario.occurrence > 0 ? `${slug(scenario.name)}-${scenario.occurrence + 1}` : slug(scenario.name);
  return join(reportDir, feature, name);
}

export function stepDir(reportDir: string, scenario: Scenario, index: number, status: StepStatus): string {
  return join(scenarioDir(reportDir, scenario), `${index + 1}-${status}`);
}

/** What the failing step saw: a screenshot now, and the last snapshot Jev was shown (if any). */
export async function captureStep(page: Page, dir: string, snapshot: Snapshot | undefined): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: true }).catch(() => {});
  writeFileSync(join(dir, 'snapshot.json'), `${JSON.stringify(snapshot ?? { url: page.url() }, null, 2)}\n`);
}
```
  `src/runner.ts`: `onStep?(result: StepResult): void | Promise<void>` and `await deps.onStep?.(result)`. In `runAll`: `RunOptions` gains `reportDir?: string; trace: boolean`. Per scenario: `let lastSnapshot: Snapshot | undefined;` set inside the `resolve` wrapper (`const snap = await snapshot(...); lastSnapshot = snap;`). If `options.trace`: `await context.tracing.start({ screenshots: true, snapshots: true })` after creating the context. `onStep`: 
```ts
            onStep: async (result) => {
              const failing = result.status === 'failed' || result.status === 'ambiguous' || result.status === 'undefined';
              if (failing && options.reportDir) {
                const dir = stepDir(options.reportDir, scenario, scenario.steps.indexOf(result.step), result.status);
                await captureStep(page, dir, lastSnapshot);
                result.evidenceDir = dir;
              }
              options.reporter.step(result);
            },
```
  After `runScenario` returns, if tracing: `const passed = steps.every(s => s.status === 'passed' || s.status === 'healed'); await context.tracing.stop(passed ? {} : { path: join(scenarioDir(options.reportDir ?? 'jevcumber-report', scenario), 'trace.zip') });` (mkdir the scenario dir first; when `--no-report` and `--trace` are both given, traces go under `jevcumber-report` anyway — document).
  `src/reporter.ts` `step()`: after detail lines, `if (evidenceDir) write(\`        evidence: ${evidenceDir}\`)`.
  `src/cli.ts`: `.option('--report-dir <dir>', 'where screenshots and snapshots of failing steps are written', 'jevcumber-report')`, `.option('--no-report', 'do not write failure evidence')`, `.option('--trace', 'record a Playwright trace per scenario; kept for scenarios that did not pass', false)`; pass `reportDir: options.report === false ? undefined : options.reportDir, trace: options.trace`. Add `jevcumber-report` to `.gitignore`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `"Write screenshot and snapshot for failing steps; --trace"`

---

### Task 3: Fixtures, live tuning, docs (controller)

- [ ] Add to `fixtures/eval/live-only.feature` (Background logs in as dana; todos page has "New todo" field, "Add" button, "Sign out" link, h1 "Welcome, dana"):
```gherkin
  Scenario: new step kinds
    When I hover over the Sign out link
    And I clear the new todo field
    And I scroll to the Add button
    And I wait for "Welcome, dana" to appear
    And I wait 1 second
    And I wait for the page to settle
```
  expected: hover → `{kind:'hover', locator: {by:'role',role:'link',name:'Sign out'}}`; clear → `{kind:'clear', locator: newTodo}`; scroll → `{kind:'scroll', locator: add}`; wait text → `{kind:'wait', text:'Welcome, dana'}`; wait 1 → `{kind:'wait', seconds:1}`; settle → `{kind:'wait'}`. Upload has no fixture control; add `<label>Avatar <input type="file"></label>` to `fixtures/app/todos.html` and a step `And I upload "avatar.png" as the avatar` → `{kind:'upload', locator:{by:'label',value:'Avatar'}, value:'avatar.png'}` (the eval only compares resolutions; it does execute the expected step, so create `fixtures/eval/avatar.png` (any bytes) and pass `featureDir` in the eval's execute context).
- [ ] Run the live eval; tune `KIND` wording until all new steps resolve ≥ 0.6 without regressing existing ones. Then `zsh -ic 'npm test'`.
- [ ] Docs: README "What a step can do today" list + a "Failure evidence" paragraph (report dir layout, `--no-report`, `--trace`); CLI table rows; `site/index.html` CLI/limits copy; spec "Amendments" note for anything tuned.
- [ ] Commit `"Milestone B: new step kinds and failure evidence"`.
