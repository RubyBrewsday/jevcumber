import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lockfile, stepKey } from '../src/lockfile.js';
import { runAll, runScenario, type Reporter, type ScenarioDeps } from '../src/runner.js';
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
  const defaultExecute: ScenarioDeps['execute'] = async () => undefined;
  const rawExecute = overrides.execute ?? defaultExecute;
  const deps: ScenarioDeps = {
    mode: 'default',
    lock,
    resolve: async (step) => {
      calls.resolve.push(step.text);
      return ok(nav(`/${step.text}`));
    },
    isValid: async () => true,
    ...overrides,
    execute: async (resolved, step) => {
      calls.execute.push(resolved);
      return rawExecute(resolved, step);
    },
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

  it('pins a described expectation: writes the pinned assertion to the lockfile and notes it', async () => {
    const semantic: ResolvedStep = { kind: 'assert', assertion: { form: 'semantic' } };
    const pinned = { form: 'text_visible', value: 'Michelle Obama', pinned: true } as const;
    const { deps, lock } = harness({
      resolve: async () => ({ ok: true, resolved: semantic, confidence: 0.9 }),
      execute: async (r) => (r.kind === 'assert' && r.assertion.form === 'semantic' ? { pinned } : undefined),
    });
    const results = await runScenario(scenario, deps);
    expect(results[0]).toEqual({ step: scenario.steps[0], status: 'passed', note: 'pinned to "Michelle Obama"' });
    expect(lock.get(stepKey(scenario, 0))).toEqual({ kind: 'assert', assertion: pinned });
  });

  it('re-judges a failing pinned assertion and heals it when the expectation still holds', async () => {
    const stale: ResolvedStep = { kind: 'assert', assertion: { form: 'text_visible', value: 'Old heading', pinned: true } };
    const fresh = { form: 'text_visible', value: 'New heading', pinned: true } as const;
    const { deps, lock, calls } = harness(
      {
        execute: async (r) => {
          if (r.kind === 'assert' && r.assertion.form === 'text_visible' && r.assertion.value === 'Old heading') throw new Error('not visible');
          if (r.kind === 'assert' && r.assertion.form === 'semantic') return { pinned: fresh };
          return undefined;
        },
      },
      { 0: stale },
    );
    const results = await runScenario(scenario, deps);
    expect(results[0]).toMatchObject({ status: 'healed', note: 'pinned to "New heading"' });
    expect(calls.resolve).toEqual(['two', 'three']);
    expect(lock.get(stepKey(scenario, 0))).toEqual({ kind: 'assert', assertion: fresh });
  });

  it('fails a pinned assertion outright under --frozen', async () => {
    const stale: ResolvedStep = { kind: 'assert', assertion: { form: 'text_visible', value: 'Old', pinned: true } };
    const { deps, calls } = harness({ mode: 'frozen', execute: async () => { throw new Error('not visible'); } }, { 0: stale });
    const results = await runScenario(scenario, deps);
    expect(results[0]).toMatchObject({ status: 'failed', detail: 'not visible' });
    expect(calls.execute).toHaveLength(1);
  });

  it('records the resolution confidence in the lockfile', async () => {
    const { deps, lock } = harness();
    await runScenario(scenario, deps);
    expect(lock.getEntry(stepKey(scenario, 0))?.confidence).toBe(0.9);
  });
});

describe('runAll', () => {
  it('returns no results without launching a browser or reporting a summary when there are no scenarios', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-')); // empty: no .feature files
    const calls: string[] = [];
    const reporter: Reporter = {
      scenarioStart: () => calls.push('scenarioStart'),
      step: () => calls.push('step'),
      end: () => calls.push('end'),
    };
    const results = await runAll({
      paths: [dir],
      baseUrl: 'http://localhost:1',
      mode: 'frozen',
      headed: false,
      minConfidence: 0.6,
      reporter,
    });
    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });
});
