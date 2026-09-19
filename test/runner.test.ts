import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lockfile, stepKey } from '../src/lockfile.js';
import { runScenario, type ScenarioDeps } from '../src/runner.js';
import type { ResolveOutcome, ResolvedStep, Scenario } from '../src/types.js';

const scenario: Scenario = {
  uri: 'a.feature', feature: 'A', name: 's', occurrence: 0, tags: [],
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

  it('treats a throwing isValid as stale rather than letting it escape', async () => {
    const healing = harness({ isValid: async () => { throw new Error('Execution context was destroyed'); } }, { 0: nav('/stale') });
    const healingResults = await runScenario(scenario, healing.deps);
    expect(healingResults[0].status).toBe('healed');

    const frozen = harness(
      { mode: 'frozen', isValid: async () => { throw new Error('Execution context was destroyed'); } },
      { 0: nav('/stale') },
    );
    const frozenResults = await runScenario(scenario, frozen.deps);
    expect(frozen.calls.resolve).toEqual([]);
    expect(frozenResults[0]).toMatchObject({ status: 'failed' });
    expect(frozenResults[0].detail).toMatch(/stale/i);
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

  it('does not prune the lockfile entry of a step that fails to resolve in update mode', async () => {
    const { lock: seeded, path } = harness({}, { 0: nav('/one'), 1: nav('/two'), 2: nav('/three') });
    seeded.save(false);
    // Reload so the lockfile starts with nothing touched, as a fresh run would see it
    // (harness's seeding via lock.set already marks entries touched, which would mask this bug).
    const lock = Lockfile.load(path);
    const deps: ScenarioDeps = {
      mode: 'update',
      lock,
      resolve: async (step) =>
        step.text === 'two' ? { ok: false, reason: 'ambiguous', detail: 'which one?' } : ok(nav(`/${step.text}`)),
      isValid: async () => true,
      execute: async () => {},
    };
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
