---
name: jevcumber
description: >
  Set up jevcumber in a project and write browser tests as plain Cucumber/Gherkin .feature files —
  no step definitions, no selectors, no page objects. Use this whenever someone wants an end-to-end
  or UI test for a web page or flow (login, search, forms, "check the page shows X"), mentions
  Cucumber, Gherkin, BDD, feature files, or jevcumber, wants browser tests "without writing code",
  or asks to install/configure jevcumber — even if they don't name it. Covers install and upgrade,
  browser and API-key setup, writing steps Jev can resolve, reading ambiguous/undefined results,
  the lockfile, and CI with --frozen and explain. Not for Playwright/Cypress/Selenium code with
  hand-written selectors, unit or component tests, load tests, or writing cucumber-js step
  definitions for non-browser code — those need something else.
license: MIT
---

# jevcumber

jevcumber runs a `.feature` file against a real browser. For each step it lists what is actually
on the page (buttons, fields, links, headings) and the literal values in the step, and asks Jev —
TypeSafe AI's fast System One model — to *pick* among them. Jev never invents a selector or a
value: the words in the step are all it has to choose with. Everything below follows from that.

Live docs: https://jevcumber.dev · verified phrasings: https://jevcumber.dev/cookbook ·
README: https://github.com/RubyBrewsday/jevcumber#readme

## Part 1 — Set up jevcumber (do this first, every time)

Don't assume jevcumber is installed or current. Check, then fix what's missing:

1. **Version.** `npx --no-install jevcumber --version` (project) or `jevcumber --version`
   (global). Need **0.2.0 or newer**: older builds lack `explain`, `--record-eval`, parallel runs
   and pinned expectations, so the rest of this skill won't match what the tool does. No output or
   an older version → install/upgrade.
2. **Install into the project** (preferred — CI gets the same version):
   ```bash
   npm install -D jevcumber          # then run it as: npx jevcumber …
   ```
   Global (`npm install -g jevcumber@latest`) is fine for a quick trial; if a stale global copy
   shadows the project one, prefer `npx jevcumber`. Node 20+ is required.
3. **Browser.** `npx jevcumber install-browser` downloads the Chromium build matching the bundled
   Playwright (in CI: `--with-deps`). Skip if it's already there — a run that fails with
   "Executable doesn't exist" tells you to run this.
4. **API key.** Resolving *new* steps calls Jev; replaying the lockfile does not. Check
   `[ -n "$TYPESAFE_API_KEY" ]`. If it's missing, tell the user to get one at
   https://docs.typesafe.ai/introduction/quickstart and export it in their shell profile
   (`export TYPESAFE_API_KEY=…`). Never write the key into a file in the repo, a script, a config,
   or a commit, and never ask the user to paste it into the chat — you don't need to see it.
5. **Repo hygiene.** Add `jevcumber-report/` to `.gitignore` (screenshots/traces of failures);
   lockfiles (`*.feature.lock.json`) are **committed**, like `package-lock.json`. Add scripts:
   ```json
   "test:e2e": "jevcumber features/",
   "test:e2e:ci": "jevcumber explain features/ && jevcumber features/ --frozen"
   ```
6. **Smoke test** before writing real features: put a two-step feature in `features/`
   (`Given I am on <the app url>` / `Then I should see "<text you know is on that page>"`) and
   run `npx jevcumber features/ --headed`. Two ✓ lines means the install, browser and key all work.

If the app needs a `--base-url` (features use paths like `"/login"`), put it and any hooks in
`jevcumber.config.mjs` so nobody has to remember flags:

```js
export default {
  baseUrl: 'http://localhost:3000',
  hooks: { async beforeScenario({ page }) { /* seed data, log in once, … */ } },
};
```

## Part 2 — Write features Jev can resolve

Ordinary Gherkin, one action or one check per step. Put files under `features/`, one scenario per
user journey, each starting from a URL; scenarios run in parallel, so keep them independent.

- **Go somewhere with a literal URL or path.** `Given I am on https://myapp.test/login`, or
  `Given I am on "/login"` with a base URL (paths resolve from the host root). *"Given I am on the
  login page"* gives Jev nothing to select — it comes back undefined.
- **Put data in quotes.** `When I fill in the email field with "alice@example.com"`. A value that
  isn't quoted isn't a candidate. Use throwaway test credentials: literals end up in the lockfile.
