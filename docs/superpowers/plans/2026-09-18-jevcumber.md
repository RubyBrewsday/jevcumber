# jevcumber Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript CLI that runs Cucumber `.feature` files against a web UI with no step definitions, using Jev to resolve each step to a Playwright action and caching resolutions in a lockfile.

**Architecture:** Gherkin pickles → per step, either replay a cached `ResolvedStep` from `<feature>.lock.json` or snapshot the page, enumerate candidates in code, and have Jev *select* among them in one `systemOne` request → execute with Playwright. Jev never generates text; code enumerates, Jev chooses, code executes.

**Tech Stack:** Node ≥ 20, TypeScript (ESM, NodeNext), `@playwright/test` (chromium + standalone `expect`), `@cucumber/gherkin` 42, `@cucumber/messages` 34, `@cucumber/tag-expressions` 11, `@typesafe-ai/sdk` 0.6, `commander`, `vitest`, `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-18-jevcumber-design.md`

## Global Constraints

- Node ≥ 20; package is ESM (`"type": "module"`); relative imports end in `.js`.
- `src/resolver.ts` is the only module that imports `@typesafe-ai/sdk`.
- Jev model: `jev-latest`. Default `--min-confidence` 0.6. Semantic assertion passes at Noul ≥ 0.8.
- Element shortlist cap: 60. Page text cap: 8 000 characters.
- Lockfile: `<feature path>.lock.json`, `{"version": 1, "steps": {...}}`, keys sorted, 2-space JSON, trailing newline.
- Step statuses: `passed`, `healed`, `failed`, `ambiguous`, `undefined`, `skipped`.
- Never act below the confidence threshold. Never call Jev in `--frozen` mode.
- All shared types live in `src/types.ts` (Task 1) — copy names exactly.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, README.md
src/types.ts       shared types
src/gherkin.ts     .feature → Scenario[]
src/candidates.ts  Step → literal values
src/lockfile.ts    stepKey + Lockfile class
src/locators.ts    LocatorSpec → Playwright Locator
src/snapshot.ts    Page → Snapshot
src/resolver.ts    Jev: resolve(), semanticCheck(), createClient()
src/executor.ts    ResolvedStep → Playwright action/assertion
src/runner.ts      runScenario (pure orchestration) + runAll (browser wiring)
src/reporter.ts    console output + summary
src/cli.ts         argument parsing, main()
test/*.test.ts     unit tests
e2e/*.test.ts      frozen e2e + live smoke
fixtures/app/      login.html, todos.html, server.ts
fixtures/features/ login.feature
```

---

### Task 1: Scaffold, shared types, Gherkin loading

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/types.ts`, `src/gherkin.ts`
- Test: `test/gherkin.test.ts`

**Interfaces:**
- Produces: every type in `src/types.ts`; `parseFeature(source: string, uri: string): Scenario[]`; `findFeatureFiles(paths: string[]): string[]`; `loadFeatures(paths: string[], tagExpr?: string): Scenario[]`

- [ ] **Step 1: Scaffold**

`package.json`:
```json
{
  "name": "jevcumber",
  "version": "0.1.0",
  "description": "Run Cucumber feature files against a web UI with no step definitions, powered by Jev.",
  "type": "module",
  "bin": { "jevcumber": "dist/cli.js" },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "jevcumber": "tsx src/cli.ts"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
```

`.gitignore`:
```
node_modules
dist
```

Run:
```bash
npm install @playwright/test @cucumber/gherkin @cucumber/messages @cucumber/tag-expressions @typesafe-ai/sdk commander
npm install -D typescript vitest tsx @types/node
npx playwright install chromium
```

- [ ] **Step 2: Write `src/types.ts`**

```ts
export type Keyword = 'Given' | 'When' | 'Then';

export interface Step {
  keyword: Keyword;
  text: string;
  table?: string[][];
  docString?: string;
}

export interface Scenario {
  uri: string;
  feature: string;
  name: string;
  tags: string[];
  steps: Step[];
}

export type LocatorSpec =
  | { by: 'testid'; value: string }
  | { by: 'role'; role: string; name: string }
  | { by: 'label'; value: string }
  | { by: 'placeholder'; value: string }
  | { by: 'text'; value: string };

export interface ElementInfo {
  id: string;
  role: string;
  name: string;
  value?: string;
  locator: LocatorSpec;
}

export interface Snapshot {
  url: string;
  title: string;
  elements: ElementInfo[];
  text: string;
}

export type Assertion =
  | { form: 'text_visible' | 'text_not_visible' | 'url_contains'; value: string }
  | { form: 'element_visible'; locator: LocatorSpec }
  | { form: 'element_has_value'; locator: LocatorSpec; value: string }
  | { form: 'semantic' };

export type ResolvedStep =
  | { kind: 'navigate'; value: string }
  | { kind: 'click' | 'check' | 'uncheck'; locator: LocatorSpec }
  | { kind: 'fill' | 'select'; locator: LocatorSpec; value: string }
  | { kind: 'press'; key: string; locator?: LocatorSpec }
  | { kind: 'assert'; assertion: Assertion };

export type ResolveOutcome =
  | { ok: true; resolved: ResolvedStep; confidence: number }
  | { ok: false; reason: 'undefined' | 'ambiguous'; detail: string };

export type StepStatus = 'passed' | 'healed' | 'failed' | 'ambiguous' | 'undefined' | 'skipped';

export interface StepResult {
  step: Step;
  status: StepStatus;
  detail?: string;
}

export interface ScenarioResult {
  scenario: Scenario;
  steps: StepResult[];
}

export type Mode = 'default' | 'frozen' | 'update';
```

- [ ] **Step 3: Write the failing test** — `test/gherkin.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFeatureFiles, loadFeatures, parseFeature } from '../src/gherkin.js';

const SOURCE = `Feature: Login
  Background:
    Given I am on "/login"

  @smoke
  Scenario Outline: log in as <email>
    When I fill in the email field with "<email>"
    And I click the Log in button
    Then I should see "Welcome"
    But I should not see "Error"

    Examples:
      | email   |
      | a@b.c   |
      | d@e.f   |

  Scenario: table and docstring
    When I add todos
      | Buy milk |
      | Walk dog |
    Then the note reads
      """
      hello
      """
`;

describe('parseFeature', () => {
  const scenarios = parseFeature(SOURCE, 'login.feature');

  it('expands outlines and prepends the background', () => {
    expect(scenarios.map((s) => s.name)).toEqual([
      'log in as a@b.c',
      'log in as d@e.f',
      'table and docstring',
    ]);
    expect(scenarios[0].steps.map((s) => s.text)).toEqual([
      'I am on "/login"',
      'I fill in the email field with "a@b.c"',
      'I click the Log in button',
      'I should see "Welcome"',
      'I should not see "Error"',
    ]);
  });

  it('normalizes And/But to the preceding primary keyword', () => {
    expect(scenarios[0].steps.map((s) => s.keyword)).toEqual(['Given', 'When', 'When', 'Then', 'Then']);
  });

  it('carries feature name, uri, and tags', () => {
    expect(scenarios[0]).toMatchObject({ uri: 'login.feature', feature: 'Login', tags: ['@smoke'] });
    expect(scenarios[2].tags).toEqual([]);
  });

  it('carries data tables and docstrings', () => {
    expect(scenarios[2].steps[1].table).toEqual([['Buy milk'], ['Walk dog']]);
    expect(scenarios[2].steps[2].docString).toBe('hello');
  });

  it('throws on a parse error, naming the file', () => {
    expect(() => parseFeature('Feature: x\n  Scenario: y\n    nonsense here\n', 'bad.feature')).toThrow(/bad\.feature/);
  });
});

describe('loadFeatures', () => {
  it('finds .feature files recursively and filters by tag expression', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-'));
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'login.feature'), SOURCE);
    writeFileSync(join(dir, 'notes.txt'), 'ignore me');

    expect(findFeatureFiles([dir])).toEqual([join(dir, 'nested', 'login.feature')]);
    expect(loadFeatures([dir], '@smoke').map((s) => s.name)).toEqual(['log in as a@b.c', 'log in as d@e.f']);
    expect(loadFeatures([dir], 'not @smoke').map((s) => s.name)).toEqual(['table and docstring']);
    expect(loadFeatures([dir])).toHaveLength(3);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run test/gherkin.test.ts`
Expected: FAIL — cannot find `../src/gherkin.js`.

- [ ] **Step 5: Implement `src/gherkin.ts`**

```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { generateMessages } from '@cucumber/gherkin';
import { IdGenerator, SourceMediaType } from '@cucumber/messages';
import parseTagExpression from '@cucumber/tag-expressions';
import type { Keyword, Scenario, Step } from './types.js';

// Pickle step types already fold And/But into the preceding primary keyword.
const KEYWORDS: Record<string, Keyword> = { Context: 'Given', Action: 'When', Outcome: 'Then' };

export function parseFeature(source: string, uri: string): Scenario[] {
  const envelopes = generateMessages(source, uri, SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, {
    includeSource: false,
    includeGherkinDocument: true,
    includePickles: true,
    newId: IdGenerator.uuid(),
  });

  let feature = '';
  const scenarios: Scenario[] = [];
  for (const envelope of envelopes) {
    if (envelope.parseError) {
      throw new Error(`${uri}: ${envelope.parseError.message}`);
    }
    if (envelope.gherkinDocument) {
      feature = envelope.gherkinDocument.feature?.name ?? '';
    }
    if (envelope.pickle) {
      const pickle = envelope.pickle;
      scenarios.push({
        uri,
        feature,
        name: pickle.name,
        tags: pickle.tags.map((tag) => tag.name),
        steps: pickle.steps.map((pickleStep): Step => {
          const step: Step = { keyword: KEYWORDS[pickleStep.type ?? ''] ?? 'When', text: pickleStep.text };
          const table = pickleStep.argument?.dataTable;
          if (table) step.table = table.rows.map((row) => row.cells.map((cell) => cell.value));
          const docString = pickleStep.argument?.docString;
          if (docString) step.docString = docString.content;
          return step;
        }),
      });
    }
  }
  return scenarios;
}

export function findFeatureFiles(paths: string[]): string[] {
  const files: string[] = [];
  const visit = (path: string) => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (entry !== 'node_modules') visit(join(path, entry));
      }
    } else if (path.endsWith('.feature')) {
      files.push(path);
    }
  };
  paths.forEach(visit);
  return files;
}

export function loadFeatures(paths: string[], tagExpr?: string): Scenario[] {
  const scenarios = findFeatureFiles(paths).flatMap((file) => parseFeature(readFileSync(file, 'utf8'), file));
  if (!tagExpr) return scenarios;
  const expression = parseTagExpression(tagExpr);
  return scenarios.filter((scenario) => expression.evaluate(scenario.tags));
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/gherkin.test.ts && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Scaffold project; add shared types and Gherkin loading"
```

---

### Task 2: Literal value extraction

**Files:**
- Create: `src/candidates.ts`
- Test: `test/candidates.test.ts`

**Interfaces:**
- Consumes: `Step` from `src/types.ts`
- Produces: `extractValues(step: Step): string[]`

- [ ] **Step 1: Write the failing test** — `test/candidates.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { extractValues } from '../src/candidates.js';
import type { Step } from '../src/types.js';

const step = (text: string, extra: Partial<Step> = {}): Step => ({ keyword: 'When', text, ...extra });

describe('extractValues', () => {
  it('extracts double- and single-quoted strings in order', () => {
    expect(extractValues(step(`I fill in "Email" with 'alice@example.com'`))).toEqual(['Email', 'alice@example.com']);
  });

  it('does not treat apostrophes as quotes', () => {
    expect(extractValues(step(`I don't see the user's name`))).toEqual([]);
  });

  it('extracts bare URLs, paths, and numbers outside quotes', () => {
    expect(extractValues(step('I visit https://example.com/a?b=1 then /login and wait 3 seconds'))).toEqual([
      'https://example.com/a?b=1',
      '/login',
      '3',
    ]);
  });

  it('does not re-extract numbers or paths from inside quoted strings', () => {
    expect(extractValues(step('I am on "/login" with code "42"'))).toEqual(['/login', '42']);
  });

  it('appends table cells and the docstring, deduplicated', () => {
    const values = extractValues(step('I add "Buy milk"', { table: [['Buy milk'], ['Walk dog']], docString: 'note' }));
    expect(values).toEqual(['Buy milk', 'Walk dog', 'note']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/candidates.test.ts`
Expected: FAIL — cannot find `../src/candidates.js`.

- [ ] **Step 3: Implement `src/candidates.ts`**

```ts
import type { Step } from './types.js';

const QUOTED = /"([^"]+)"|(?<!\w)'([^']+)'(?!\w)/g;
const BARE = /https?:\/\/\S+|(?<=^|\s)\/[\w\-./]*|\b\d+(?:\.\d+)?\b/g;

/** Literal values a step could want typed, opened, or checked for, in order of appearance. */
export function extractValues(step: Step): string[] {
  const found: { index: number; value: string }[] = [];

  // Blank out quoted spans (same length, so indices line up) before scanning for bare literals.
  const unquoted = step.text.replace(QUOTED, (match, double, single, index: number) => {
    found.push({ index, value: double ?? single });
    return ' '.repeat(match.length);
  });
  for (const match of unquoted.matchAll(BARE)) {
    found.push({ index: match.index, value: match[0] });
  }

  const values = found.sort((a, b) => a.index - b.index).map((entry) => entry.value);
  if (step.table) values.push(...step.table.flat());
  if (step.docString) values.push(step.docString);
  return [...new Set(values.filter((value) => value.length > 0))];
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/candidates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add literal value extraction from steps"
```

---

### Task 3: Lockfile

**Files:**
- Create: `src/lockfile.ts`
- Test: `test/lockfile.test.ts`

**Interfaces:**
- Consumes: `Scenario`, `ResolvedStep` from `src/types.ts`
- Produces: `stepKey(scenario: Scenario, index: number): string`; `lockPathFor(featureUri: string): string`; `class Lockfile { static load(path: string): Lockfile; get(key: string): ResolvedStep | undefined; set(key: string, text: string, resolved: ResolvedStep): void; touch(key: string): void; save(prune: boolean): void }`

- [ ] **Step 1: Write the failing test** — `test/lockfile.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lockfile, lockPathFor, stepKey } from '../src/lockfile.js';
import type { Scenario } from '../src/types.js';

