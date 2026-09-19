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