- **Name controls as the page shows them** — visible label, button text, link text, placeholder:
  `the Log in button`, `the "Search" field`, `I click "Sign out"`. jevcumber sees roles and names,
  not ids or CSS.
- **"search for / submit / look up" type and press Enter**; "fill in / type / enter" only type.
- **A value or target can be described when it's on the page:** `I click the link that signs me
  out`, `I fill in the new todo with the greeting on the page`. Jev picks from the page's headings
  and link names at a higher confidence bar — use it when quoting is impossible, not by default.
- **Two kinds of `Then`.** Quoted text, a named control, or a URL fragment becomes a plain
  Playwright check, cached and replayed: `Then I should see "Welcome, alice"`, `Then the "Save"
  button is visible`, `Then the URL should contain "/todos"`, `Then I should not see "Error"`. A
  *described* expectation — `Then I see an article about bagels` — is judged by Jev once, then
  **pinned** to the page title or heading that showed it, so it also replays without the API.
  Only expectations no title/heading can evidence ("the list is sorted by date") stay live-judged;
  those need the key and fail under `--frozen`. Prefer quoted checks.
- **Other actions:** check/uncheck a box; choose from a dropdown by option text, value, or 1-based
  position (`I choose the 2nd option in the Size dropdown`); press a key (`I press Enter in the
  search field`); hover; clear a field; scroll to an element; upload a file (`I upload "photo.png"
  as the avatar`, path relative to the feature file); wait (`I wait for "Done" to appear`,
  `I wait 3 seconds`, `I wait for the page to settle`).
- Backgrounds, Scenario Outlines, tables, doc strings and tags all work.

When unsure of a phrasing, copy a shape from https://jevcumber.dev/cookbook — every row there is
verified against Jev in jevcumber's own test suite.

```gherkin
Feature: Login

  Scenario: successful login
    Given I am on "/login"
    When I fill in the email field with "alice@example.com"
    And I fill in the password field with "correct horse"
    And I click the Log in button
    Then I should see "Welcome, alice"
    And the URL should contain "/todos"

  Scenario: wrong password
    Given I am on "/login"
    When I fill in the email field with "alice@example.com"
    And I fill in the password field with "wrong"
    And I click the Log in button
    Then I should see "Invalid email or password"
    And I should not see "Welcome"
```

## Part 3 — Run, read, fix, commit

1. `npx jevcumber features/login.feature --headed` and watch.
2. Read every non-✓ line and fix the **wording**, not the tool:
   - `? … (ambiguous)` — Jev wasn't confident; the line lists what it was torn between. Name the
     control the way the page does, or quote the value.
   - `? … (undefined)` — nothing on the page matched, or the step needed a value it didn't give.
     The message says which. Also check you're on the page you think you are (a login wall, a
     redirect, a "not a robot" page — jevcumber won't evade bot detection).
   - `✗ …` — it resolved fine and the check *failed*. Open `evidence: jevcumber-report/…`
     (screenshot + the page as Jev saw it) before touching the step: the app may really be wrong.
   - `↻ … (healed — lockfile updated)` — the cached control had gone; jevcumber re-resolved it.
     Look at the lockfile diff to confirm it picked the right thing.
3. Commit the feature **and** `features/login.feature.lock.json`. Later runs replay it with no
   API calls; change a step and only that step is re-resolved.
4. In CI run `npm run test:e2e:ci`: `explain` fails if any step lacks a lockfile entry (someone
   forgot to commit it), and `--frozen` never calls Jev, so no key is needed there.

Exit code is 1 if any step failed, was ambiguous, or was undefined.

## Handy flags

`--headed` watch (one worker) · `--base-url <url>` · `--frozen` replay only (CI) · `--update`
re-resolve everything · `--workers N` · `--tags "@smoke and not @wip"` · `--reporter json|junit`
(+ `--output <file>`) · `--trace` keep a Playwright trace for failing scenarios ·
`--record-eval <dir>` save exactly what Jev saw and answered · `jevcumber explain <paths>` show
what each step resolves to, from the lockfile, no browser.

## When a sound step keeps misresolving

Reword first (quote the value; use the control's visible name). If it still resolves wrongly, run
with `--record-eval ./jev-eval`, and attach the recorded JSON to an issue at
https://github.com/RubyBrewsday/jevcumber/issues — it holds exactly what Jev was shown. Don't
commit those recordings: they contain page text.