const scenario: Scenario = {
  uri: 'a.feature',
  feature: 'A',
  name: 'one',
  tags: [],
  steps: [
    { keyword: 'Given', text: 'I am on "/login"' },
    { keyword: 'When', text: 'I add todos', table: [['x']] },
  ],
};
const tmp = () => join(mkdtempSync(join(tmpdir(), 'jevcumber-')), 'a.feature.lock.json');

describe('stepKey', () => {
  it('is stable and sensitive to scenario, index, text, and table', () => {
    expect(stepKey(scenario, 0)).toBe(stepKey(scenario, 0));
    expect(stepKey(scenario, 0)).toMatch(/^[0-9a-f]{64}$/);
    expect(stepKey(scenario, 0)).not.toBe(stepKey(scenario, 1));
    expect(stepKey({ ...scenario, name: 'two' }, 0)).not.toBe(stepKey(scenario, 0));
    const changedTable = { ...scenario, steps: [scenario.steps[0], { ...scenario.steps[1], table: [['y']] }] };
    expect(stepKey(changedTable, 1)).not.toBe(stepKey(scenario, 1));
  });
});

describe('Lockfile', () => {
  it('names the lockfile after the feature file', () => {
    expect(lockPathFor('features/a.feature')).toBe('features/a.feature.lock.json');
  });

  it('loads empty when the file is missing and does not create a file on a no-op save', () => {
    const path = tmp();
    const lock = Lockfile.load(path);
    expect(lock.get('k')).toBeUndefined();
    lock.save(true);
    expect(existsSync(path)).toBe(false);
  });

  it('round-trips entries with sorted keys and a trailing newline', () => {
    const path = tmp();
    const lock = Lockfile.load(path);
    lock.set('b', 'second', { kind: 'navigate', value: '/b' });
    lock.set('a', 'first', { kind: 'navigate', value: '/a' });
    lock.save(false);

    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(raw).steps)).toEqual(['a', 'b']);
    expect(JSON.parse(raw).version).toBe(1);
    expect(Lockfile.load(path).get('a')).toEqual({ kind: 'navigate', value: '/a' });
  });

  it('prunes entries that were neither read, set, nor touched', () => {
    const path = tmp();
    const seed = Lockfile.load(path);
    seed.set('read', 'r', { kind: 'navigate', value: '/r' });
    seed.set('touched', 't', { kind: 'navigate', value: '/t' });
    seed.set('stale', 's', { kind: 'navigate', value: '/s' });
    seed.save(false);

    const lock = Lockfile.load(path);
    lock.get('read');
    lock.touch('touched');
    lock.save(true);
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).steps)).toEqual(['read', 'touched']);
  });

  it('rejects an unknown lockfile version', () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ version: 99, steps: {} }));
    expect(() => Lockfile.load(path)).toThrow(/version/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lockfile.test.ts`
Expected: FAIL — cannot find `../src/lockfile.js`.

- [ ] **Step 3: Implement `src/lockfile.ts`**

```ts
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ResolvedStep, Scenario } from './types.js';

const VERSION = 1;

interface LockEntry {
  text: string;
  resolved: ResolvedStep;
}

export function stepKey(scenario: Scenario, index: number): string {
  const step = scenario.steps[index];
  const identity = JSON.stringify([scenario.name, index, step.text, step.table ?? null, step.docString ?? null]);
  return createHash('sha256').update(identity).digest('hex');
}

