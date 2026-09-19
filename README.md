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
    Given I am on https://myapp.example.com/login
    When I fill in the email field with "alice@example.com"
    And I fill in the password field with "secret"
    And I click the Log in button
    Then I should see "Welcome, alice"
```

```bash
npx playwright install chromium
export TYPESAFE_API_KEY=...
npx jevcumber features/
```

Steps can name full URLs (`https://…`, `example.com/pricing`, `localhost:3000/login`), quoted or not.
To keep features portable across environments, write paths instead — `Given I am on "/login"` —
and say where they live with `--base-url http://localhost:3000`.

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
- **Navigate with a literal URL or path:** `Given I am on https://example.com/login` or
  `Given I am on "/login"` (with `--base-url`), not "the login page".
- **Name controls as they appear on the page:** "the Log in button", "the email field".
- `Then` steps with quoted text become fast, cached Playwright assertions. Descriptive
  expectations ("Then I see a friendly error") are judged live by Jev each run, so they
  need the API key and can't run under `--frozen`.
- **Paths resolve against `--base-url`.** `"/login"` is an absolute path from the base URL's
  host root, not relative to the current page. Without `--base-url` a path step fails and tells
  you so. A bare domain gets `https://`; `localhost` and IP addresses get `http://`.
- **"Search for", "submit", "look up" type and press Enter.** `When I search for "bagels"` fills the
  field and submits it; `When I fill in the search box with "bagels"` only types.
- **Some sites block automated browsers.** Google, for one, answers a scripted search with a
  "prove you're not a robot" page, and jevcumber will (correctly) report that your results aren't
  there. Test your own app, or sites that permit automation.
- **An empty literal is ignored.** `""` never becomes the value for a step, so a step
  can't be used to clear a field — quote the actual value you want typed instead.

If Jev isn't confident, jevcumber won't guess: the step is reported as **ambiguous**
with the top candidates, or **undefined** if nothing on the page matches. Reword and rerun.

## What is sent to TypeSafe

For each step that isn't replayed from the lockfile, jevcumber sends Jev: the step's
text and its extracted literals; the scenario name and the text of previous steps;
the page's URL and title; the list of interactive elements on the page (role, name,
and current value — **never** a password field's value); and up to 8 000 characters
of the page's visible text. Literals — including a password written directly in a
step — are also stored in the lockfile alongside the resolution. Under `--frozen`,
nothing is sent: every step replays from the lockfile.

## Limits (v0.1)

Sequential scenarios; no hooks, iframes, file uploads, drag and drop, or multi-tab flows.

## Development

```bash
npm install && npx playwright install chromium
npm test            # unit + frozen e2e (no API key needed)
TYPESAFE_API_KEY=... npm test   # also runs the live smoke test and the resolver eval
```

`npm run jevcumber -- features/ --base-url http://localhost:3000` builds first and
runs the compiled `dist/cli.js`. Running `tsx src/cli.ts` directly does not work:
tsx/esbuild's `keepNames` rewrites the function passed to `page.evaluate` in
`snapshot.ts` to call a helper that doesn't exist inside the page, so it crashes on
the first snapshot.

### Tuning the questions Jev is asked

`e2e/resolve-eval.test.ts` asks Jev about every step in `fixtures/features/` on the page that step
really sees and compares the answer with the known-good resolution in `fixtures/expected.ts`. Run it
verbosely to see every answer's probability distribution:

```bash
npx vitest run e2e/resolve-eval.test.ts --silent=false --reporter=verbose
```

When a kind of step resolves badly, add a scenario for it to the fixture, watch it miss, then adjust
the wording in `src/resolver.ts`. Don't paste the fixture's own sentence into a question's examples.
