# Milestone C Implementation Plan — speed and project ergonomics

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scenarios run in parallel workers with buffered, readable console output; snapshots cost one round-trip per candidate; a `jevcumber.config.js` supplies defaults and `beforeScenario`/`afterScenario` hooks; `--reporter json|junit` write machine-readable results.

**Architecture:** `runAll` becomes a work queue drained by N workers, each with its own browser context, all sharing one Chromium and the in-memory lockfiles. Reporters become event sinks: the console reporter buffers per scenario and prints a block on `scenarioEnd`, with a TTY status line on stderr; JSON/JUnit reporters collect and write on `end`. Uniqueness of testid/label/placeholder/text/role+name locators is computed inside `collect()`; only the first in-page-unique spec is verified with a single Playwright `count()`. Config is loaded by walking up from cwd; CLI flags override.

**Tech Stack:** unchanged. **Spec:** `docs/superpowers/specs/2026-09-22-v0.2-milestones-design.md` (Milestone C).

## Global Constraints

- ESM `.js` imports; `src/resolver.ts` remains the only SDK importer; `collect()` in snapshot.ts stays self-contained.
- Parallel by default: `--workers N`, default `min(os.availableParallelism(), scenarios.length)`; `--headed` forces 1. Lockfiles: one in-memory object per feature shared by workers; saved once at the end as today (in `finally`).
- Console under parallelism: each scenario's lines are buffered and printed as one block when it finishes; the `Feature:` header is printed once, when its first scenario completes; with stdout a TTY, a single status line `X/N scenarios · R running · F failed` is redrawn on stderr and cleared before each block and at the end; non-TTY gets blocks only; `--workers 1` output is identical to v0.1.
- Snapshot: ≤ 1 Playwright round-trip per candidate.
- Config file: `jevcumber.config.js`/`.mjs` found walking up from cwd; `--config <path>` overrides; keys `baseUrl, workers, tags, minConfidence, reportDir, hooks.beforeScenario({ page, scenario, baseUrl }), hooks.afterScenario({ page, scenario, results })`; CLI flags override config; a hook error fails the scenario (all steps `skipped` plus a synthetic `failed` line `beforeScenario hook: <message>`).
- Reporters: `--reporter <name>` repeatable (`console` default), `--output <file>` for the file reporters (defaults `jevcumber-report/results.json` / `results.xml`); JSON = Cucumber classic JSON formatter shape; JUnit one `<testsuite>` per feature, one `<testcase>` per scenario; status mapping passed/healed→passed, ambiguous/undefined→undefined, failed→failed, skipped→skipped; `StepResult.durationMs` recorded.
- Never touch `features/`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. `npm test && npm run typecheck` before each commit.

---

### Task 1: One-round-trip snapshots

**Files:** Modify `src/snapshot.ts`; Test `test/snapshot.test.ts`

