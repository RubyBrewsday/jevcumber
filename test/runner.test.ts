import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { parseFeature } from '../src/gherkin.js';
import { Lockfile, lockPathFor, stepKey } from '../src/lockfile.js';
import * as resolverModule from '../src/resolver.js';
import { runAll, runScenario, type Reporter, type ScenarioDeps } from '../src/runner.js';
import type { ResolveOutcome, ResolvedStep, Scenario, ScenarioResult, StepResult } from '../src/types.js';

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

  it('strips ANSI escape sequences from a thrown error\'s message', async () => {
    const { deps } = harness({
      execute: async (_r, step) => {
        if (step.text === 'two') throw new Error('\u001b[2mexpect\u001b[22m(locator).toBeVisible()');
      },
    });
    const results = await runScenario(scenario, deps);
    expect(results[1].status).toBe('failed');
    expect(results[1].detail).toBe('expect(locator).toBeVisible()');
    expect(results[1].detail).not.toMatch(/\x1b/);
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

  it('passes the step index to onStep', async () => {
    const seen: number[] = [];
    const { deps } = harness({ onStep: (_r, index) => seen.push(index) });
    await runScenario(scenario, deps);
    expect(seen).toEqual([0, 1, 2]);
  });

  it('calls beforeStep at the start of every step, including a skipped one', async () => {
    let calls = 0;
    const { deps } = harness({
      beforeStep: () => { calls++; },
      resolve: async (step) => (step.text === 'two' ? { ok: false, reason: 'undefined', detail: 'nope' } : ok(nav('/x'))),
    });
    await runScenario(scenario, deps);
    // one → beforeStep, resolve; two → beforeStep, resolve (fails); three → beforeStep, skipped.
    expect(calls).toBe(3);
  });

  it('awaits an async onStep hook', async () => {
    const seen: string[] = [];
    const { deps } = harness({
      onStep: async (r) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        seen.push(r.status);
      },
    });
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
    expect(results[0]).toEqual({ step: scenario.steps[0], status: 'passed', note: 'pinned to "Michelle Obama"', durationMs: expect.any(Number) });
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

  it('fails a pinned assertion when the re-judge itself throws, combining both errors in the detail', async () => {
    const stale: ResolvedStep = { kind: 'assert', assertion: { form: 'text_visible', value: 'Old heading', pinned: true } };
    const { deps, calls } = harness(
      {
        execute: async (r) => {
          if (r.kind === 'assert' && r.assertion.form === 'text_visible') throw new Error('not visible');
          if (r.kind === 'assert' && r.assertion.form === 'semantic') throw new Error('Jev judged the expectation unmet (p=0.10)');
          return undefined;
        },
      },
      { 0: stale },
    );
    const results = await runScenario(scenario, deps);
    expect(results[0]).toMatchObject({ status: 'failed' });
    expect(results[0].detail).toBe('pinned check failed (not visible); re-judge: Jev judged the expectation unmet (p=0.10)');
    expect(calls.execute).toHaveLength(2); // the original pinned check, then the semantic re-judge
  });

  it('heals a pinned assertion to a live semantic check when the re-judge holds but finds no pin', async () => {
    const stale: ResolvedStep = { kind: 'assert', assertion: { form: 'text_visible', value: 'Old heading', pinned: true } };
    const { deps, lock } = harness(
      {
        execute: async (r) => {
          if (r.kind === 'assert' && r.assertion.form === 'text_visible') throw new Error('not visible');
          if (r.kind === 'assert' && r.assertion.form === 'semantic') return {}; // holds, but nothing to pin to
          return undefined;
        },
      },
      { 0: stale },
    );
    const results = await runScenario(scenario, deps);
    expect(results[0]).toMatchObject({ status: 'healed', note: 'no longer pinned: needs Jev under --frozen' });
    expect(lock.get(stepKey(scenario, 0))).toEqual({ kind: 'assert', assertion: { form: 'semantic' } });
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

  it('streams the synthetic beforeScenario hook failure through onStep at index -1', async () => {
    const seen: { result: StepResult; index: number }[] = [];
    const { deps } = harness({
      before: () => { throw new Error('boom'); },
      onStep: (result, index) => { seen.push({ result, index }); },
    });
    await runScenario(scenario, deps);
    expect(seen[0].index).toBe(-1);
    expect(seen[0].result).toMatchObject({ step: { text: 'beforeScenario hook' }, status: 'failed' });
  });

  it('streams the synthetic afterScenario hook failure through onStep at index steps.length', async () => {
    const seen: { result: StepResult; index: number }[] = [];
    const { deps } = harness({
      after: () => { throw new Error('cleanup failed'); },
      onStep: (result, index) => { seen.push({ result, index }); },
    });
    await runScenario(scenario, deps);
    const last = seen.at(-1)!;
    expect(last.index).toBe(scenario.steps.length);
    expect(last.result).toMatchObject({ step: { text: 'afterScenario hook' }, status: 'failed' });
  });

  it('a throwing before hook fails every step and never resolves', async () => {
    const { deps, calls, lock } = harness({
      before: () => {
        throw new Error('boom');
      },
    });
    const results = await runScenario(scenario, deps);
    expect(results).toEqual([
      { step: { keyword: 'Given', text: 'beforeScenario hook' }, status: 'failed', detail: 'beforeScenario hook: boom', durationMs: expect.any(Number) },
      { step: scenario.steps[0], status: 'skipped', durationMs: 0 },
      { step: scenario.steps[1], status: 'skipped', durationMs: 0 },
      { step: scenario.steps[2], status: 'skipped', durationMs: 0 },
    ]);
    expect(calls.resolve).toEqual([]);
    expect(lock.get(stepKey(scenario, 0))).toBeUndefined();
  });

  it('touches lockfile keys for steps skipped by a failing before hook', async () => {
    const { deps, lock, path } = harness(
      { before: () => { throw new Error('boom'); } },
      { 0: nav('/a'), 1: nav('/b'), 2: nav('/c') },
    );
    await runScenario(scenario, deps);
    lock.save(true);
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).steps)).toHaveLength(3);
  });

  it('awaits an after hook and passes it the results', async () => {
    let seen: unknown;
    const { deps } = harness({ after: (results) => { seen = results; } });
    const results = await runScenario(scenario, deps);
    expect(seen).toEqual(results);
  });

  it('appends a synthetic failed result when the after hook throws', async () => {
    const { deps } = harness({
      after: () => {
        throw new Error('cleanup failed');
      },
    });
    const results = await runScenario(scenario, deps);
    expect(results).toHaveLength(4);
    expect(results.slice(0, 3).map((r) => r.status)).toEqual(['passed', 'passed', 'passed']);
    expect(results[3]).toMatchObject({
      step: { keyword: 'Given', text: 'afterScenario hook' },
      status: 'failed',
      detail: 'afterScenario hook: cleanup failed',
    });
  });
});

