# Milestone D Implementation Plan — tooling and docs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `jevcumber explain` describes every step's lockfile resolution without a browser or key; `--record-eval <dir>` saves exactly what Jev saw and answered per step; a generated cookbook page lists known-good step phrasings.

**Architecture:** `explain` is a second CLI subcommand (like `install-browser`) built on `loadFeatures` + `Lockfile.getEntry` + a pure `describeResolved()` formatter. Recording hooks into the resolver through an optional `onRequest` callback on `ResolveInput`/`judge()` so the SDK boundary is untouched. The cookbook is a script that reads the fixture/example features and `fixtures/expected.ts` and writes `site/cookbook.html` with the landing page's design tokens.

**Tech Stack:** unchanged. **Spec:** `docs/superpowers/specs/2026-09-22-v0.2-milestones-design.md` (Milestone D).

## Global Constraints

- ESM `.js` imports; `src/resolver.ts` remains the only SDK importer; `explain` never launches a browser or calls Jev.
- `explain` exit code: 1 if any step lacks a lockfile entry, else 0. Output: `Feature:`/`  Scenario:` headers then one line per step `    <mark> <keyword> <text>` + `        → <description> · confidence 0.97` where mark is `✓` (cached), `~` (live-judged: `semantic`), `✗` (not in lockfile).
- `--record-eval <dir>`: per Jev call, write `<dir>/<feature-basename>/<scenario-slug>/<index+1>[-judge].json` = `{ step, state, questions, answers, outcome }` (`outcome` = the `ResolveOutcome`, or the `Judgment` for judge calls). Never under `--frozen` (no calls happen).
- Cookbook: `npm run cookbook` writes `site/cookbook.html`; `deploy:site` runs it first; the landing page nav and README link to `/cookbook.html`.
- Never touch `features/`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. `npm test && npm run typecheck` before each commit.

---

### Task 1: `jevcumber explain`

**Files:** Create `src/explain.ts`; Modify `src/cli.ts`; Test `test/explain.test.ts`, `e2e/frozen.test.ts`

**Interfaces:**
```ts
// explain.ts
export function describeResolved(resolved: ResolvedStep): string
// e.g. navigate → `open "/login"`; click → `click button "Log in"`; fill (+submit) → `type "bagel" into searchbox "Search Wikipedia" then press Enter`;
//      select → `choose "France" in combobox "Country"`; check/uncheck/hover/clear/scroll → `<verb> <role> "<name>"`; press → `press Enter (in textbox "Search")`;
//      upload → `upload "avatar.png" to <locator>`; wait → `wait for "Done"` | `wait 3 s` | `wait for the page to settle`;
//      assert forms → `expect text "Welcome" visible` / `expect text "Error" absent` / `expect URL to contain "/todos"` / `expect title to contain "Bagel - Wikipedia"` / `expect heading "Bagel" visible` / `expect <role> "<name>" visible` / `expect <role> "<name>" to have value "x"` / `judged live by Jev each run`;
//      a `pinned: true` assertion appends ` (pinned)`.
// locator text: testid → `[data-testid=x]`; role → `<role> "<name>"`; label → `field labelled "x"`; placeholder → `field with placeholder "x"`; text → `element with text "x"`.
export function explain(paths: string[], tags: string | undefined, write: (line: string) => void): 0 | 1
```

- [ ] **Step 1: Failing tests.** `test/explain.test.ts`: table-driven `describeResolved` cases covering every kind and assertion form above (exact strings); an `explain()` test that writes a temp feature + lockfile (use `parseFeature`/`stepKey`/`Lockfile` as e2e does) with one cached step (confidence 0.97), one `semantic` step, and one missing step → asserts the three lines and `→` descriptions, and return value 1; with all steps cached → 0. `e2e/frozen.test.ts`: `main(['explain', dir])` → 0 for the full workspace, and the output includes `open "/login"`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `src/explain.ts` with the two functions; `explain()` uses `loadFeatures`, `Lockfile.load(lockPathFor(uri))`, `stepKey`, `getEntry` (no `touch` side effects matter — nothing is saved). `src/cli.ts`: `if (argv[0] === 'explain') { … parse `<paths...>` and `--tags` with a small sub-Command; return explain(...) }`. Add `explain` to the help text.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `"Add jevcumber explain"`