export function lockPathFor(featureUri: string): string {
  return `${featureUri}.lock.json`;
}

export class Lockfile {
  private touched = new Set<string>();
  private dirty = false;

  private constructor(
    private readonly path: string,
    private steps: Record<string, LockEntry>,
  ) {}

  static load(path: string): Lockfile {
    if (!existsSync(path)) return new Lockfile(path, {});
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data.version !== VERSION) {
      throw new Error(`${path}: unsupported lockfile version ${data.version} (expected ${VERSION})`);
    }
    return new Lockfile(path, data.steps ?? {});
  }

  get(key: string): ResolvedStep | undefined {
    this.touched.add(key);
    return this.steps[key]?.resolved;
  }

  set(key: string, text: string, resolved: ResolvedStep): void {
    this.touched.add(key);
    this.steps[key] = { text, resolved };
    this.dirty = true;
  }

  touch(key: string): void {
    this.touched.add(key);
  }

  save(prune: boolean): void {
    if (prune) {
      for (const key of Object.keys(this.steps)) {
        if (!this.touched.has(key)) {
          delete this.steps[key];
          this.dirty = true;
        }
      }
    }
    if (!this.dirty) return;
    const sorted = Object.fromEntries(Object.entries(this.steps).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(this.path, `${JSON.stringify({ version: VERSION, steps: sorted }, null, 2)}\n`);
    this.dirty = false;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/lockfile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add step keys and lockfile persistence"
```

---

### Task 4: Locators and page snapshot

**Files:**
- Create: `src/locators.ts`, `src/snapshot.ts`
- Test: `test/snapshot.test.ts`

**Interfaces:**
- Consumes: `LocatorSpec`, `ElementInfo`, `Snapshot` from `src/types.ts`
- Produces: `toLocator(page: Page, spec: LocatorSpec): Locator`; `snapshot(page: Page): Promise<Snapshot>`

Background for the implementer: Playwright's `getByRole` computes accessible names with the full ARIA algorithm; our in-page name computation is an approximation. That is why every candidate `LocatorSpec` is verified with `locator.count() === 1` in Node before being accepted, falling through the preference order (test id → role+name → label → placeholder → text). Example: `<input type="password">` has no ARIA role, so its role locator counts 0 and it falls through to its label.

- [ ] **Step 1: Write the failing test** — `test/snapshot.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { snapshot } from '../src/snapshot.js';
import { toLocator } from '../src/locators.js';

const HTML = `
<title>Fixture</title>
<h1>Sign in</h1>
<form>
  <label for="email">Email</label> <input id="email" type="email" value="pre@fill.ed">
  <label>Password <input type="password" value="hunter2"></label>
  <input placeholder="Search…" type="search">
  <label><input type="checkbox" checked> Remember me</label>
  <select aria-label="Country"><option>UK</option><option selected>France</option></select>
  <button data-testid="submit-btn">Log in</button>
  <button>Delete</button> <button>Delete</button>
  <button disabled>Disabled one</button>
  <button style="display:none">Hidden one</button>
  <a href="/help">Need help?</a>
</form>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(HTML);
});
afterAll(() => browser.close());

describe('snapshot', () => {
  it('captures title and visible text', async () => {
    const snap = await snapshot(page);
    expect(snap.title).toBe('Fixture');
    expect(snap.text).toContain('Sign in');
  });

  it('lists interactive elements with sequential ids, roles, and names', async () => {
    const { elements } = await snapshot(page);
    expect(elements.map((e) => e.id)).toEqual(elements.map((_, i) => `e${i + 1}`));
    const byName = Object.fromEntries(elements.map((e) => [e.name, e]));
    expect(byName['Email']).toMatchObject({ role: 'textbox', value: 'pre@fill.ed' });
    expect(byName['Log in'].locator).toEqual({ by: 'testid', value: 'submit-btn' });
    expect(byName['Need help?']).toMatchObject({ role: 'link', locator: { by: 'role', role: 'link', name: 'Need help?' } });
    expect(byName['Remember me']).toMatchObject({ role: 'checkbox', value: 'checked' });
    expect(byName['Country']).toMatchObject({ role: 'combobox', value: 'France' });
    expect(byName['Search…'].locator).toMatchObject({ by: 'role' });
  });

  it('falls through to the label locator for password inputs and never exposes their value', async () => {
    const { elements } = await snapshot(page);
    const password = elements.find((e) => e.name === 'Password')!;
    expect(password.locator).toEqual({ by: 'label', value: 'Password' });
    expect(password.value).toBeUndefined();
  });

  it('omits disabled, hidden, and non-uniquely-locatable elements', async () => {
    const names = (await snapshot(page)).elements.map((e) => e.name);
    expect(names).not.toContain('Disabled one');
    expect(names).not.toContain('Hidden one');
    expect(names).not.toContain('Delete');
  });

  it('produces locators that each resolve to exactly one element', async () => {
    for (const element of (await snapshot(page)).elements) {
      expect(await toLocator(page, element.locator).count(), element.name).toBe(1);
    }
  });

  it('truncates page text to 8000 characters', async () => {
    const long = await browser.newPage();
    await long.setContent(`<p>${'word '.repeat(5000)}</p>`);
    expect((await snapshot(long)).text.length).toBe(8000);
    await long.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/snapshot.test.ts`
Expected: FAIL — cannot find `../src/snapshot.js`.

- [ ] **Step 3: Implement `src/locators.ts`**

```ts
import type { Locator, Page } from '@playwright/test';
import type { LocatorSpec } from './types.js';

type Role = Parameters<Page['getByRole']>[0];

export function toLocator(page: Page, spec: LocatorSpec): Locator {
  switch (spec.by) {
    case 'testid':
      return page.getByTestId(spec.value);
    case 'role':
      return page.getByRole(spec.role as Role, { name: spec.name, exact: true });
    case 'label':
      return page.getByLabel(spec.value, { exact: true });
    case 'placeholder':
      return page.getByPlaceholder(spec.value, { exact: true });
    case 'text':
      return page.getByText(spec.value, { exact: true });
  }
}
```

- [ ] **Step 4: Implement `src/snapshot.ts`**

```ts
import type { Page } from '@playwright/test';
import { toLocator } from './locators.js';
import type { ElementInfo, LocatorSpec, Snapshot } from './types.js';

const MAX_TEXT = 8000;

interface RawElement {
  role: string;
  name: string;
  value?: string;
  testId?: string;
  label?: string;
  placeholder?: string;
  text?: string;
}

// Runs inside the page: must be self-contained (no references to module scope).
function collect(): { title: string; text: string; elements: RawElement[] } {
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=menuitem]', '[role=switch]', '[role=combobox]', '[role=textbox]',
  ].join(',');
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return type;
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'search') return 'searchbox';
    if (type === 'number') return 'spinbutton';
    if (type === 'range') return 'slider';
    return 'textbox';
  };

  const isFormControl = (el: Element): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    ['input', 'select', 'textarea'].includes(el.tagName.toLowerCase());

  const labelOf = (el: Element): string => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => clean(document.getElementById(id)?.textContent)).join(' ');
      if (clean(text)) return clean(text);
    }
    if (isFormControl(el) && el.labels?.length) return clean(el.labels[0].textContent);
    return '';
  };

  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
  };

  const elements: RawElement[] = [];
  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    if (!visible(el)) continue;
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;

    const type = (el.getAttribute('type') ?? '').toLowerCase();
    const isInputButton = el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(type);
    const label = labelOf(el);
    const placeholder = clean(el.getAttribute('placeholder'));
    const text = isFormControl(el) ? '' : clean((el as HTMLElement).innerText);
    const name =
      clean(el.getAttribute('aria-label')) ||
      label ||
      (isInputButton ? clean((el as HTMLInputElement).value) : '') ||
      text ||
      clean(el.querySelector('img')?.getAttribute('alt')) ||
      clean(el.getAttribute('title')) ||
      placeholder;
    if (!name && !el.getAttribute('data-testid')) continue;

    let value: string | undefined;
    if (type === 'checkbox' || type === 'radio') {
      value = (el as HTMLInputElement).checked ? 'checked' : 'unchecked';
    } else if (el.tagName === 'SELECT') {
      value = clean((el as HTMLSelectElement).selectedOptions[0]?.textContent);
    } else if (isFormControl(el) && type !== 'password' && !isInputButton) {
      value = el.value || undefined;
    }

    elements.push({
      role: roleOf(el),
      name,
      value,
      testId: el.getAttribute('data-testid') ?? undefined,
      label: label || undefined,
      placeholder: placeholder || undefined,
      text: text || undefined,
    });
  }

  return { title: document.title, text: clean(document.body?.innerText), elements };
}

function specsFor(raw: RawElement): LocatorSpec[] {
  const specs: LocatorSpec[] = [];
  if (raw.testId) specs.push({ by: 'testid', value: raw.testId });
  if (raw.name) specs.push({ by: 'role', role: raw.role, name: raw.name });
  if (raw.label) specs.push({ by: 'label', value: raw.label });
  if (raw.placeholder) specs.push({ by: 'placeholder', value: raw.placeholder });
  if (raw.text) specs.push({ by: 'text', value: raw.text });
  return specs;
}

export async function snapshot(page: Page): Promise<Snapshot> {
  const raw = await page.evaluate(collect);

  const located = await Promise.all(
    raw.elements.map(async (element) => {
      for (const spec of specsFor(element)) {
        if ((await toLocator(page, spec).count()) === 1) return { element, spec };
      }
      return undefined; // not uniquely locatable: better omitted than ambiguous
    }),
  );

  const elements: ElementInfo[] = [];
  for (const entry of located) {
    if (!entry) continue;
    const info: ElementInfo = {
      id: `e${elements.length + 1}`,
      role: entry.element.role,
      name: entry.element.name,
      locator: entry.spec,
    };
    if (entry.element.value !== undefined) info.value = entry.element.value;
    elements.push(info);
  }

  return { url: page.url(), title: raw.title, elements, text: raw.text.slice(0, MAX_TEXT) };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/snapshot.test.ts && npm run typecheck`
Expected: PASS. If the `Search…` element's locator is not `role` on your Playwright version, the assertion `toMatchObject({ by: 'role' })` tells you which fallback was taken — the requirement is only that the locator resolves uniquely, so relax that one line to `expect(byName['Search…']).toBeDefined()` rather than changing the implementation.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add locator mapping and page snapshots"
```

---

### Task 5: Resolver (Jev)

**Files:**
- Create: `src/resolver.ts`
- Test: `test/resolver.test.ts`

**Interfaces:**
- Consumes: `Step`, `Snapshot`, `ElementInfo`, `ResolvedStep`, `ResolveOutcome`, `Assertion` from `src/types.ts`
- Produces:
  ```ts
  interface ChoiceAnswer { choice: string; confidence: number; probabilities: Record<string, number> }
  interface JevClient {
    systemOne(request: { state: unknown; questions: Record<string, unknown>; model?: string }):
      PromiseLike<{ answers: Record<string, any> }>;
  }
  interface ResolveInput {
    step: Step; scenarioName: string; previousSteps: string[];
    snapshot: Snapshot; values: string[]; client: JevClient; minConfidence: number;
  }
  function resolve(input: ResolveInput): Promise<ResolveOutcome>
  function semanticCheck(client: JevClient, stepText: string, snapshot: Snapshot): Promise<number>
  function createClient(): JevClient   // throws if TYPESAFE_API_KEY is unset
  function shortlist(elements: ElementInfo[], stepText: string, max: number): ElementInfo[]
  ```

Background for the implementer: Jev is a *System One* model — it answers typed questions (`choice`, `noul`) about a JSON `state`; it does not generate text. All questions in one `systemOne` call are answered in parallel and cannot see each other's answers, so every question here is phrased to stand alone ("assuming the step is a check, …"). Instructions refer to state by backticked path, e.g. `` `step.text` ``. `choice(instructions, criteria)` takes a map of option label → description; the answer has `.choice`, `.confidence`, `.probabilities`. `noul(instructions)` answers with `.noul`, the probability of yes. SDK types: `node_modules/@typesafe-ai/sdk/dist/index.d.mts`.

- [ ] **Step 1: Write the failing test** — `test/resolver.test.ts`

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/resolver.test.ts`
Expected: FAIL — cannot find `../src/resolver.js`.

- [ ] **Step 3: Implement `src/resolver.ts`**

```ts
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/resolver.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add Jev step resolver with confidence gating"
```

---

### Task 6: Executor

**Files:**
- Create: `src/executor.ts`
- Test: `test/executor.test.ts`

**Interfaces:**
- Consumes: `toLocator` (Task 4); `ResolvedStep`, `LocatorSpec` from `src/types.ts`
- Produces:
  ```ts
  interface ExecuteContext {
    baseUrl: string;
    stepText: string;
    /** Returns P(page satisfies stepText). Absent in --frozen mode. */
    semantic?: (stepText: string) => Promise<number>;
  }
  function execute(page: Page, resolved: ResolvedStep, ctx: ExecuteContext): Promise<void>  // throws on failure
  function actionLocators(resolved: ResolvedStep): LocatorSpec[]  // [] for navigate and every assert
  const SEMANTIC_THRESHOLD = 0.8
  ```

- [ ] **Step 1: Write the failing test** — `test/executor.test.ts`

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { actionLocators, execute } from '../src/executor.js';
import type { LocatorSpec } from '../src/types.js';

const HTML = `
<label for="email">Email</label><input id="email">
<label><input type="checkbox"> Remember me</label>
<select aria-label="Country"><option>UK</option><option>France</option></select>
<button onclick="document.getElementById('out').textContent = 'Clicked!'">Go</button>
<input aria-label="Search" onkeydown="if (event.key === 'Enter') document.getElementById('out').textContent = 'Searched'">
<p id="out"></p>
<p style="display:none">Secret</p>`;

const role = (r: string, name: string): LocatorSpec => ({ by: 'role', role: r, name });
const ctx = { baseUrl: 'http://unused', stepText: 'step' };

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(2000);
});
beforeEach(() => page.setContent(HTML));
afterAll(() => browser.close());

