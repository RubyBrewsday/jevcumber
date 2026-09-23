# 🥒 jevcumber

**[jevcumber.dev](https://jevcumber.dev)** — site and demo video

[![npm](https://img.shields.io/npm/v/jevcumber.svg)](https://www.npmjs.com/package/jevcumber)
[![CI](https://github.com/RubyBrewsday/jevcumber/actions/workflows/ci.yml/badge.svg)](https://github.com/RubyBrewsday/jevcumber/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Write Cucumber tests with just the `.feature` file. No step definitions.**

```gherkin
Feature: Wikipedia search

  Scenario: Looking up bagels
    Given I am on https://en.wikipedia.org
    When I search for "bagel"
    Then I should see "From Wikipedia, the free encyclopedia"
    And the URL should contain "/wiki/Bagel"
```

```console
$ jevcumber examples/
Feature: Wikipedia search
  Scenario: Looking up bagels
    ✓ Given I am on https://en.wikipedia.org
    ✓ When I search for "bagel"
    ✓ Then I should see "From Wikipedia, the free encyclopedia"
    ✓ Then the URL should contain "/wiki/Bagel"

1 scenarios (1 passed) · 4 steps (4 passed)
```

That's the whole test. There is no glue code behind it.

## How it works

jevcumber opens your site in a real browser with [Playwright](https://playwright.dev) and, for each
Gherkin step, asks [Jev](https://docs.typesafe.ai) — TypeSafe AI's fast *System One* model — what the
step means **on the page in front of it**.

Jev never writes code or invents values. jevcumber lists what's actually there — the page's buttons,
fields and links, and the literal values in your step — and Jev *picks* among them:

| Your step | jevcumber asks | Jev picks |
| --- | --- | --- |
| `When I search for "bagel"` | what kind of action is this? | **fill** |
| | which control? `Search Wikipedia`, `Log in`, `Donate`… | **Search Wikipedia** |
| | which literal is the text to type? | **"bagel"** |
| | type only, or type and submit? | **submit** |

All of those questions go out in one request (about a second), each answer comes back with a
probability, and jevcumber performs the result with Playwright. If Jev isn't confident, jevcumber
**refuses to guess** and tells you what it was torn between:

```console
? When I click it (ambiguous)
    Jev was not confident about the element (0.10 < 0.6). Candidates: button "Log in" (45%),
    link "Sign up" (35%), none (20%). Reword the step to be more specific.
```

### The lockfile makes it deterministic

The first run records what each step resolved to in `<name>.feature.lock.json`, next to your feature.
**Commit it**, like a `package-lock.json`. After that:

- runs replay the lockfile — **no API calls, no API key, no model variance**;
- a step you add or reword is resolved on the next run, and only that step;
- if your UI changes and a recorded control disappears, the step is re-resolved and reported as
  healed (`↻`) — and the change shows up in the lockfile's diff for review.

## Try it in two minutes (no API key needed)

Requires Node.js 20+.

```bash
npm install -g jevcumber
jevcumber install-browser      # downloads the Chromium build jevcumber drives
```

This repo ships an example with its lockfile already recorded, so you can watch a replay without
signing up for anything:

```bash
git clone https://github.com/RubyBrewsday/jevcumber && cd jevcumber
jevcumber examples/ --frozen --headed
```

## Write your own

1. Get a TypeSafe API key (see the [TypeSafe quickstart](https://docs.typesafe.ai/introduction/quickstart))
   and export it:

   ```bash
   export TYPESAFE_API_KEY=...
   ```

2. Write a feature file anywhere — say `features/login.feature`:

   ```gherkin
   Feature: Login
     Scenario: successful login
       Given I am on https://myapp.example.com/login
       When I fill in the email field with "alice@example.com"
       And I fill in the password field with "correct horse"
       And I click the Log in button
       Then I should see "Welcome, alice"
   ```

3. Run it:

   ```bash
   jevcumber features/            # add --headed to watch
   ```

4. Commit `features/login.feature.lock.json`. In CI, run `jevcumber features/ --frozen` — no key needed.

## CLI

```
jevcumber <paths...> [options]
```

| Option | |
| --- | --- |
| *(no flags)* | Replay the lockfile; resolve new or changed steps with Jev; heal steps whose control has gone. |
| `--frozen` | Replay only. Never calls Jev, never writes the lockfile. A missing or stale entry fails. **Use in CI.** |
| `--update` | Ignore the lockfile and re-resolve every step. |
| `--base-url <url>` | What paths like `"/login"` resolve against. Not needed when steps use full URLs. |
| `--headed` | Show the browser. |
| `--tags <expr>` | Cucumber tag expression, e.g. `"@smoke and not @wip"`. |
| `--report-dir <dir>` | Where failure evidence goes (default `jevcumber-report`). `--no-report` disables it. |
| `--trace` | Record a Playwright trace per scenario; keep it for scenarios that did not pass. |
| `--min-confidence <n>` | Refuse to act below this confidence (default `0.6`; page-sourced values need `0.75`). |
| `--workers <n>` | Number of scenarios to run concurrently (default: available CPUs, or `1` with `--headed`). |
| `--config <path>` | Path to `jevcumber.config.js`/`.mjs` (default: the nearest one found walking up from the cwd). |
| `--reporter <name>` | Reporter to use: `console` (default), `json`, or `junit`. Repeatable to run several at once. |
| `--output <file>` | Output file for the `json`/`junit` reporters (default: `results.json`/`results.xml` under `--report-dir`). |

Exit code is `1` if any step failed, was ambiguous, or was undefined.

Runs are **parallel by default**, one worker per scenario up to `--workers` (which defaults to your
CPU count): pass `--workers 1` to run serially, and `--headed` always implies `1` since it drives a
single visible browser window. Console output for a scenario is printed as a whole block as soon as
that scenario finishes, so scenarios never interleave in the log even when several run at once.

### Config file

Drop a `jevcumber.config.js` (or `.mjs`) next to your features, or anywhere above the directory you
run jevcumber from — it's found by walking up from the current directory, and `--config <path>`
overrides the search. Any value it sets is a default: the matching CLI flag, when passed, always wins.

```js
// jevcumber.config.js
export default {
  baseUrl: 'http://localhost:3000',
  workers: 4,
  tags: '@smoke and not @wip',
  minConfidence: 0.6,
  reportDir: 'jevcumber-report',
  hooks: {
    async beforeScenario({ page, scenario, baseUrl }) {
      // runs once per scenario, before its first step
      await page.setDefaultTimeout(5000);
    },
    async afterScenario({ page, scenario, baseUrl, results }) {
      // runs once per scenario, after its last step; `results` are that scenario's step results
    },
  },
};
```

A `beforeScenario` that throws fails the scenario outright (its steps are all skipped, and Jev is
never called); an `afterScenario` that throws is reported as a failed step appended to the scenario.

Backgrounds, Scenario Outlines, data tables, doc strings, `And`/`But`, and tags all work — parsing is
done by the official `@cucumber/gherkin`.

## Writing steps Jev can resolve

- **Put data in quotes.** Jev selects values, it never invents them:
  `I fill in the email field with "alice@example.com"`.
- **Navigate with a literal URL or path.** `Given I am on https://example.com/login`,
  `Given I am on example.com/login` (`https://` assumed), `Given I am on localhost:3000` (`http://`
  assumed) — or `Given I am on "/login"` together with `--base-url`, which keeps features portable
  across environments. A path is resolved from the base URL's host root. "Given I am on the login
  page" gives jevcumber nothing to select from.
- **Name controls as they appear on the page:** "the Log in button", "the email field", or quoted:
  `I click "Log in"`.
- **"Search for", "submit", "look up" type *and* press Enter.** `When I search for "bagels"` fills the
  field and submits it; `When I fill in the search box with "bagels"` only types.
- **Two kinds of `Then`.** Quoted text, a named control, or a URL fragment becomes a fast Playwright
  assertion that is cached and replayed: `Then I should see "Welcome"`, `Then the "Save" button is
  visible`, `Then the URL should contain "/todos"`. A *described* expectation —
  `Then I see an article about bagels` — is judged by Jev on the first run and then **pinned** to
  the page title or a heading (the article's heading or the page title): later runs replay that as a
  plain check, frozen or not. Only expectations with no single piece of evidence ("the list is sorted
  by date"), or whose best evidence is a link or button name rather than a title or heading, stay
  live-judged, and those need the key and can't run under `--frozen`. A replayed pinned step that
  fails is re-judged live on a normal run — a real regression fails, a heading rewrite heals — but
  never under `--frozen`, where a failing pin is just a failure.
- **Values can be described, not just quoted.** `When I fill in the new todo with the greeting on the
  page` picks the text from the page's headings and links. Because the step gave less, jevcumber asks
  for higher confidence (0.75) before acting on a page-sourced value. Page-sourced values are fixed
  in the lockfile the first time they resolve; if the page text changes, re-run with `--update`.
- **An empty literal is ignored**, so a step can't clear a field with `""`.

What a step can do today: navigate, click, fill (optionally submitting), clear a field, select from a
dropdown (by label, by value, or by a 1-based index — "the 2nd option" selects `index: 1`),
check/uncheck, press a key, hover, scroll a named element into view (page-level scrolling is not
supported), upload a file (`I upload "photo.png" as the avatar` — the path is relative to the feature
file; a hidden file input styled behind a button can't be targeted yet), wait (`I wait for "Done" to
appear`, `I wait 3 seconds`, `I wait for the page to settle`), and assert.

## When a step fails

For every step that fails, is ambiguous, or is undefined, jevcumber writes what it saw to
`jevcumber-report/<feature>/<scenario>/<n>-<status>/`: `screenshot.png` (full page) and
`snapshot.json` (the page as Jev was shown it — elements, evidence, text), and prints the path under
the step. `--report-dir <dir>` moves it, `--no-report` turns it off, and `--trace` also records a
Playwright trace per scenario, keeping `trace.zip` only for scenarios that did not pass (open it with
`npx playwright show-trace trace.zip`); `--no-report` only disables the screenshot/snapshot, so
`--trace` combined with `--no-report` still writes `trace.zip` under `--report-dir` (or the default
`jevcumber-report` directory when `--report-dir` isn't given).

## Some sites block automated browsers

Google, for one, answers a scripted search with a "prove you're not a robot" page — and jevcumber
will correctly report that your results aren't there. jevcumber doesn't try to evade bot detection.
Test your own app, or sites that permit automation.

## What is sent to TypeSafe

For each step that is **not** replayed from the lockfile, jevcumber sends Jev: the step text and its
literals, the scenario name and earlier step texts, the page URL and title, the page's interactive
elements (role, name, current value — **never the value of a password field**), and up to 8 000
characters of visible page text. Page headings and link/button names are also sent as evidence — to
judge and pin a described `Then`, and as page-text candidates for a described value or target.

Literals in your steps — including a password you write in a step — live in your `.feature` file and
are stored in the lockfile too, so use throwaway test credentials. Under `--frozen`, nothing is sent
anywhere.

## CI example (GitHub Actions)

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npm install -g jevcumber
- run: jevcumber install-browser --with-deps
- run: jevcumber features/ --frozen --base-url http://localhost:3000
```

## Limits (v0.1)

Scenarios run sequentially. No hooks, iframes, drag and drop, or multi-tab flows yet. A hidden file
input styled behind a button can't be targeted for upload yet either.
One action per step. Web UIs only.

## Development

```bash
git clone https://github.com/RubyBrewsday/jevcumber && cd jevcumber
npm install && npx playwright install chromium
npm test                          # unit + end-to-end against a fixture app; no API key needed
TYPESAFE_API_KEY=... npm test     # also runs the live tests against Jev
npm run jevcumber -- examples/    # build, then run the CLI from source
```

(`tsx src/cli.ts` doesn't work — the transpiler injects a helper into the script Playwright evaluates
in the page. Use the built CLI.)

The layout is one small module per job under `src/`: `gherkin` → `snapshot` + `candidates` →
`resolver` (the only module that talks to Jev) → `lockfile` → `executor` → `reporter`, orchestrated
by `runner`. The design doc is in [`docs/superpowers/specs`](docs/superpowers/specs).

### The website

[jevcumber.dev](https://jevcumber.dev) is the single static page in `site/`, served by a Cloudflare Worker
(`wrangler.jsonc`, `site-worker/index.js`) that also redirects jevcumber.com and the `www.` hosts to
jevcumber.dev and answers byte-range requests for the demo video. Deploy with `npm run deploy:site`
(needs `npx wrangler login` first).

### Tuning the questions Jev is asked

`e2e/resolve-eval.test.ts` asks Jev about every fixture step on the page that step really sees,
compares the answer with the known-good resolution in `fixtures/expected.ts`, and prints every
answer's probability distribution:

```bash
npx vitest run e2e/resolve-eval.test.ts --silent=false --reporter=verbose
```

When a kind of step resolves badly: add a scenario for it to the fixtures, watch it miss, then adjust
the wording in `src/resolver.ts`. Don't paste the fixture's own sentence into a question's examples.

## License

[MIT](LICENSE) © Mike Poage. Not affiliated with TypeSafe AI or the Cucumber project.
