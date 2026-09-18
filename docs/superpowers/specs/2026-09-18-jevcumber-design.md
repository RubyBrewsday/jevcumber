# jevcumber — design

**Date:** 2026-09-18
**Status:** approved

## Purpose

jevcumber runs Cucumber `.feature` files against a web UI with no step
definitions. Each Gherkin step is interpreted at runtime by Jev (TypeSafe AI's
System One model) and executed with Playwright. Resolved steps are cached in a
committed lockfile so repeat runs are deterministic, fast, and need no API key.

## Core constraint: select, don't generate

Jev returns typed judgments (Choice, Noul, Score), not text or code. jevcumber
therefore never asks Jev to produce a selector or a value. Code enumerates the
candidates — interactive elements on the page, literal values in the step — and
Jev selects among them. Code executes the selection.

## Decisions

| Decision | Choice |
| --- | --- |
| Test target | Web UI via Playwright |
| Run model | Resolve once, cache in a lockfile, self-heal on miss |
| Form factor | Standalone TypeScript CLI (Node 20+) |
| Step resolution | Single-shot speculative fan-out: one Jev request per step |

## Pipeline

```
.feature → gherkin.ts (parse, expand Background + Scenario Outline)
        → per scenario: fresh Playwright browser context
        → per step: lockfile hit? → replay
                    else snapshot → candidates → resolver (Jev) → lockfile write
        → executor (Playwright action or assertion)
        → reporter
```

## Units

One file each under `src/`. Each has one purpose and is testable alone.

### `gherkin.ts`
`loadFeatures(paths, tagExpr?) → Scenario[]`. Uses `@cucumber/gherkin` to parse
and compile pickles, so Backgrounds are prepended and Scenario Outlines are
expanded. Filters by `@cucumber/tag-expressions`.

```ts
type Step = { keyword: 'Given'|'When'|'Then'; text: string; table?: string[][]; docString?: string };
type Scenario = { uri: string; feature: string; name: string; tags: string[]; steps: Step[] };
```
`And`/`But` are normalized to the preceding primary keyword.

### `snapshot.ts`
`snapshot(page) → Snapshot`.

```ts
type ElementInfo = { id: string; role: string; name: string; value?: string; locator: LocatorSpec };
type LocatorSpec =
  | { by: 'testid'; value: string }
  | { by: 'role'; role: string; name: string }
  | { by: 'label'; value: string }
  | { by: 'placeholder'; value: string }
  | { by: 'text'; value: string };
type Snapshot = { url: string; title: string; elements: ElementInfo[]; text: string };
```
Collects visible interactive elements (links, buttons, inputs, selects,
textareas, checkboxes, radios, `[role]` widgets). Locator preference: test id →
role+name → label → placeholder → text. Elements whose locator is not unique on
the page get no entry rather than an ambiguous one. `text` is the page's visible
text, truncated to 8 000 characters.

### `candidates.ts`
`extractValues(step) → string[]`. Literal values in order of appearance:
double- and single-quoted strings, URLs and `/paths`, numbers, data-table cells,
the docstring. Deduplicated.

### `resolver.ts`
The only module that imports `@typesafe-ai/sdk`.
`resolve(step, scenarioContext, snapshot, values, client) → ResolvedStep`.

One `client.systemOne` request, model `jev-latest`. State:

```json
{ "step": {"keyword": "...", "text": "..."},
  "scenario": {"name": "...", "previous_steps": ["..."]},
  "page": {"url": "...", "title": "...", "elements": [{"id":"e1","role":"button","name":"Log in"}], "text": "..."},
  "values": {"v1": "alice@example.com"} }
```

Questions, all asked together; code consumes only those relevant to `kind`:

| id | primitive | options |
| --- | --- | --- |
| `kind` | Choice | `navigate`, `click`, `fill`, `select`, `check`, `uncheck`, `press`, `assert`, `none` |
| `element` | Choice | each element id, plus `none` |
| `value` | Choice | each value id, plus `none` (omitted when there are no values) |
| `assertion` | Choice | `text_visible`, `text_not_visible`, `element_visible`, `element_has_value`, `url_contains`, `semantic` |
| `key` | Choice | `Enter`, `Tab`, `Escape`, `Space`, `Backspace`, `Delete`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `none` |

The `element` and `value` questions are omitted when the page has no
interactive elements or the step has no literals; both then count as `none`.

Relevance: `navigate` uses value; `click`/`check`/`uncheck` use element;
`fill`/`select` use element + value; `press` uses key and, when one is chosen,
element; `assert` uses assertion plus whichever of element/value that assertion
form needs.