describe('runAll', () => {
  it('returns no results without launching a browser or reporting a summary when there are no scenarios', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-')); // empty: no .feature files
    const calls: string[] = [];
    const reporter: Reporter = {
      scenarioStart: () => calls.push('scenarioStart'),
      step: () => calls.push('step'),
      scenarioEnd: () => calls.push('scenarioEnd'),
      end: () => calls.push('end'),
    };
    const results = await runAll({
      paths: [dir],
      baseUrl: 'http://localhost:1',
      mode: 'frozen',
      headed: false,
      minConfidence: 0.6,
      reporter,
      reportDir: 'jevcumber-report',
      report: true,
      trace: false,
      workers: 1,
    });
    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('continues the queue and keeps results in scenario order when one scenario crashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-'));
    const featurePath = join(dir, 'crash.feature');
    writeFileSync(
      featurePath,
      ['Feature: Crash', '  Scenario: first', '    Given I am on "about:blank"', '  Scenario: second', '    Given I am on "about:blank"', ''].join(
        '\n',
      ),
    );
    const featureScenarios = parseFeature(readFileSync(featurePath, 'utf8'), featurePath);
    const resolved: ResolvedStep = { kind: 'navigate', value: 'about:blank' };
    const entries = Object.fromEntries(
      featureScenarios.map((s) => [stepKey(s, 0), { text: s.steps[0].text, resolved }]),
    );
    writeFileSync(lockPathFor(featurePath), JSON.stringify({ version: 2, steps: entries }, null, 2));

    // Wrap a real browser in a Proxy whose newContext() rejects on the 2nd call, simulating a
    // per-scenario crash (e.g. the browser process dying mid-run) without touching real Playwright
    // internals. Methods are rebound to the real target: a Proxy call binds `this` to the proxy by
    // default, which breaks classes (like Playwright's Browser) that rely on `this` in private fields.
    const realBrowser = await chromium.launch();
    let contextCalls = 0;
    const crashingBrowser = new Proxy(realBrowser, {
      get(target, prop, _receiver) {
        if (prop === 'newContext') {
          return async (...args: unknown[]) => {
            contextCalls++;
            if (contextCalls === 2) throw new Error('synthetic crash');
            return target.newContext(...(args as Parameters<Browser['newContext']>));
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const endCalls: ScenarioResult[][] = [];
    const scenarioEndCalls: ScenarioResult[] = [];
    const stepCalls: StepResult[] = [];
    const reporter: Reporter = {
      scenarioStart: () => {},
      step: (_scenario, result) => stepCalls.push(result),
      scenarioEnd: (result) => scenarioEndCalls.push(result),
      end: (results) => endCalls.push(results),
    };

    try {
      const results = await runAll({
        paths: [dir],
        mode: 'default',
        headed: false,
        minConfidence: 0.6,
        reporter,
        reportDir: join(dir, 'report'),
        report: false,
        trace: false,
        workers: 1, // deterministic: the single worker processes scenarios in file order
        launch: async () => crashingBrowser as unknown as Browser,
      });

      expect(results).toHaveLength(2);
      expect(results[0].scenario.name).toBe('first');
      expect(results[0].steps[0].status).toBe('passed');
      expect(results[1].scenario.name).toBe('second');
      expect(results[1].steps).toEqual([
        { step: { keyword: 'Given', text: 'scenario crashed' }, status: 'failed', detail: expect.stringContaining('synthetic crash'), durationMs: 0 },
      ]);

      // scenarioEnd fires exactly once per scenario, and end() is called exactly once with the
      // full, scenario-ordered result set.
      expect(scenarioEndCalls).toHaveLength(2);
      expect(endCalls).toHaveLength(1);
      expect(endCalls[0]).toEqual(results);

      // The synthetic crash result reaches the reporter as a normal step event too, before
      // scenarioEnd, so console/json/junit output (and any evidence capture) sees it.
      const crashSteps = stepCalls.filter((s) => s.step.text === 'scenario crashed');
      expect(crashSteps).toHaveLength(1);
      expect(crashSteps[0]).toMatchObject({ status: 'failed', detail: expect.stringContaining('synthetic crash') });

      // The lockfile is still saved despite the crash: the first scenario's cached entry survives,
      // and the crashed second scenario's entry is NOT pruned even though it never got far enough
      // to touch its own key by resolving — a crash must not cause its lockfile entries to be
      // discarded on this complete, unfiltered run's pruning save.
      const saved = JSON.parse(readFileSync(lockPathFor(featurePath), 'utf8'));
      expect(Object.keys(saved.steps).sort()).toEqual(
        [stepKey(featureScenarios[0], 0), stepKey(featureScenarios[1], 0)].sort(),
      );
    } finally {
      await realBrowser.close();
    }
  });

  it('--record-eval records a resolve() call that threw after Jev responded, with outcome.error set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-'));
    const featurePath = join(dir, 'bad.feature');
    writeFileSync(featurePath, ['Feature: Bad', '  Scenario: only', '    Given I am on "about:blank"', ''].join('\n'));
    const recordDir = join(dir, 'eval');

    // A malformed Jev response (no usable "kind" answer): resolve() calls onRequest with the
    // exchange it actually had, then throws, exactly like the real implementation does when Jev's
    // response doesn't have what resolve() needs.
    const clientSpy = vi
      .spyOn(resolverModule, 'createClient')
      .mockReturnValue({ systemOne: async () => ({ answers: {} }) });
    const resolveSpy = vi.spyOn(resolverModule, 'resolve').mockImplementationOnce(async (input) => {
      const exchange = { state: { step: input.step }, questions: { kind: { type: 'choice' } }, answers: {} };
      input.onRequest?.(exchange);
      throw new Error('Unexpected response from Jev: no answer for "kind".');
    });

    const realBrowser = await chromium.launch();
    const reporter: Reporter = { scenarioStart: () => {}, step: () => {}, scenarioEnd: () => {}, end: () => {} };
    try {
      const results = await runAll({
        paths: [dir],
        mode: 'update', // no lockfile entry needed: always calls resolve()
        headed: false,
        minConfidence: 0.6,
        reporter,
        reportDir: join(dir, 'report'),
        report: false,
        trace: false,
        workers: 1,
        recordEval: recordDir,
        launch: async () => realBrowser,
      });
      expect(results[0].steps[0]).toMatchObject({ status: 'failed', detail: expect.stringContaining('no answer for "kind"') });
    } finally {
      resolveSpy.mockRestore();
      clientSpy.mockRestore();
      await realBrowser.close();
    }

    const written = JSON.parse(readFileSync(join(recordDir, 'bad', 'only', '1.json'), 'utf8'));
    expect(written.outcome).toMatchObject({ error: expect.stringMatching(/no answer for "kind"/) });
  });

  it('--record-eval records a semantic assertion\'s judge() call as <n>-judge.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-'));
    const featurePath = join(dir, 'semantic.feature');
    writeFileSync(
      featurePath,
      ['Feature: Semantic', '  Scenario: only', '    Given I am on "about:blank"', '    Then I see something great', ''].join('\n'),
    );
    const [featureScenario] = parseFeature(readFileSync(featurePath, 'utf8'), featurePath);
    const navResolved: ResolvedStep = { kind: 'navigate', value: 'about:blank' };
    const semanticResolved: ResolvedStep = { kind: 'assert', assertion: { form: 'semantic' } };
    writeFileSync(
      lockPathFor(featurePath),
      JSON.stringify(
        {
          version: 2,
          steps: {
            [stepKey(featureScenario, 0)]: { text: featureScenario.steps[0].text, resolved: navResolved },
            [stepKey(featureScenario, 1)]: { text: featureScenario.steps[1].text, resolved: semanticResolved },
          },
        },
        null,
        2,
      ),
    );
    const recordDir = join(dir, 'eval');

    const clientSpy = vi
      .spyOn(resolverModule, 'createClient')
      .mockReturnValue({ systemOne: async () => ({ answers: {} }) });
    const judgeSpy = vi.spyOn(resolverModule, 'judge').mockImplementation(async (_client, stepText, _snapshot, onRequest) => {
      const exchange = { state: { expectation: stepText }, questions: { holds: { type: 'noul' } }, answers: { holds: { noul: 0.95 } } };
      onRequest?.(exchange);
      return { holds: 0.95 };
    });

    const realBrowser = await chromium.launch();
    const reporter: Reporter = { scenarioStart: () => {}, step: () => {}, scenarioEnd: () => {}, end: () => {} };
    try {
      const results = await runAll({
        paths: [dir],
        mode: 'default',
        headed: false,
        minConfidence: 0.6,
        reporter,
        reportDir: join(dir, 'report'),
        report: false,
        trace: false,
        workers: 1,
        recordEval: recordDir,
        launch: async () => realBrowser,
      });
      expect(results[0].steps[1].status).toBe('passed');
    } finally {
      judgeSpy.mockRestore();
      clientSpy.mockRestore();
      await realBrowser.close();
    }

    const written = JSON.parse(readFileSync(join(recordDir, 'semantic', 'only', '2-judge.json'), 'utf8'));
    expect(written.outcome).toEqual({ holds: 0.95 });
  });

  it('--record-eval warns once to stderr when eval files can\'t be written, not once per call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-'));
    const featurePath = join(dir, 'twostep.feature');
    writeFileSync(
      featurePath,
      ['Feature: Two', '  Scenario: only', '    Given I am on "about:blank"', '    Given I am on "about:blank" again', ''].join('\n'),
    );
    const blockingFile = join(dir, 'not-a-directory');
    writeFileSync(blockingFile, 'just a file');

    const clientSpy = vi
      .spyOn(resolverModule, 'createClient')
      .mockReturnValue({ systemOne: async () => ({ answers: {} }) });
    const resolveSpy = vi.spyOn(resolverModule, 'resolve').mockImplementation(async (input) => {
      const exchange = { state: { step: input.step }, questions: {}, answers: {} };
      input.onRequest?.(exchange);
      return { ok: true, resolved: { kind: 'navigate', value: 'about:blank' } as ResolvedStep, confidence: 0.9 };
    });

    const realBrowser = await chromium.launch();
    const reporter: Reporter = { scenarioStart: () => {}, step: () => {}, scenarioEnd: () => {}, end: () => {} };
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let warnings: unknown[];
    try {
      await runAll({
        paths: [dir],
        mode: 'update',
        headed: false,
        minConfidence: 0.6,
        reporter,
        reportDir: join(dir, 'report'),
        report: false,
        trace: false,
        workers: 1,
        recordEval: blockingFile,
        launch: async () => realBrowser,
      });
      warnings = errors.mock.calls.flat().filter((c) => String(c).startsWith('warning: could not write --record-eval files under'));
    } finally {
      errors.mockRestore();
      resolveSpy.mockRestore();
      clientSpy.mockRestore();
      await realBrowser.close();
    }

    expect(warnings).toEqual([`warning: could not write --record-eval files under ${blockingFile}\n`]);
  });

  it('saves every lockfile without pruning and exits on SIGINT, removing the handler once the run ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-'));
    const featurePath = join(dir, 'sigint.feature');
    writeFileSync(featurePath, ['Feature: X', '  Scenario: only', '    Given I am on "about:blank"', ''].join('\n'));
    const [featureScenario] = parseFeature(readFileSync(featurePath, 'utf8'), featurePath);
    const resolved: ResolvedStep = { kind: 'navigate', value: 'about:blank' };
    writeFileSync(
      lockPathFor(featurePath),
      JSON.stringify({ version: 2, steps: { [stepKey(featureScenario, 0)]: { text: featureScenario.steps[0].text, resolved } } }, null, 2),
    );

    const realBrowser = await chromium.launch();
    const exitCalls: number[] = [];
    const baselineListeners = process.listeners('SIGINT');
    const reporter: Reporter = { scenarioStart: () => {}, step: () => {}, scenarioEnd: () => {}, end: () => {} };

    try {
      const results = await runAll({
        paths: [dir],
        mode: 'default',
        headed: false,
        minConfidence: 0.6,
        reporter,
        reportDir: join(dir, 'report'),
        report: false,
        trace: false,
        workers: 1,
        launch: async () => {
          // A SIGINT handler must already be installed by the time the browser is ready. Invoke
          // jevcumber's handler directly rather than emitting a process-wide SIGINT, which would
          // also fire any other listener alive in this test worker.
          const added = process.listeners('SIGINT').filter((listener) => !baselineListeners.includes(listener));
          expect(added).toHaveLength(1);
          (added[0] as () => void)();
          return realBrowser;
        },
        exit: (code) => exitCalls.push(code),
      });

      expect(exitCalls).toEqual([130]);
      expect(results).toHaveLength(1);
      const saved = JSON.parse(readFileSync(lockPathFor(featurePath), 'utf8'));
      expect(Object.keys(saved.steps)).toContain(stepKey(featureScenario, 0));
      // The handler is removed once the run ends: no listener lingers for a later SIGINT.
      expect(process.listeners('SIGINT').filter((listener) => !baselineListeners.includes(listener))).toHaveLength(0);
    } finally {
      await realBrowser.close();
    }
  });

});