describe('execute: actions', () => {
  it('fills, checks, unchecks, selects, clicks, and presses', async () => {
    await execute(page, { kind: 'fill', locator: role('textbox', 'Email'), value: 'a@b.c' }, ctx);
    expect(await page.getByLabel('Email').inputValue()).toBe('a@b.c');

    await execute(page, { kind: 'check', locator: role('checkbox', 'Remember me') }, ctx);
    expect(await page.getByRole('checkbox').isChecked()).toBe(true);
    await execute(page, { kind: 'uncheck', locator: role('checkbox', 'Remember me') }, ctx);
    expect(await page.getByRole('checkbox').isChecked()).toBe(false);

    await execute(page, { kind: 'select', locator: role('combobox', 'Country'), value: 'France' }, ctx);
    expect(await page.getByRole('combobox').inputValue()).toBe('France');

    await execute(page, { kind: 'click', locator: role('button', 'Go') }, ctx);
    expect(await page.locator('#out').textContent()).toBe('Clicked!');

    await execute(page, { kind: 'press', key: 'Enter', locator: role('textbox', 'Search') }, ctx);
    expect(await page.locator('#out').textContent()).toBe('Searched');
  });

  it('resolves relative navigation against the base URL', async () => {
    await execute(page, { kind: 'navigate', value: 'text/html,<h1>Landed</h1>' }, { ...ctx, baseUrl: 'data:' });
    expect(await page.locator('h1').textContent()).toBe('Landed');
  });
});

describe('execute: assertions', () => {
  it('passes and fails text_visible', async () => {
    await execute(page, { kind: 'assert', assertion: { form: 'text_visible', value: 'Email' } }, ctx);
    await expect(
      execute(page, { kind: 'assert', assertion: { form: 'text_visible', value: 'Nope' } }, ctx),
    ).rejects.toThrow();
  });

  it('treats hidden or absent text as not visible', async () => {
    await execute(page, { kind: 'assert', assertion: { form: 'text_not_visible', value: 'Secret' } }, ctx);
    await execute(page, { kind: 'assert', assertion: { form: 'text_not_visible', value: 'Absent' } }, ctx);
    await expect(
      execute(page, { kind: 'assert', assertion: { form: 'text_not_visible', value: 'Email' } }, ctx),
    ).rejects.toThrow();
  });

  it('checks element visibility, element value, and URL', async () => {
    await execute(page, { kind: 'assert', assertion: { form: 'element_visible', locator: role('button', 'Go') } }, ctx);
    await page.getByLabel('Email').fill('x@y.z');
    await execute(page, { kind: 'assert', assertion: { form: 'element_has_value', locator: role('textbox', 'Email'), value: 'x@y.z' } }, ctx);
    await execute(page, { kind: 'assert', assertion: { form: 'url_contains', value: 'about:blank' } }, ctx);
    await expect(
      execute(page, { kind: 'assert', assertion: { form: 'url_contains', value: '/todos' } }, ctx),
    ).rejects.toThrow();
  });

  it('judges semantic assertions against the 0.8 threshold', async () => {
    const semantic = { kind: 'assert', assertion: { form: 'semantic' } } as const;
    await execute(page, semantic, { ...ctx, semantic: async () => 0.85 });
    await expect(execute(page, semantic, { ...ctx, semantic: async () => 0.5 })).rejects.toThrow(/0\.50/);
    await expect(execute(page, semantic, ctx)).rejects.toThrow(/--frozen/);
  });
});