**Interfaces:** `RawElement` gains `unique: { testid?: boolean; role?: boolean; label?: boolean; placeholder?: boolean; text?: boolean }` computed in-page; `specsFor(raw)` (no `repeated` param) returns only specs whose in-page uniqueness is true, in preference order; `snapshotOnce` verifies only `specsFor(raw)[0]` with one `count()` and falls back to the next spec only if that count is not 1 (rare: our in-page role/name computation disagrees with Playwright's).

- [ ] **Step 1: Failing tests.** In `test/snapshot.test.ts` add:
```ts
  it('verifies at most one locator per element with Playwright', async () => {
    const p = await browser.newPage();
    await p.setContent(HTML);
    let counts = 0;
    const proxied = new Proxy(p, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        if (['getByRole', 'getByLabel', 'getByTestId', 'getByPlaceholder', 'getByText'].includes(String(prop))) {
          return (...args: unknown[]) => {
            const locator = (value as Function).apply(target, args);
            return new Proxy(locator, { get(t, k, r) { const v = Reflect.get(t, k, r); if (k === 'count') return async () => { counts++; return v.call(t); }; return typeof v === 'function' ? v.bind(t) : v; } });
          };
        }
        return value.bind(target);
      },
    });
    const snap = await snapshot(proxied as unknown as Page);
    expect(counts).toBeLessThanOrEqual(snap.elements.length + 2);
    await p.close();
  });
```
  (Keep every existing snapshot test — they define the observable behaviour that must not change: locator preference, password fallback to label, omission of non-unique elements, the big-page bound.)
- [ ] **Step 2: Run** — FAIL (today up to five counts per element).
- [ ] **Step 3: Implement.** Inside `collect()`: after building `elements`, compute occurrence maps over ALL matched elements (before the visibility filter is fine, but uniqueness must reflect what Playwright will count — Playwright's `getBy*` ignore visibility, so count over all elements matching `SELECTOR` plus, for `text`, count `document.body.innerText` occurrences is wrong; instead count elements whose computed `text` equals the value, and for label/placeholder/testid count attribute matches across `document.querySelectorAll('[data-testid]')`, `[placeholder]`, and labelled controls). Concretely maintain `Map<string, number>` for keys `testid:<v>`, `label:<v>`, `placeholder:<v>`, `text:<v>`, `role:<role>:<name>` incremented for every element in the full `querySelectorAll(SELECTOR)` list (visible or not), then set `unique` on each pushed element as `count === 1` for each key present. Remove `repeatedKeys`/`roleKey`/`textKey`. `specsFor(raw)` returns specs in preference order filtered by `raw.unique.*`; password rule and `role !== 'file'` rule unchanged. `snapshotOnce`: for each candidate, `for (const spec of specsFor(element)) { if ((await toLocator(page, spec).count()) === 1) return { element, spec }; }` stays as the loop shape, but because non-unique specs are pre-filtered, the first almost always succeeds.
- [ ] **Step 4: Run** `npx vitest run test/snapshot.test.ts && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `"Compute locator uniqueness in-page; one round-trip per candidate"`

---

### Task 2: Reporter events, durations, JSON and JUnit reporters

**Files:** Modify `src/types.ts`, `src/runner.ts` (Reporter interface + durations only), `src/reporter.ts`; Create `src/reporters/json.ts`, `src/reporters/junit.ts`, `src/reporters/index.ts`; Test `test/reporter.test.ts`, `test/reporters.test.ts`

**Interfaces:**
```ts
// types.ts
export interface StepResult { step; status; detail?; note?; evidenceDir?; durationMs: number }
// runner.ts (Reporter moves to src/reporters/index.ts and is re-exported from runner.ts for compatibility)
export interface Reporter {
  scenarioStart(scenario: Scenario): void;
  step(scenario: Scenario, result: StepResult): void;   // scenario now passed (parallel-safe)
  scenarioEnd(result: ScenarioResult): void;
  end(results: ScenarioResult[]): void;
}
// reporters/index.ts
export type ReporterName = 'console' | 'json' | 'junit';
export function createReporters(names: ReporterName[], options: { output?: string; reportDir: string; isTTY: boolean; write?: (line: string) => void; writeStatus?: (line: string) => void }): Reporter
export function combine(reporters: Reporter[]): Reporter
// reporters/json.ts
export function jsonReporter(outputPath: string): Reporter   // Cucumber classic JSON
export function toCucumberJson(results: ScenarioResult[]): unknown
// reporters/junit.ts
export function junitReporter(outputPath: string): Reporter
export function toJunitXml(results: ScenarioResult[]): string
```

- [ ] **Step 1: Failing tests.** `test/reporters.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { toCucumberJson } from '../src/reporters/json.js';
import { toJunitXml } from '../src/reporters/junit.js';
import type { ScenarioResult } from '../src/types.js';

const results: ScenarioResult[] = [
  { scenario: { uri: 'features/login.feature', feature: 'Login', name: 'ok', occurrence: 0, tags: ['@smoke'], steps: [] },
    steps: [{ step: { keyword: 'Given', text: 'I am on "/login"' }, status: 'passed', durationMs: 12 }, { step: { keyword: 'Then', text: 'x' }, status: 'healed', durationMs: 3, note: 'pinned to "X"' }] },
  { scenario: { uri: 'features/login.feature', feature: 'Login', name: 'bad', occurrence: 0, tags: [], steps: [] },
    steps: [{ step: { keyword: 'When', text: 'I click it' }, status: 'ambiguous', durationMs: 40, detail: 'which one?' }, { step: { keyword: 'Then', text: 'y' }, status: 'skipped', durationMs: 0 }] },
  { scenario: { uri: 'features/todo.feature', feature: 'Todo', name: 'boom', occurrence: 0, tags: [], steps: [] },
    steps: [{ step: { keyword: 'Then', text: 'z' }, status: 'failed', durationMs: 5000, detail: 'not visible <b>' }] },
];

describe('cucumber json', () => {
  it('groups scenarios by feature with cucumber statuses and nanosecond durations', () => {
    const json = toCucumberJson(results) as any[];
    expect(json.map((f) => f.uri)).toEqual(['features/login.feature', 'features/todo.feature']);
    expect(json[0].name).toBe('Login');
    expect(json[0].elements.map((e: any) => e.name)).toEqual(['ok', 'bad']);
    const [ok, bad] = json[0].elements;
    expect(ok.tags).toEqual([{ name: '@smoke' }]);
    expect(ok.steps[0]).toEqual({ keyword: 'Given ', name: 'I am on "/login"', result: { status: 'passed', duration: 12_000_000 } });
    expect(ok.steps[1].result.status).toBe('passed');
    expect(bad.steps[0].result).toEqual({ status: 'undefined', duration: 40_000_000, error_message: 'which one?' });
    expect(bad.steps[1].result.status).toBe('skipped');
    expect(json[1].elements[0].steps[0].result.status).toBe('failed');
  });
});

describe('junit xml', () => {
  it('has a testsuite per feature and a testcase per scenario, failures with the failing step', () => {
    const xml = toJunitXml(results);
    expect(xml).toContain('<testsuite name="Login" tests="2" failures="1"');
    expect(xml).toContain('<testsuite name="Todo" tests="1" failures="1"');
    expect(xml).toContain('<testcase name="ok" classname="Login" time="0.015"');
    expect(xml).toMatch(/<testcase name="bad" classname="Login"[^>]*>\s*<failure message="When I click it: which one\?"/);
    expect(xml).toContain('&lt;b&gt;'); // escaped
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});
```
  `test/reporter.test.ts`: adapt to the new `step(scenario, result)` signature; add `durationMs: 0` to fabricated results; add a test that with `isTTY: false` nothing is written via `writeStatus`, and with `isTTY: true` the status line is written as `1/2 scenarios · 1 running · 0 failed` after the first scenario ends (drive `scenarioStart` twice then `scenarioEnd` once).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
  - `types.ts`: `durationMs: number` on `StepResult`. `runner.ts` `runScenario`: time each `runStep` (`performance.now()`), set `durationMs` on every result (including skipped = 0). Update the runner tests' `toEqual` on StepResult objects to use `toMatchObject` or include `durationMs: expect.any(Number)`.
  - `src/reporters/index.ts`: the `Reporter` interface (above), `combine()` (fan-out), `createReporters()` (console → `consoleReporter({ write, writeStatus, isTTY })` from `../reporter.js`; json → `jsonReporter(output ?? join(reportDir, 'results.json'))`; junit → `junitReporter(output ?? join(reportDir, 'results.xml'))`; unknown name → throw `Unknown reporter "<name>"`). `runner.ts`: `export type { Reporter } from './reporters/index.js'`.
  - `src/reporter.ts` `consoleReporter(options)`: buffer lines per scenario key (`scenario.uri + occurrence + name`); `scenarioStart` records the start; `step(scenario, result)` appends to that buffer; `scenarioEnd` prints (feature header once per feature, then `  Scenario:` line, buffered step lines, trace line), then redraws status; status line via `writeStatus` only when `isTTY`: `\r\x1b[K${done}/${total} scenarios · ${running} running · ${failed} failed` — `total` becomes known via a new optional `start(scenarios: Scenario[])` on the Reporter interface (add it: `start?(scenarios: Scenario[]): void`); `end` clears the status (`\r\x1b[K`) then prints the summary as today. `--workers 1` must produce byte-identical output to today (blocks print in order, no status line when not TTY).
  - `src/reporters/json.ts`: build the classic shape: `{ uri, id: slug(feature), keyword: 'Feature', name, elements: [{ id, keyword: 'Scenario', name, type: 'scenario', tags: [{ name }], steps: [{ keyword: `${keyword} `, name: text, result: { status, duration: ms*1e6, error_message? } }] }] }`; `jsonReporter(path)` collects on `end`, `mkdirSync(dirname(path))`, writes pretty JSON.
  - `src/reporters/junit.ts`: `<testsuites>` → `<testsuite name=feature tests=N failures=F skipped=S time=…>` → `<testcase name classname time>`; non-passing scenario: `<failure message="<keyword> <text>: <detail|status>">` with escaped text content = all step lines; `skipped`-only? (a scenario whose first step is ambiguous/undefined counts as failure). Escape `& < > " '`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `"Reporter events with durations; json and junit reporters"`

---

### Task 3: Parallel workers, config file, hooks, CLI

**Files:** Modify `src/runner.ts`, `src/cli.ts`, `src/reporter.ts` (if needed); Create `src/config.ts`; Test `test/config.test.ts`, `test/runner.test.ts`, `e2e/frozen.test.ts`

**Interfaces:**
```ts
// config.ts
export interface HookContext { page: Page; scenario: Scenario; baseUrl?: string }
export interface Config {
  baseUrl?: string; workers?: number; tags?: string; minConfidence?: number; reportDir?: string;
  hooks?: { beforeScenario?(ctx: HookContext): Promise<void> | void; afterScenario?(ctx: HookContext & { results: StepResult[] }): Promise<void> | void };
}
export function findConfigFile(from: string): string | undefined   // walks up for jevcumber.config.js|mjs
export async function loadConfig(path: string | undefined): Promise<Config>   // import(pathToFileURL); default export or module itself; validates types, throws on unknown keys
// runner.ts
export interface RunOptions { …; workers: number; hooks?: Config['hooks'] }
```

- [ ] **Step 1: Failing tests.**
  `test/config.test.ts`: writes a temp dir tree `a/b/` with `a/jevcumber.config.mjs` exporting `{ baseUrl: 'http://x', workers: 2 }`; `findConfigFile(join(dir,'a','b'))` → the file; `findConfigFile(tmpdir root without one)` → undefined; `loadConfig(file)` → the object; a config with an unknown key `foo` → throws `/unknown config key "foo"/`; `workers: 'two'` → throws `/workers/`.
  `test/runner.test.ts`: `runScenario` gains optional `deps.before?()`/`deps.after?(results)`: a `before` that throws → results are one synthetic `{ step: { keyword: 'Given', text: 'beforeScenario hook' }, status: 'failed', detail: 'beforeScenario hook: boom' }` followed by every real step `skipped`, and `resolve` is never called; `after` is awaited after the last step and receives the results.
  `e2e/frozen.test.ts`: (a) `'runs scenarios in parallel workers and prints one block per scenario'` — run `workspace()` with `--workers 2` capturing stdout via a `write` injected… `main()` uses `console.log`; capture with `vi.spyOn(console, 'log')` and assert each `  Scenario:` line is immediately followed by its own `✓/✗` lines (no interleaving: for each scenario block, the step texts match that scenario's steps in order) and exit 0. (b) `'reads defaults and hooks from jevcumber.config.mjs'` — write a config in the workspace dir with `baseUrl: server.url` and a `beforeScenario` hook that sets `page.setDefaultTimeout(5000)` and appends the scenario name to a file; run `main([dir, '--frozen'])` from that cwd (`process.chdir` in the test with restore) → exit 0 and the file lists all three scenario names. (c) `'--reporter json and junit write files'` — `main([dir, '--base-url', url, '--frozen', '--reporter', 'json', '--reporter', 'junit', '--report-dir', join(dir,'r')])` → `r/results.json` parses with 1 feature, `r/results.xml` contains `<testsuite name="Login"`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
  - `src/config.ts` as specified (`pathToFileURL` + dynamic `import()`; accept `export default {...}` or named exports; validation of key names and primitive types).
  - `runner.ts` `runScenario`: `before?(): Promise<void> | void; after?(results: StepResult[]): Promise<void> | void` on `ScenarioDeps`; hook failure → synthetic failed result + all steps skipped (still `touch` their lockfile keys); `after` in `finally`-style after the loop (its error → append a synthetic failed `afterScenario hook` result).
  - `runAll`: `reporter.start?.(scenarios)`; `const workers = options.headed ? 1 : Math.max(1, Math.min(options.workers, scenarios.length))`; a shared `let next = 0` index and `await Promise.all(Array.from({ length: workers }, worker))` where `worker` loops `while (next < scenarios.length) { const scenario = scenarios[next++]; await runOne(scenario); }` and `runOne` is the current per-scenario body (context, tracing, `runScenario`, evidence, `scenarioEnd`) with `before: () => hooks?.beforeScenario?.({ page, scenario, baseUrl })`, `after: (results) => hooks?.afterScenario?.({ page, scenario, baseUrl, results })`. `results` are pushed in completion order but the final `results` array is re-sorted to scenario order before `end()`. Error in one worker: catch per scenario → a synthetic failed result `{ step: { keyword: 'Given', text: scenario.name }, status: 'failed', detail }`, continue; lockfile `finally` unchanged.
  - `cli.ts`: `--workers <n>` (int ≥ 1, default from config or `os.availableParallelism()`), `--config <path>`, `--reporter <name>` (repeatable, `collect`), `--output <file>`; load config first (`findConfigFile(process.cwd())` unless `--config`), then merge: CLI value if the user passed it (`program.getOptionValueSource(name) === 'cli'`) else config else default. Build reporters via `createReporters(names, { output, reportDir, isTTY: process.stdout.isTTY === true, writeStatus: (s) => process.stderr.write(s) })`.
  - README/site: `--workers`, `--config`, `--reporter`, `--output`; config file example; hooks; note "parallel by default; `--workers 1` for serial; `--headed` implies 1".
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build` — PASS.
- [ ] **Step 5: Commit** `"Parallel workers, config file with hooks, reporter selection"`

---

### Task 4 (controller): live check and docs

- [ ] `zsh -ic 'npm test'` (live). Run `examples/` with `--workers 2 --update` and `--frozen`; time the fixture e2e before/after parallelism.
- [ ] Spec amendments for anything that changed; commit `"Milestone C: parallel runs, config and hooks, reporters"`.
