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
  occurrence: 0,
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

  it('distinguishes scenarios with the same name, index, and text by occurrence', () => {
    expect(stepKey({ ...scenario, occurrence: 1 }, 0)).not.toBe(stepKey(scenario, 0));
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