describe('actionLocators', () => {
  it('returns locators for actions only', () => {
    expect(actionLocators({ kind: 'click', locator: role('button', 'Go') })).toEqual([role('button', 'Go')]);
    expect(actionLocators({ kind: 'press', key: 'Enter' })).toEqual([]);
    expect(actionLocators({ kind: 'navigate', value: '/' })).toEqual([]);
    expect(actionLocators({ kind: 'assert', assertion: { form: 'element_visible', locator: role('button', 'Go') } })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/executor.test.ts`
Expected: FAIL — cannot find `../src/executor.js`.

- [ ] **Step 3: Implement `src/executor.ts`**

```ts
import { expect, type Page } from '@playwright/test';
import { toLocator } from './locators.js';
import type { Assertion, LocatorSpec, ResolvedStep } from './types.js';

export const SEMANTIC_THRESHOLD = 0.8;
const ASSERT_TIMEOUT = 5000;

export interface ExecuteContext {
  baseUrl: string;
  stepText: string;
  /** Returns P(page satisfies stepText). Absent in --frozen mode. */
  semantic?: (stepText: string) => Promise<number>;
}

/** Locators the runner should validate before replaying a cached step. Assertions are left to expect's auto-wait. */
export function actionLocators(resolved: ResolvedStep): LocatorSpec[] {
  if (resolved.kind === 'navigate' || resolved.kind === 'assert') return [];
  return resolved.locator ? [resolved.locator] : [];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Let the page react to the action so the next snapshot sees its settled state.
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 500 }).catch(() => {});
}

async function check(page: Page, assertion: Assertion, ctx: ExecuteContext): Promise<void> {
  const timeout = ASSERT_TIMEOUT;
  switch (assertion.form) {
    case 'text_visible':
      return expect(page.getByText(assertion.value).first()).toBeVisible({ timeout });
    case 'text_not_visible':
      return expect(page.getByText(assertion.value).first()).toBeHidden({ timeout });
    case 'url_contains':
      return expect(page).toHaveURL(new RegExp(escapeRegExp(assertion.value)), { timeout });
    case 'element_visible':
      return expect(toLocator(page, assertion.locator)).toBeVisible({ timeout });
    case 'element_has_value':
      return expect(toLocator(page, assertion.locator)).toHaveValue(assertion.value, { timeout });
    case 'semantic': {
      if (!ctx.semantic) {
        throw new Error('This step is a descriptive expectation that only Jev can judge, so it cannot run with --frozen.');
      }
      const probability = await ctx.semantic(ctx.stepText);
      if (probability < SEMANTIC_THRESHOLD) {
        throw new Error(`Jev judged the expectation unmet (p=${probability.toFixed(2)}, needs ≥ ${SEMANTIC_THRESHOLD}).`);
      }
    }
  }
}

export async function execute(page: Page, resolved: ResolvedStep, ctx: ExecuteContext): Promise<void> {
  switch (resolved.kind) {
    case 'navigate':
      await page.goto(new URL(resolved.value, ctx.baseUrl).href);
      break;
    case 'click':
      await toLocator(page, resolved.locator).click();
      break;
    case 'check':
      await toLocator(page, resolved.locator).check();
      break;
    case 'uncheck':
      await toLocator(page, resolved.locator).uncheck();
      break;
    case 'fill':
      await toLocator(page, resolved.locator).fill(resolved.value);
      break;
    case 'select':
      await toLocator(page, resolved.locator).selectOption({ label: resolved.value });
      break;
    case 'press':
      if (resolved.locator) await toLocator(page, resolved.locator).press(resolved.key);
      else await page.keyboard.press(resolved.key);
      break;
    case 'assert':
      return check(page, resolved.assertion, ctx);
  }
  await settle(page);
}
```

Note on the navigation test: `new URL('text/html,<h1>Landed</h1>', 'data:')` does not resolve relative to a `data:` base in all Node versions. If that test fails at URL construction, replace it with one that serves no network: call `execute` with `{ kind: 'navigate', value: 'about:blank' }` and `baseUrl: 'http://localhost:1'`, then assert `page.url()` is `about:blank` (absolute URLs must pass through unchanged); the relative-path case is covered by the Task 8 e2e test.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/executor.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add Playwright executor for resolved steps"
```

---

### Task 7: Runner

**Files:**
- Create: `src/runner.ts`
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes: `stepKey`, `Lockfile`, `lockPathFor` (Task 3); `extractValues` (Task 2); `snapshot` (Task 4); `toLocator` (Task 4); `resolve`, `semanticCheck`, `createClient`, `JevClient` (Task 5); `execute`, `actionLocators` (Task 6); `loadFeatures` (Task 1)
- Produces:
  ```ts
  interface ScenarioDeps {
    mode: Mode;
    lock: Lockfile;
    resolve(step: Step, previousSteps: string[]): Promise<ResolveOutcome>;
    isValid(resolved: ResolvedStep): Promise<boolean>;
    execute(resolved: ResolvedStep, step: Step): Promise<void>;
    onStep?(result: StepResult): void;
  }
  function runScenario(scenario: Scenario, deps: ScenarioDeps): Promise<StepResult[]>

  interface Reporter { scenarioStart(scenario: Scenario): void; step(result: StepResult): void; end(results: ScenarioResult[]): void }
  interface RunOptions { paths: string[]; baseUrl: string; mode: Mode; headed: boolean; minConfidence: number; tags?: string; reporter: Reporter }
  function runAll(options: RunOptions): Promise<ScenarioResult[]>
  ```

`runScenario` is pure orchestration over injected functions so it is unit-testable without a browser or Jev. `runAll` does the real wiring and is exercised by the Task 8 e2e test.

- [ ] **Step 1: Write the failing test** — `test/runner.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lockfile, stepKey } from '../src/lockfile.js';
import { runScenario, type ScenarioDeps } from '../src/runner.js';
import type { ResolveOutcome, ResolvedStep, Scenario } from '../src/types.js';

const scenario: Scenario = {
  uri: 'a.feature', feature: 'A', name: 's', tags: [],
  steps: [
    { keyword: 'Given', text: 'one' },
    { keyword: 'When', text: 'two' },
    { keyword: 'Then', text: 'three' },
  ],
};
const nav = (value: string): ResolvedStep => ({ kind: 'navigate', value });
const ok = (resolved: ResolvedStep): ResolveOutcome => ({ ok: true, resolved, confidence: 0.9 });

function harness(overrides: Partial<ScenarioDeps> = {}, seed: Record<number, ResolvedStep> = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'jevcumber-')), 'a.feature.lock.json');
  const lock = Lockfile.load(path);
  for (const [index, resolved] of Object.entries(seed)) {
    lock.set(stepKey(scenario, Number(index)), scenario.steps[Number(index)].text, resolved);
  }
  const calls = { resolve: [] as string[], execute: [] as ResolvedStep[] };
  const deps: ScenarioDeps = {
    mode: 'default',
    lock,
    resolve: async (step) => {
      calls.resolve.push(step.text);
      return ok(nav(`/${step.text}`));
    },
    isValid: async () => true,
    execute: async (resolved) => {
      calls.execute.push(resolved);
    },
    ...overrides,
  };
  return { deps, calls, lock, path };
}

describe('runScenario', () => {
  it('resolves uncached steps, executes them, and records them in the lockfile', async () => {
    const { deps, calls, lock } = harness();
    const results = await runScenario(scenario, deps);
    expect(results.map((r) => r.status)).toEqual(['passed', 'passed', 'passed']);
    expect(calls.resolve).toEqual(['one', 'two', 'three']);
    expect(lock.get(stepKey(scenario, 1))).toEqual(nav('/two'));
  });

  it('replays valid cached steps without resolving', async () => {
    const { deps, calls } = harness({}, { 0: nav('/cached') });
    await runScenario(scenario, deps);
    expect(calls.resolve).toEqual(['two', 'three']);
    expect(calls.execute[0]).toEqual(nav('/cached'));
  });

  it('passes previous step texts to the resolver', async () => {
    const seen: string[][] = [];
    const { deps } = harness({ resolve: async (step, previous) => (seen.push(previous), ok(nav('/x'))) });
    await runScenario(scenario, deps);
    expect(seen).toEqual([[], ['one'], ['one', 'two']]);
  });

  it('heals a stale cached step and reports it as healed', async () => {
    const { deps, lock } = harness({ isValid: async (r) => (r as { value: string }).value !== '/stale' }, { 0: nav('/stale') });
    const results = await runScenario(scenario, deps);
    expect(results[0].status).toBe('healed');
    expect(lock.get(stepKey(scenario, 0))).toEqual(nav('/one'));
  });

  it('ignores the cache in update mode and reports passed, not healed', async () => {
    const { deps, calls } = harness({ mode: 'update' }, { 0: nav('/cached') });
    const results = await runScenario(scenario, deps);
    expect(calls.resolve).toEqual(['one', 'two', 'three']);
    expect(results[0].status).toBe('passed');
  });

  it('never resolves in frozen mode: a miss or stale entry fails the step', async () => {
    const miss = harness({ mode: 'frozen' });
    const missResults = await runScenario(scenario, miss.deps);
    expect(miss.calls.resolve).toEqual([]);
    expect(missResults[0]).toMatchObject({ status: 'failed' });
    expect(missResults[0].detail).toMatch(/no lockfile entry/i);

    const stale = harness({ mode: 'frozen', isValid: async () => false }, { 0: nav('/x') });
    const staleResults = await runScenario(scenario, stale.deps);
    expect(stale.calls.resolve).toEqual([]);
    expect(staleResults[0].detail).toMatch(/stale/i);
  });

  it('maps undefined and ambiguous outcomes to statuses and skips the rest', async () => {
    const { deps, calls } = harness({
      resolve: async (step) =>
        step.text === 'two' ? { ok: false, reason: 'ambiguous', detail: 'which one?' } : ok(nav('/x')),
    });
    const results = await runScenario(scenario, deps);
    expect(results.map((r) => r.status)).toEqual(['passed', 'ambiguous', 'skipped']);
    expect(results[1].detail).toBe('which one?');
    expect(calls.execute).toHaveLength(1);
  });

  it('fails a step when execution throws, keeping the error message', async () => {
    const { deps } = harness({
      execute: async (_r, step) => {
        if (step.text === 'two') throw new Error('element not found');
      },
    });
    const results = await runScenario(scenario, deps);
    expect(results.map((r) => r.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(results[1].detail).toContain('element not found');
  });

  it('fails a step when the resolver throws (e.g. missing API key)', async () => {
    const { deps } = harness({ resolve: async () => { throw new Error('TYPESAFE_API_KEY is not set'); } });
    const results = await runScenario(scenario, deps);
    expect(results[0]).toMatchObject({ status: 'failed' });
    expect(results[0].detail).toContain('TYPESAFE_API_KEY');
  });

  it('keeps skipped steps\' lockfile entries alive through a pruning save', async () => {
    const { deps, lock, path } = harness(
      { execute: async () => { throw new Error('boom'); } },
      { 0: nav('/a'), 1: nav('/b'), 2: nav('/c') },
    );
    await runScenario(scenario, deps);
    lock.save(true);
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).steps)).toHaveLength(3);
  });

  it('streams results through onStep', async () => {
    const seen: string[] = [];
    const { deps } = harness({ onStep: (r) => seen.push(r.status) });
    await runScenario(scenario, deps);
    expect(seen).toEqual(['passed', 'passed', 'passed']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/runner.test.ts`
Expected: FAIL — cannot find `../src/runner.js`.

- [ ] **Step 3: Implement `src/runner.ts`**

```ts
import { chromium, type Page } from '@playwright/test';
import { extractValues } from './candidates.js';
import { actionLocators, execute } from './executor.js';
import { loadFeatures } from './gherkin.js';
import { toLocator } from './locators.js';
import { Lockfile, lockPathFor, stepKey } from './lockfile.js';
import { createClient, resolve, semanticCheck, type JevClient } from './resolver.js';
import { snapshot } from './snapshot.js';
import type { Mode, ResolveOutcome, ResolvedStep, Scenario, ScenarioResult, Step, StepResult } from './types.js';

const VALIDATE_TIMEOUT = 2000;

export interface ScenarioDeps {
  mode: Mode;
  lock: Lockfile;
  resolve(step: Step, previousSteps: string[]): Promise<ResolveOutcome>;
  isValid(resolved: ResolvedStep): Promise<boolean>;
  execute(resolved: ResolvedStep, step: Step): Promise<void>;
  onStep?(result: StepResult): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runScenario(scenario: Scenario, deps: ScenarioDeps): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let skipping = false;

  const runStep = async (step: Step, index: number): Promise<StepResult> => {
    const key = stepKey(scenario, index);
    if (skipping) {
      deps.lock.touch(key); // a failing run must not prune entries it never reached
      return { step, status: 'skipped' };
    }

    const cached = deps.mode === 'update' ? undefined : deps.lock.get(key);
    let resolved: ResolvedStep;
    let healed = false;

    if (cached && (await deps.isValid(cached))) {
      resolved = cached;
    } else if (deps.mode === 'frozen') {
      const detail = cached
        ? 'The lockfile entry for this step is stale: its element is no longer on the page. Run without --frozen to heal it.'
        : 'No lockfile entry for this step. Run without --frozen to resolve it with Jev.';
      return { step, status: 'failed', detail };
    } else {
      let outcome: ResolveOutcome;
      try {
        outcome = await deps.resolve(step, scenario.steps.slice(0, index).map((s) => s.text));
      } catch (error) {
        return { step, status: 'failed', detail: message(error) };
      }
      if (!outcome.ok) return { step, status: outcome.reason, detail: outcome.detail };
      resolved = outcome.resolved;
      deps.lock.set(key, step.text, resolved);
      healed = cached !== undefined;
    }

    try {
      await deps.execute(resolved, step);
    } catch (error) {
      return { step, status: 'failed', detail: message(error) };
    }
    return { step, status: healed ? 'healed' : 'passed' };
  };

  for (const [index, step] of scenario.steps.entries()) {
    const result = await runStep(step, index);
    if (result.status !== 'passed' && result.status !== 'healed') skipping = true;
    results.push(result);
    deps.onStep?.(result);
  }
  return results;
}

export interface Reporter {
  scenarioStart(scenario: Scenario): void;
  step(result: StepResult): void;
  end(results: ScenarioResult[]): void;
}

export interface RunOptions {
  paths: string[];
  baseUrl: string;
  mode: Mode;
  headed: boolean;
  minConfidence: number;
  tags?: string;
  reporter: Reporter;
}

async function isValid(page: Page, resolved: ResolvedStep): Promise<boolean> {
  for (const spec of actionLocators(resolved)) {
    const locator = toLocator(page, spec);
    await locator.first().waitFor({ state: 'attached', timeout: VALIDATE_TIMEOUT }).catch(() => {});
    if ((await locator.count()) !== 1) return false;
  }
  return true;
}

export async function runAll(options: RunOptions): Promise<ScenarioResult[]> {
  const scenarios = loadFeatures(options.paths, options.tags);
  const frozen = options.mode === 'frozen';

  let client: JevClient | undefined;
  const getClient = () => (client ??= createClient());

  const locks = new Map<string, Lockfile>();
  const lockFor = (uri: string) => {
    if (!locks.has(uri)) locks.set(uri, Lockfile.load(lockPathFor(uri)));
    return locks.get(uri)!;
  };

  const results: ScenarioResult[] = [];
  const browser = await chromium.launch({ headless: !options.headed });
  try {
    for (const scenario of scenarios) {
      options.reporter.scenarioStart(scenario);
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        const steps = await runScenario(scenario, {
          mode: options.mode,
          lock: lockFor(scenario.uri),
          resolve: async (step, previousSteps) =>
            resolve({
              step,
              scenarioName: scenario.name,
              previousSteps,
              snapshot: await snapshot(page),
              values: extractValues(step),
              client: getClient(),
              minConfidence: options.minConfidence,
            }),
          isValid: (resolved) => isValid(page, resolved),
          execute: (resolved, step) =>
            execute(page, resolved, {
              baseUrl: options.baseUrl,
              stepText: step.text,
              semantic: frozen ? undefined : async (text) => semanticCheck(getClient(), text, await snapshot(page)),
            }),
          onStep: (result) => options.reporter.step(result),
        });
        results.push({ scenario, steps });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  if (!frozen) {
    // Prune only when every scenario of the feature ran, i.e. no tag filter.
    for (const lock of locks.values()) lock.save(options.tags === undefined);
  }
  options.reporter.end(results);
  return results;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/runner.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add scenario runner with lockfile replay, healing, and frozen mode"
```

---

### Task 8: Reporter, CLI, fixture app, end-to-end tests, README

**Files:**
- Create: `src/reporter.ts`, `src/cli.ts`, `fixtures/app/login.html`, `fixtures/app/todos.html`, `fixtures/app/server.ts`, `fixtures/features/login.feature`, `README.md`
- Test: `test/reporter.test.ts`, `e2e/frozen.test.ts`, `e2e/live.test.ts`

**Interfaces:**
- Consumes: `runAll`, `Reporter`, `RunOptions` (Task 7); `parseFeature` (Task 1); `stepKey`, `lockPathFor` (Task 3); all result types
- Produces: `consoleReporter(write?: (line: string) => void): Reporter`; `exitCode(results: ScenarioResult[]): 0 | 1`; `main(argv: string[]): Promise<number>`; `startFixtureServer(): Promise<{ url: string; close(): Promise<void> }>`

- [ ] **Step 1: Write the failing reporter test** — `test/reporter.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { consoleReporter, exitCode } from '../src/reporter.js';
import type { Scenario, ScenarioResult, StepStatus } from '../src/types.js';

const scenario: Scenario = { uri: 'a.feature', feature: 'Login', name: 'logs in', tags: [], steps: [] };
const result = (...statuses: StepStatus[]): ScenarioResult => ({
  scenario,
  steps: statuses.map((status, i) => ({ step: { keyword: 'When', text: `step ${i}` }, status, detail: status === 'failed' ? 'boom\nline two' : undefined })),
});

describe('consoleReporter', () => {
  it('prints feature once, scenarios, step marks, indented details, and a summary', () => {
    const lines: string[] = [];
    const reporter = consoleReporter((line) => lines.push(line));
    const results = [result('passed', 'healed'), result('failed', 'skipped')];
    for (const r of results) {
      reporter.scenarioStart(r.scenario);
      r.steps.forEach((s) => reporter.step(s));
    }
    reporter.end(results);

    expect(lines.filter((l) => l === 'Feature: Login')).toHaveLength(1);
    expect(lines).toContain('  Scenario: logs in');
    expect(lines).toContain('    ✓ When step 0');
    expect(lines).toContain('    ↻ When step 1 (healed — lockfile updated)');
    expect(lines).toContain('    ✗ When step 0');
    expect(lines).toContain('        boom');
    expect(lines).toContain('        line two');
    expect(lines).toContain('    - When step 1');
    expect(lines.at(-1)).toBe('2 scenarios (1 passed, 1 failed) · 4 steps (1 passed, 1 healed, 1 failed, 1 skipped)');
  });
});

describe('exitCode', () => {
  it('is 0 only when every step passed or healed', () => {
    expect(exitCode([result('passed', 'healed')])).toBe(0);
    expect(exitCode([result('passed'), result('ambiguous')])).toBe(1);
    expect(exitCode([result('undefined')])).toBe(1);
    expect(exitCode([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/reporter.test.ts`
Expected: FAIL — cannot find `../src/reporter.js`.

- [ ] **Step 3: Implement `src/reporter.ts`**

```ts
import type { Reporter } from './runner.js';
import type { ScenarioResult, StepStatus } from './types.js';

const MARKS: Record<StepStatus, string> = {
  passed: '✓', healed: '↻', failed: '✗', ambiguous: '?', undefined: '?', skipped: '-',
};
const ORDER: StepStatus[] = ['passed', 'healed', 'failed', 'ambiguous', 'undefined', 'skipped'];

const scenarioPassed = (result: ScenarioResult) =>
  result.steps.every((step) => step.status === 'passed' || step.status === 'healed');

export function exitCode(results: ScenarioResult[]): 0 | 1 {
  return results.every(scenarioPassed) ? 0 : 1;
}

export function consoleReporter(write: (line: string) => void = console.log): Reporter {
  let currentFeature: string | undefined;
  return {
    scenarioStart(scenario) {
      if (scenario.feature !== currentFeature) {
        currentFeature = scenario.feature;
        write(`Feature: ${scenario.feature}`);
      }
      write(`  Scenario: ${scenario.name}`);
    },
    step({ step, status, detail }) {
      const suffix =
        status === 'healed' ? ' (healed — lockfile updated)' : status === 'ambiguous' || status === 'undefined' ? ` (${status})` : '';
      write(`    ${MARKS[status]} ${step.keyword} ${step.text}${suffix}`);
      if (detail) for (const line of detail.split('\n')) write(`        ${line}`);
    },
    end(results) {
      const passed = results.filter(scenarioPassed).length;
      const scenarioParts = [`${passed} passed`];
      if (results.length - passed > 0) scenarioParts.push(`${results.length - passed} failed`);

      const steps = results.flatMap((result) => result.steps);
      const stepParts = ORDER.map((status) => [status, steps.filter((s) => s.status === status).length] as const)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => `${count} ${status}`);

      write('');
      write(`${results.length} scenarios (${scenarioParts.join(', ')}) · ${steps.length} steps (${stepParts.join(', ')})`);
    },
  };
}
```

Note: the test's expected final line has no blank line before it in `lines.at(-1)` — the blank `write('')` is the second-to-last entry, so `at(-1)` is the summary. The ambiguous/undefined suffix is not asserted in the test above by exact string; keep it as written.

- [ ] **Step 4: Run the reporter test**

Run: `npx vitest run test/reporter.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `src/cli.ts`**

```ts
#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { consoleReporter, exitCode } from './reporter.js';
import { runAll } from './runner.js';
import type { Mode } from './types.js';

function parseConfidence(raw: string): number {
  const value = Number(raw);
  if (!(value >= 0 && value <= 1)) throw new InvalidArgumentError('must be a number between 0 and 1');
  return value;
}

export async function main(argv: string[]): Promise<number> {
  const program = new Command()
    .name('jevcumber')
    .description('Run Cucumber feature files against a web UI with no step definitions.')
    .argument('<paths...>', 'feature files or directories')
    .requiredOption('--base-url <url>', 'URL that relative navigation resolves against')
    .option('--frozen', 'replay the lockfile only; never call Jev (for CI)', false)
    .option('--update', 'ignore the lockfile and re-resolve every step', false)
    .option('--headed', 'show the browser', false)
    .option('--min-confidence <n>', 'refuse to act below this Jev confidence', parseConfidence, 0.6)
    .option('--tags <expr>', 'cucumber tag expression, e.g. "@smoke and not @wip"')
    .exitOverride();

  try {
    program.parse(argv, { from: 'user' });
  } catch (error) {
    // commander has already printed the message (or the help text)
    return (error as { exitCode?: number }).exitCode ?? 1;
  }

  const options = program.opts();
  if (options.frozen && options.update) {
    console.error('error: --frozen and --update are mutually exclusive');
    return 1;
  }
  const mode: Mode = options.frozen ? 'frozen' : options.update ? 'update' : 'default';

  try {
    const results = await runAll({
      paths: program.args,
      baseUrl: options.baseUrl,
      mode,
      headed: options.headed,
      minConfidence: options.minConfidence,
      tags: options.tags,
      reporter: consoleReporter(),
    });
    if (results.length === 0) {
      console.error('error: no scenarios found');
      return 1;
    }
    return exitCode(results);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Run only when invoked as a script (npm's bin shim is a symlink, hence realpath).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
```

- [ ] **Step 6: Create the fixture app**

`fixtures/app/login.html`:
```html
<!doctype html>
<title>Sign in</title>
<h1>Sign in</h1>
<form id="login">
  <label for="email">Email</label> <input id="email" type="email">
  <label for="password">Password</label> <input id="password" type="password">
  <button type="submit">Log in</button>
</form>
<p id="error" role="alert"></p>
<script>
  document.getElementById('login').addEventListener('submit', (event) => {
    event.preventDefault();
    const email = document.getElementById('email').value;
    if (document.getElementById('password').value === 'secret') {
      location.href = '/todos?user=' + encodeURIComponent(email.split('@')[0]);
    } else {
      document.getElementById('error').textContent = 'Invalid email or password';
    }
  });
</script>
```

`fixtures/app/todos.html`:
```html
<!doctype html>
<title>Todos</title>
<h1 id="welcome"></h1>
<form id="add">
  <label for="new-todo">New todo</label> <input id="new-todo">
  <button type="submit">Add</button>
</form>
<ul id="list"></ul>
<script>
  const user = new URLSearchParams(location.search).get('user') ?? 'stranger';
  document.getElementById('welcome').textContent = 'Welcome, ' + user;
  document.getElementById('add').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('new-todo');
    if (!input.value) return;
    const item = document.createElement('li');
    item.textContent = input.value;
    document.getElementById('list').append(item);
    input.value = '';
  });
</script>
```

`fixtures/app/server.ts`:
```ts
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAGES: Record<string, string> = { '/': 'login.html', '/login': 'login.html', '/todos': 'todos.html' };

export async function startFixtureServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const page = PAGES[new URL(request.url ?? '/', 'http://localhost').pathname];
    if (!page) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(join(here, page)));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
```

`fixtures/features/login.feature`:
```gherkin
Feature: Login

  Background:
    Given I am on "/login"

  Scenario: successful login
    When I fill in the email field with "alice@example.com"
    And I fill in the password field with "secret"
    And I click the Log in button
    Then I should see "Welcome, alice"
    And the URL should contain "/todos"

  Scenario: adding a todo after logging in
    When I fill in the email field with "alice@example.com"
    And I fill in the password field with "secret"
    And I press Enter in the password field
    And I fill in the new todo field with "Buy milk"
    And I click the Add button
    Then I should see "Buy milk"

  Scenario: wrong password
    When I fill in the email field with "alice@example.com"
    And I fill in the password field with "wrong"
    And I click the Log in button
    Then I should see "Invalid email or password"
    And I should not see "Welcome"
```

- [ ] **Step 7: Write the frozen e2e test** — `e2e/frozen.test.ts`

The lockfile is built programmatically from known-good resolutions, so this test proves the whole replay path (CLI → gherkin → lockfile → validation → executor → reporter → exit code) with no API key.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from '../fixtures/app/server.js';
import { main } from '../src/cli.js';
import { parseFeature } from '../src/gherkin.js';
import { lockPathFor, stepKey } from '../src/lockfile.js';
import type { LocatorSpec, ResolvedStep } from '../src/types.js';

const email: LocatorSpec = { by: 'role', role: 'textbox', name: 'Email' };
const password: LocatorSpec = { by: 'label', value: 'Password' };
const logIn: LocatorSpec = { by: 'role', role: 'button', name: 'Log in' };
const newTodo: LocatorSpec = { by: 'role', role: 'textbox', name: 'New todo' };
const add: LocatorSpec = { by: 'role', role: 'button', name: 'Add' };
const sees = (value: string): ResolvedStep => ({ kind: 'assert', assertion: { form: 'text_visible', value } });

const RESOLVED: Record<string, ResolvedStep> = {
  'I am on "/login"': { kind: 'navigate', value: '/login' },
  'I fill in the email field with "alice@example.com"': { kind: 'fill', locator: email, value: 'alice@example.com' },
  'I fill in the password field with "secret"': { kind: 'fill', locator: password, value: 'secret' },
  'I fill in the password field with "wrong"': { kind: 'fill', locator: password, value: 'wrong' },
  'I click the Log in button': { kind: 'click', locator: logIn },
  'I press Enter in the password field': { kind: 'press', key: 'Enter', locator: password },
  'I fill in the new todo field with "Buy milk"': { kind: 'fill', locator: newTodo, value: 'Buy milk' },
  'I click the Add button': { kind: 'click', locator: add },
  'I should see "Welcome, alice"': sees('Welcome, alice'),
  'I should see "Buy milk"': sees('Buy milk'),
  'I should see "Invalid email or password"': sees('Invalid email or password'),
  'I should not see "Welcome"': { kind: 'assert', assertion: { form: 'text_not_visible', value: 'Welcome' } },
  'the URL should contain "/todos"': { kind: 'assert', assertion: { form: 'url_contains', value: '/todos' } },
};

function workspace(overrides: Record<string, ResolvedStep | null> = {}): { dir: string; feature: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jevcumber-e2e-'));
  cpSync('fixtures/features', dir, { recursive: true });
  const feature = join(dir, 'login.feature');
  const steps: Record<string, unknown> = {};
  for (const scenario of parseFeature(readFileSync(feature, 'utf8'), feature)) {
    scenario.steps.forEach((step, index) => {
      const resolved = step.text in overrides ? overrides[step.text] : RESOLVED[step.text];
      if (resolved) steps[stepKey(scenario, index)] = { text: step.text, resolved };
    });
  }
  writeFileSync(lockPathFor(feature), JSON.stringify({ version: 1, steps }, null, 2));
  return { dir, feature };
}

let server: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => {
  server = await startFixtureServer();
});
afterAll(() => server.close());

describe('jevcumber --frozen against the fixture app', () => {
  it('passes every scenario from the lockfile alone and leaves the lockfile untouched', async () => {
    const { dir, feature } = workspace();
    const before = readFileSync(lockPathFor(feature), 'utf8');
    expect(await main([dir, '--base-url', server.url, '--frozen'])).toBe(0);
    expect(readFileSync(lockPathFor(feature), 'utf8')).toBe(before);
  });

  it('exits 1 when an assertion fails', async () => {
    const { dir } = workspace({ 'I should see "Welcome, alice"': sees('Welcome, bob') });
    expect(await main([dir, '--base-url', server.url, '--frozen'])).toBe(1);
  });

  it('exits 1 when a step has no lockfile entry', async () => {
    const { dir } = workspace({ 'I click the Add button': null });
    expect(await main([dir, '--base-url', server.url, '--frozen'])).toBe(1);
  });

  it('exits 1 when a cached action locator is stale', async () => {
    const { dir } = workspace({ 'I click the Log in button': { kind: 'click', locator: { by: 'role', role: 'button', name: 'Sign in' } } });
    expect(await main([dir, '--base-url', server.url, '--frozen'])).toBe(1);
  });

  it('honours --tags and rejects bad arguments', async () => {
    const { dir } = workspace();
    expect(await main([dir, '--base-url', server.url, '--frozen', '--tags', '@nonexistent'])).toBe(1); // no scenarios
    expect(await main([dir, '--base-url', server.url, '--frozen', '--update'])).toBe(1);
    expect(await main([dir])).toBe(1); // missing --base-url
  });
});
```

- [ ] **Step 8: Write the live smoke test** — `e2e/live.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from '../fixtures/app/server.js';
import { main } from '../src/cli.js';

// Calls the real Jev API: runs only when a key is available.
describe.skipIf(!process.env.TYPESAFE_API_KEY)('jevcumber live against the fixture app', () => {
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  beforeAll(async () => {
    server = await startFixtureServer();
  });
  afterAll(() => server.close());

  it('resolves every step with Jev, writes a lockfile, then replays it frozen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-live-'));
    cpSync('fixtures/features', dir, { recursive: true });

    expect(await main([dir, '--base-url', server.url])).toBe(0);
    expect(existsSync(join(dir, 'login.feature.lock.json'))).toBe(true);
    expect(await main([dir, '--base-url', server.url, '--frozen'])).toBe(0);
  }, 180_000);
});
```

- [ ] **Step 9: Run the whole suite, typecheck, and build**

Run: `npm test && npm run typecheck && npm run build && node dist/cli.js --help`
Expected: all unit and frozen e2e tests PASS; live test reported as skipped unless `TYPESAFE_API_KEY` is set; help text prints. If a frozen e2e scenario fails, run `npx tsx src/cli.ts <tmpdir> --base-url <url> --frozen --headed` by hand against `npx tsx -e "import('./fixtures/app/server.ts').then(m => m.startFixtureServer()).then(s => console.log(s.url))"` to see which locator in `RESOLVED` does not match the fixture — fix the test's locator, not the executor.

- [ ] **Step 10: Write `README.md`**

````markdown
# jevcumber

Write Cucumber tests with just the `.feature` file. No step definitions.

jevcumber reads your Gherkin, opens your app in a browser with Playwright, and asks
[Jev](https://docs.typesafe.ai) — TypeSafe AI's System One model — what each step means
*on the page in front of it*. Jev doesn't write code: jevcumber lists the page's
controls and the literal values in your step, Jev picks among them, and jevcumber
performs the pick.

```gherkin
Feature: Login
  Scenario: successful login
    Given I am on "/login"
    When I fill in the email field with "alice@example.com"
    And I fill in the password field with "secret"
    And I click the Log in button
    Then I should see "Welcome, alice"
```

```bash
export TYPESAFE_API_KEY=...
npx jevcumber features/ --base-url http://localhost:3000
```

## The lockfile

The first run resolves each step with Jev and records the result in
`<name>.feature.lock.json` next to the feature. **Commit it.** Later runs replay it:
no API calls, no key, no model variance.

| Flag | Behaviour |
| --- | --- |
| *(default)* | Replay the lockfile; resolve new or changed steps; **heal** steps whose element has gone (reported as `↻`, visible in the lockfile diff). |
| `--frozen` | Replay only. Never calls Jev. A missing or stale entry fails. Use this in CI. |
| `--update` | Ignore the lockfile and re-resolve everything. |

Other flags: `--headed`, `--tags "@smoke and not @wip"`, `--min-confidence 0.6`.

## Writing steps Jev can resolve

- **Put data in quotes.** Jev selects values, it never invents them:
  `I fill in the email field with "alice@example.com"`.
- **Navigate with a literal path:** `Given I am on "/login"`, not "the login page".
- **Name controls as they appear on the page:** "the Log in button", "the email field".
- `Then` steps with quoted text become fast, cached Playwright assertions. Descriptive
  expectations ("Then I see a friendly error") are judged live by Jev each run, so they
  need the API key and can't run under `--frozen`.

If Jev isn't confident, jevcumber won't guess: the step is reported as **ambiguous**
with the top candidates, or **undefined** if nothing on the page matches. Reword and rerun.

## Limits (v0.1)

Sequential scenarios; no hooks, iframes, file uploads, drag and drop, or multi-tab flows.

## Development

```bash
npm install && npx playwright install chromium
npm test            # unit + frozen e2e (no API key needed)
TYPESAFE_API_KEY=... npm test   # also runs the live smoke test
```
````

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "Add CLI, reporter, fixture app, e2e tests, and README"
```

---

## Self-review notes

- Spec coverage: gherkin (T1), candidates (T2), lockfile incl. pruning/sorting (T3), snapshot + locator preference + uniqueness + 8 000 cap (T4), resolver questions/relevance/shortlist/confidence/undefined/ambiguous + semantic Noul (T5), executor actions/assertions/settle/semantic threshold (T6), runner modes/healing/skip/touch-on-skip + browser wiring + prune-only-without-tags (T7), CLI flags/exit codes/API-key-only-when-needed/reporter/e2e/live smoke (T8).
- API errors: the SDK retries 429/529 itself; other errors propagate from `resolve` and are turned into a failed step by `runScenario` (tested in T7).
