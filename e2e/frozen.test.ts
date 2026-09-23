import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from '../fixtures/app/server.js';
import { main } from '../src/cli.js';
import { parseFeature } from '../src/gherkin.js';
import { lockPathFor, stepKey } from '../src/lockfile.js';
import { RESOLVED, sees } from '../fixtures/expected.js';
import type { ResolvedStep } from '../src/types.js';

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
    expect(await main([dir, '--frozen'])).toBe(1); // relative "/login" with no --base-url to resolve against
  });

  it('replays a pinned expectation under --frozen as a plain text check', async () => {
    const { dir } = workspace({
      'I should see "Welcome, alice"': { kind: 'assert', assertion: { form: 'text_visible', value: 'Welcome, alice', pinned: true } },
    });
    expect(await main([dir, '--base-url', server.url, '--frozen'])).toBe(0);
  });

  it('needs no --base-url when steps name full URLs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-e2e-'));
    const feature = join(dir, 'absolute.feature');
    const steps = [`Given I am on ${server.url}/login`, 'Then I should see "Sign in"'];
    writeFileSync(feature, `Feature: Absolute\n  Scenario: full URL\n    ${steps[0]}\n    ${steps[1]}\n`);
    const [scenario] = parseFeature(readFileSync(feature, 'utf8'), feature);
    const resolved: ResolvedStep[] = [{ kind: 'navigate', value: `${server.url}/login` }, sees('Sign in')];
    const entries = Object.fromEntries(
      scenario.steps.map((step, index) => [stepKey(scenario, index), { text: step.text, resolved: resolved[index] }]),
    );
    writeFileSync(lockPathFor(feature), JSON.stringify({ version: 1, steps: entries }, null, 2));

    expect(await main([dir, '--frozen'])).toBe(0);
  });

  it('resolves an upload step\'s file against the feature file\'s directory, not the cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-e2e-'));
    const feature = join(dir, 'avatar.feature');
    copyFileSync('fixtures/eval/avatar.png', join(dir, 'avatar.png'));
    writeFileSync(
      feature,
      [
        'Feature: Avatar upload',
        '  Scenario: upload avatar',
        '    Given I am on "/login"',
        '    When I fill in the email field with "alice@example.com"',
        '    And I fill in the password field with "secret"',
        '    And I click the Log in button',
        '    And I upload "avatar.png" as the avatar',
        '    Then I should see "Welcome, alice"',
        '',
      ].join('\n'),
    );
    const [scenario] = parseFeature(readFileSync(feature, 'utf8'), feature);
    const email: ResolvedStep = { kind: 'fill', locator: { by: 'role', role: 'textbox', name: 'Email' }, value: 'alice@example.com' };
    const password: ResolvedStep = { kind: 'fill', locator: { by: 'label', value: 'Password' }, value: 'secret' };
    const logIn: ResolvedStep = { kind: 'click', locator: { by: 'role', role: 'button', name: 'Log in' } };
    const upload: ResolvedStep = { kind: 'upload', locator: { by: 'label', value: 'Avatar' }, value: 'avatar.png' };
    const resolved: ResolvedStep[] = [{ kind: 'navigate', value: '/login' }, email, password, logIn, upload, sees('Welcome, alice')];
    const entries = Object.fromEntries(
      scenario.steps.map((step, index) => [stepKey(scenario, index), { text: step.text, resolved: resolved[index] }]),
    );
    writeFileSync(lockPathFor(feature), JSON.stringify({ version: 1, steps: entries }, null, 2));

    expect(await main([dir, '--base-url', server.url, '--frozen'])).toBe(0);
  });

  it('install-browser drives the bundled Playwright installer', async () => {
    // --dry-run makes Playwright print what it would install without downloading anything.
    expect(await main(['install-browser', '--dry-run'])).toBe(0);
  });

  it('writes a screenshot and snapshot for a failed step', async () => {
    const { dir } = workspace({ 'I should see "Welcome, alice"': sees('Welcome, bob') });
    const reportDir = join(dir, 'report');
    expect(await main([dir, '--base-url', server.url, '--frozen', '--report-dir', reportDir])).toBe(1);
    const stepDir = join(reportDir, 'login', 'successful-login', '5-failed');
    expect(existsSync(join(stepDir, 'screenshot.png'))).toBe(true);
    // Under --frozen every step replays from the lockfile, so `resolve()` (where the last Jev
    // snapshot is normally captured) is never called; onStep falls back to taking a fresh
    // snapshot of the page as it stands when the step failed.
    const snapshotJson = JSON.parse(readFileSync(join(stepDir, 'snapshot.json'), 'utf8'));
    expect(snapshotJson).toMatchObject({ url: expect.any(String), elements: expect.any(Array) });
  });

  it('--no-report writes nothing', async () => {
    const { dir } = workspace({ 'I should see "Welcome, alice"': sees('Welcome, bob') });
    const reportDir = join(dir, 'report');
    expect(await main([dir, '--base-url', server.url, '--frozen', '--report-dir', reportDir, '--no-report'])).toBe(1);
    expect(existsSync(reportDir)).toBe(false);
  });

  it('--trace keeps a trace for a failed scenario only', async () => {
    const { dir } = workspace({ 'I should see "Welcome, alice"': sees('Welcome, bob') });
    const reportDir = join(dir, 'report');
    expect(await main([dir, '--base-url', server.url, '--frozen', '--report-dir', reportDir, '--trace'])).toBe(1);
    expect(existsSync(join(reportDir, 'login', 'successful-login', 'trace.zip'))).toBe(true);
    expect(existsSync(join(reportDir, 'login', 'adding-a-todo-after-logging-in', 'trace.zip'))).toBe(false);
  });

  it('rejects a non-absolute --base-url at parse time, before touching the browser', async () => {
    const { dir } = workspace();
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main([dir, '--base-url', 'not-a-url', '--frozen'])).toBe(1);
      expect(errors.mock.calls.flat().join('\n')).toMatch(/absolute URL/);
    } finally {
      errors.mockRestore();
    }
  });

  it('runs scenarios in parallel workers and prints one block per scenario', async () => {
    const { dir, feature } = workspace();
    const scenarios = parseFeature(readFileSync(feature, 'utf8'), feature);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      logs.push(String(line ?? ''));
    });
    try {
      expect(await main([dir, '--base-url', server.url, '--frozen', '--workers', '2'])).toBe(0);
    } finally {
      spy.mockRestore();
    }

    // Split the captured lines into per-scenario blocks: a "  Scenario:" line starts a new block
    // and every subsequent indented step line (four-space indent, then a status mark) belongs to it.
    const blocks: { name: string; lines: string[] }[] = [];
    for (const line of logs) {
      const match = /^ {2}Scenario: (.+)$/.exec(line);
      if (match) {
        blocks.push({ name: match[1], lines: [] });
      } else if (blocks.length > 0 && /^ {4}[✓↻✗?-] /.test(line)) {
        blocks[blocks.length - 1].lines.push(line);
      }
    }

    // Parallel workers finish in whatever order they finish in: match blocks to scenarios by
    // name (set equality), not by position, and check each block's own steps against its own
    // scenario rather than assuming block i belongs to scenarios[i].
    expect(blocks.map((b) => b.name).sort()).toEqual(scenarios.map((s) => s.name).sort());
    for (const block of blocks) {
      const scenario = scenarios.find((s) => s.name === block.name);
      expect(scenario, `no scenario named "${block.name}"`).toBeDefined();
      const actualTexts = block.lines.map((line) => line.replace(/^ {4}[✓↻✗?-] \w+ /, '').replace(/ \([^)]*\)$/, ''));
      expect(actualTexts).toEqual(scenario!.steps.map((s) => s.text));
    }
  });

  it('reads defaults and hooks from jevcumber.config.mjs', async () => {
    const { dir, feature } = workspace();
    const scenarios = parseFeature(readFileSync(feature, 'utf8'), feature);
    const marker = join(dir, 'scenarios.log');
    writeFileSync(
      join(dir, 'jevcumber.config.mjs'),
      [
        "import { appendFileSync } from 'node:fs';",
        'export default {',
        `  baseUrl: ${JSON.stringify(server.url)},`,
        '  hooks: {',
        '    beforeScenario({ page, scenario }) {',
        '      page.setDefaultTimeout(5000);',
        `      appendFileSync(${JSON.stringify(marker)}, scenario.name + '\\n');`,
        '    },',
        '  },',
        '};',
        '',
      ].join('\n'),
    );

    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await main([dir, '--frozen'])).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    const seen = readFileSync(marker, 'utf8').trim().split('\n').sort();
    expect(seen).toEqual(scenarios.map((s) => s.name).sort());
  });

  it('a --base-url passed on the CLI wins over jevcumber.config.mjs', async () => {
    const { dir } = workspace();
    writeFileSync(join(dir, 'jevcumber.config.mjs'), 'export default { baseUrl: "http://wrong.invalid" };\n');

    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await main([dir, '--base-url', server.url, '--frozen'])).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('--reporter json and junit write files', async () => {
    const { dir } = workspace();
    const reportDir = join(dir, 'r');
    expect(
      await main([dir, '--base-url', server.url, '--frozen', '--reporter', 'json', '--reporter', 'junit', '--report-dir', reportDir]),
    ).toBe(0);

    const json = JSON.parse(readFileSync(join(reportDir, 'results.json'), 'utf8'));
    expect(json).toHaveLength(1);
    expect(json[0].name).toBe('Login');

    const xml = readFileSync(join(reportDir, 'results.xml'), 'utf8');
    expect(xml).toContain('<testsuite name="Login"');
  });

  it('rejects an unknown --reporter name at parse time, before touching the browser', async () => {
    const { dir } = workspace();
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main([dir, '--base-url', server.url, '--frozen', '--reporter', 'xml'])).toBe(1);
      expect(errors.mock.calls.flat().join('\n')).toMatch(/unknown reporter "xml"/);
    } finally {
      errors.mockRestore();
    }
  });

  it('de-duplicates repeated --reporter names', async () => {
    const { dir } = workspace();
    const reportDir = join(dir, 'r');
    expect(
      await main([dir, '--base-url', server.url, '--frozen', '--reporter', 'json', '--reporter', 'json', '--report-dir', reportDir]),
    ).toBe(0);
    const json = JSON.parse(readFileSync(join(reportDir, 'results.json'), 'utf8'));
    expect(json).toHaveLength(1);
  });

  it('rejects --output when more than one file reporter is selected', async () => {
    const { dir } = workspace();
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(
        await main([dir, '--base-url', server.url, '--frozen', '--reporter', 'json', '--reporter', 'junit', '--output', join(dir, 'out')]),
      ).toBe(1);
      expect(errors.mock.calls.flat().join('\n')).toMatch(/--output applies to a single file reporter; use --report-dir for several/);
    } finally {
      errors.mockRestore();
    }
  });

  it('warns to stderr when --output is given with only the console reporter, but still runs', async () => {
    const { dir } = workspace();
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main([dir, '--base-url', server.url, '--frozen', '--output', join(dir, 'out')])).toBe(0);
      expect(errors.mock.calls.flat().join('\n')).toMatch(/--output/);
    } finally {
      errors.mockRestore();
    }
  });
});
