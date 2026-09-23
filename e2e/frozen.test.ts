import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('install-browser drives the bundled Playwright installer', async () => {
    // --dry-run makes Playwright print what it would install without downloading anything.
    expect(await main(['install-browser', '--dry-run'])).toBe(0);
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
});