---

### Task 2: `--record-eval`

**Files:** Modify `src/resolver.ts`, `src/runner.ts`, `src/cli.ts`; Create `src/recorder.ts`; Test `test/resolver.test.ts`, `test/recorder.test.ts`, `e2e/frozen.test.ts` (flag parsing only)

**Interfaces:**
```ts
// resolver.ts
export interface JevExchange { state: unknown; questions: Record<string, unknown>; answers: Record<string, unknown> }
ResolveInput.onRequest?: (exchange: JevExchange) => void
judge(client, stepText, snapshot, onRequest?: (exchange: JevExchange) => void)
// recorder.ts
export function recordEval(dir: string, scenario: Scenario, index: number, kind: 'resolve' | 'judge', data: { step: Step; exchange: JevExchange; outcome: unknown }): void
// RunOptions.recordEval?: string
```

- [ ] **Step 1: Failing tests.** `test/resolver.test.ts`: `onRequest` receives `{ state, questions, answers }` for `resolve()` and for `judge()`. `test/recorder.test.ts`: writes `<dir>/login/wrong-password/3.json` and `3-judge.json` with the expected keys; directory created. `e2e/frozen.test.ts`: `--record-eval` accepted with `--frozen` and writes nothing (dir absent).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per the interfaces; runner wires `onRequest` in its `resolve` wrapper (and in the judge call) to `recordEval(options.recordEval, scenario, index, …)` when set — the resolve wrapper needs the step index: it already gets `step`; use `scenario.steps.indexOf(step)` there (objects are distinct per pickle) or thread the index through `ScenarioDeps.resolve(step, previousSteps, index)`. cli: `--record-eval <dir>`. README: a short paragraph under Development → "Tuning the questions" explaining the files and how to turn one into an eval fixture (copy the step into a fixture feature + expected.ts).
- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `"Add --record-eval"`

---

### Task 3: Cookbook

**Files:** Create `scripts/cookbook.ts`, Modify `package.json`, `site/index.html` (nav + footer link), `README.md`; Test `test/cookbook.test.ts`

**Interfaces:** `scripts/cookbook.ts` exports `buildCookbook(): string` (HTML) and, when run directly, writes `site/cookbook.html`. Data: every step in `fixtures/features/*.feature`, `fixtures/eval/*.feature`, `examples/*.feature` that has an entry in `RESOLVED` (from `fixtures/expected.ts`), plus `examples/*.lock.json` entries; grouped by `resolved.kind` (assert grouped by form), each row: the step text (as `<code>`) and `describeResolved(resolved)`. Deduplicate by step text.

- [ ] **Step 1: Failing test.** `test/cookbook.test.ts`: `buildCookbook()` contains `<title>jevcumber cookbook`, a section heading for `fill`, the row for `I search for "bagel"` with `then press Enter`, a section for `wait`, and no duplicate rows.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Reuse the landing page's `:root` tokens (paper/ink/pickle/mustard, Bagel Fat One / Hanken Grotesk / Martian Mono via the same Google Fonts link), a nav back to `/`, one `<section>` per kind with an `<h2>` and a table (Step | What jevcumber does). `package.json`: `"cookbook": "tsx scripts/cookbook.ts"`, `"deploy:site": "npm run cookbook && wrangler deploy"`. `site/index.html` nav: `<li><a href="/cookbook.html">Cookbook</a></li>`; README: link in "Writing steps Jev can resolve".
- [ ] **Step 4: Run** `npm run cookbook && npm test && npm run typecheck` — PASS; commit `site/cookbook.html` too.
- [ ] **Step 5: Commit** `"Add the cookbook page"`

---

### Task 4 (controller): release prep
- [ ] Live suite; regenerate `examples/` lockfile if resolver state changed; `explain examples/` output sanity; version stays 0.2.0; recreate the `v0.2.0` tag at the final commit; site deploy; README/site final pass; npm publish handed to Michael.
