import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