When the page has more than 60 elements, code shortlists the 60 with the
highest token overlap against the step text before building the `element`
Choice.

```ts
type ResolvedStep =
  | { kind: 'navigate'; value: string }
  | { kind: 'click'|'check'|'uncheck'; locator: LocatorSpec }
  | { kind: 'fill'|'select'; locator: LocatorSpec; value: string }
  | { kind: 'press'; key: string; locator?: LocatorSpec }
  | { kind: 'assert'; assertion: Assertion }
type Assertion =
  | { form: 'text_visible'|'text_not_visible'|'url_contains'; value: string }
  | { form: 'element_visible'; locator: LocatorSpec }
  | { form: 'element_has_value'; locator: LocatorSpec; value: string }
  | { form: 'semantic' };
```

Outcome is `{ ok: true, resolved, confidence }` or
`{ ok: false, reason: 'undefined' | 'ambiguous', detail }`.

**Confidence** is the minimum confidence across the answers actually consumed
(the least certain judgment). Below `--min-confidence` (default 0.6) the step is
**ambiguous**; the detail lists the top three candidates with probabilities.
`kind = none`, or a required element/value answered `none`, is **undefined**.
jevcumber never acts on a guess.

### `executor.ts`
`execute(page, resolved, ctx) → void` (throws on failure). Maps `LocatorSpec` to
Playwright locators and `ResolvedStep` to actions; `navigate` resolves relative
paths against `--base-url`. Deterministic assertions use Playwright `expect`
with its default auto-wait. `semantic` takes a fresh snapshot and asks Jev one
Noul — "Does the page satisfy this expectation?" with the step text and page
text as state — passing at ≥ 0.8. After each action the executor waits for
network-idle-or-500 ms so the next snapshot sees the settled page.

### `lockfile.ts`
`<feature>.lock.json` beside each feature file, committed to git.

```json
{ "version": 1,
  "steps": { "<sha256(scenario name + step index + step text + table)>": { "text": "...", "resolved": { } } } }
```
Entries not touched during a full run of that feature are pruned. Output is
key-sorted for stable diffs.

### `runner.ts`
Per step: lockfile hit → validate → replay. Validation applies to action steps
only: each locator must attach within 2 s and match exactly one element.
Cached assertions are never pre-validated — Playwright's auto-waiting `expect`
is the judge, so a stale assertion fails rather than heals (`--update` fixes
it). Skipped steps still mark their lockfile entries as in use so a failing run
does not prune them. On miss or failed validation → resolve with Jev,
write the entry, and mark the step **healed** if an entry existed. Modes:

- default: resolve on miss, heal on stale
- `--frozen`: never call Jev; a miss or stale entry fails the step. `semantic`
  assertions fail with a message explaining they need the API.
- `--update`: ignore the lockfile and re-resolve everything

Step statuses: `passed`, `healed`, `failed`, `ambiguous`, `undefined`,
`skipped`. After any non-passing, non-healed step the rest of the scenario is
skipped. Scenarios run sequentially.

### `cli.ts`
```
jevcumber <paths…> --base-url <url>
          [--frozen | --update] [--headed] [--min-confidence <n>] [--tags <expr>]
```
Console reporter: one line per step with status, a failure block with the
error or ambiguity detail, and a summary. Exit 1 if any step is failed,
ambiguous, or undefined. `TYPESAFE_API_KEY` is required only when a step
actually needs Jev; its absence is reported on that step.

## Error handling

- API errors: the SDK retries 429/529; anything else fails the step with the
  API message.
- Playwright action errors fail the step with Playwright's message.
- A feature file that does not parse aborts the run with the parser error.

## Testing

- **Unit (vitest):** `gherkin`, `candidates`, `lockfile`; `resolver` against a
  fake client asserting the state and questions it builds and how answers map
  to `ResolvedStep`, including undefined and ambiguous outcomes; `runner` mode
  logic against fake resolver/executor.
- **E2E:** a static fixture app (login form, todo list) served locally; feature
  files run in `--frozen` mode against a recorded lockfile, so CI needs no key.
- **Live smoke:** the same features with `--update`, run only when
  `TYPESAFE_API_KEY` is set.

## Dependencies

`@playwright/test` (for `chromium` and standalone `expect`), `@cucumber/gherkin`, `@cucumber/messages`,
`@cucumber/tag-expressions`, `@typesafe-ai/sdk`, `commander`; dev: `typescript`,
`vitest`, `tsx`.

## Out of scope (v1)

Parallel scenarios, hooks, non-web drivers, HTML/JSON reports, iframes, file
uploads, drag and drop, multi-tab flows.
