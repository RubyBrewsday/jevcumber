import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { extractValues } from './candidates.js';
import { captureStep, scenarioDir, stepDir } from './evidence.js';
import { actionLocators, execute } from './executor.js';
import { loadFeatures } from './gherkin.js';
import { toLocator } from './locators.js';
import { Lockfile, lockPathFor, stepKey } from './lockfile.js';
import { createClient, judge, resolve, type JevClient } from './resolver.js';
import { snapshot } from './snapshot.js';
import type { Reporter } from './reporters/index.js';
import type { Assertion, ExecuteResult, Mode, ResolveOutcome, ResolvedStep, Scenario, ScenarioResult, Snapshot, Step, StepResult } from './types.js';

const VALIDATE_TIMEOUT = 2000;

export interface ScenarioDeps {
  mode: Mode;
  lock: Lockfile;
  resolve(step: Step, previousSteps: string[]): Promise<ResolveOutcome>;
  isValid(resolved: ResolvedStep): Promise<boolean>;
  execute(resolved: ResolvedStep, step: Step): Promise<ExecuteResult | void>;
  /** Called at the very start of each step, before the cache is consulted. Lets the caller clear
   *  any per-step state (e.g. the last Jev snapshot) so a skipped resolve doesn't reuse stale data. */
  beforeStep?(): void | Promise<void>;
  onStep?(result: StepResult, index: number): void | Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const pinNote = (assertion: Assertion) => `pinned to ${JSON.stringify('value' in assertion ? assertion.value : assertion)}`;

export async function runScenario(scenario: Scenario, deps: ScenarioDeps): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let skipping = false;

  const runStep = async (step: Step, index: number): Promise<StepResult> => {
    const start = performance.now();
    const result = await runStepInner(step, index);
    const durationMs = result.status === 'skipped' ? 0 : performance.now() - start;
    return { ...result, durationMs };
  };

  const runStepInner = async (step: Step, index: number): Promise<Omit<StepResult, 'durationMs'>> => {
    await deps.beforeStep?.();
    const key = stepKey(scenario, index);
    deps.lock.touch(key); // a run must not prune an entry for a step it started, even if it never resolves
    if (skipping) {
      return { step, status: 'skipped' };
    }

    const cached = deps.mode === 'update' ? undefined : deps.lock.get(key);
    let resolved: ResolvedStep;
    let healed = false;

    // isValid can throw (e.g. a destroyed execution context): treat that as "not valid"
    // rather than letting it escape and abort the run.
    let cachedIsValid = false;
    if (cached) {
      try {
        cachedIsValid = await deps.isValid(cached);
      } catch {
        cachedIsValid = false;
      }
    }

    if (cached && cachedIsValid) {
      resolved = cached;
    } else if (deps.mode === 'frozen') {
      const detail = cached
        ? 'The lockfile entry for this step is stale: its element is no longer on the page. Run without --frozen to heal it.'
        : 'No lockfile entry for this step. Run without --frozen to resolve it with Jev.';
      return { step, status: 'failed', detail };
    } else {
      let outcome: ResolveOutcome;
      try {
        outcome = await deps.resolve(step, scenario.steps.slice(0, index).map((s) => s.text));
      } catch (error) {
        return { step, status: 'failed', detail: message(error) };
      }
      if (!outcome.ok) return { step, status: outcome.reason, detail: outcome.detail };
      resolved = outcome.resolved;
      deps.lock.set(key, step.text, resolved, outcome.confidence);
      healed = cached !== undefined;
    }

    let note: string | undefined;
    try {
      const result = await deps.execute(resolved, step);
      if (result?.pinned) {
        deps.lock.set(key, step.text, { kind: 'assert', assertion: result.pinned }, result.confidence);
        note = pinNote(result.pinned);
      }
    } catch (error) {
      const wasPinned = resolved.kind === 'assert' && 'pinned' in resolved.assertion && resolved.assertion.pinned;
      if (!wasPinned || deps.mode === 'frozen') return { step, status: 'failed', detail: message(error) };
      // The evidence this step was pinned to has gone. Ask Jev whether the expectation still holds
      // before failing: a heading rewrite should heal, a real regression should fail.
      try {
        const rejudged = await deps.execute({ kind: 'assert', assertion: { form: 'semantic' } }, step);
        if (rejudged?.pinned) {
          deps.lock.set(key, step.text, { kind: 'assert', assertion: rejudged.pinned }, rejudged.confidence);
          note = pinNote(rejudged.pinned);
        } else {
          deps.lock.set(key, step.text, { kind: 'assert', assertion: { form: 'semantic' } });
          note = 'no longer pinned: needs Jev under --frozen';
        }
        healed = true;
      } catch (again) {
        return { step, status: 'failed', detail: `pinned check failed (${message(error)}); re-judge: ${message(again)}` };
      }
    }
    const stepResult: Omit<StepResult, 'durationMs'> = { step, status: healed ? 'healed' : 'passed' };
    if (note) stepResult.note = note;
    return stepResult;
  };

  for (const [index, step] of scenario.steps.entries()) {
    const result = await runStep(step, index);
    if (result.status !== 'passed' && result.status !== 'healed') skipping = true;
    results.push(result);
    await deps.onStep?.(result, index);
  }
  return results;
}

export type { Reporter } from './reporters/index.js';

export interface RunOptions {
  paths: string[];
  baseUrl?: string;
  mode: Mode;
  headed: boolean;
  minConfidence: number;
  tags?: string;
  reporter: Reporter;
  reportDir: string;
  /** Whether failure evidence (screenshot + snapshot) is captured. `--report-dir` still applies to
   *  `trace` even when this is false, so a trace-only run's trace lands where the user asked. */
  report: boolean;
  trace: boolean;
}

async function isValid(page: Page, resolved: ResolvedStep): Promise<boolean> {
  for (const spec of actionLocators(resolved)) {
    const locator = toLocator(page, spec);
    await locator.first().waitFor({ state: 'attached', timeout: VALIDATE_TIMEOUT }).catch(() => {});
    if ((await locator.count()) !== 1) return false;
  }
  return true;
}

export async function runAll(options: RunOptions): Promise<ScenarioResult[]> {
  const scenarios = loadFeatures(options.paths, options.tags);
  if (scenarios.length === 0) return []; // let the CLI report "no scenarios found"; no summary to print
  const frozen = options.mode === 'frozen';

  let client: JevClient | undefined;
  const getClient = () => (client ??= createClient());

  const locks = new Map<string, Lockfile>();
  const lockFor = (uri: string) => {
    if (!locks.has(uri)) locks.set(uri, Lockfile.load(lockPathFor(uri)));
    return locks.get(uri)!;
  };

  const results: ScenarioResult[] = [];
  let completed = false;
  const browser = await chromium.launch({ headless: !options.headed });
  try {
    try {
      options.reporter.start?.(scenarios);
      for (const scenario of scenarios) {
        options.reporter.scenarioStart(scenario);
        // Evidence and traces are written fresh each run: a stale screenshot/snapshot/trace from an
        // earlier run of this scenario must never linger and be mistaken for this run's.
        if (options.report || options.trace) {
          rmSync(scenarioDir(options.reportDir, scenario), { recursive: true, force: true });
        }
        const context = await browser.newContext();
        if (options.trace) await context.tracing.start({ screenshots: true, snapshots: true });
        try {
          const page = await context.newPage();
          let lastSnapshot: Snapshot | undefined;
          const steps = await runScenario(scenario, {
            mode: options.mode,
            lock: lockFor(scenario.uri),
            resolve: async (step, previousSteps) => {
              const snap = await snapshot(page, { relevantTo: step.text });
              lastSnapshot = snap;
              return resolve({
                step,
                scenarioName: scenario.name,
                previousSteps,
                snapshot: snap,
                values: extractValues(step),
                client: getClient(),
                minConfidence: options.minConfidence,
              });
            },
            isValid: (resolved) => isValid(page, resolved),
            execute: (resolved, step) =>
              execute(page, resolved, {
                baseUrl: options.baseUrl,
                stepText: step.text,
                featureDir: dirname(resolvePath(scenario.uri)),
                judge: frozen ? undefined : async (text) => judge(getClient(), text, await snapshot(page, { elements: false, relevantTo: text })),
              }),
            // A step that never calls resolve() (a cached hit, or --frozen) leaves no snapshot of
            // its own: clearing this at the start of every step stops a failing step from being
            // captured against the previous step's stale snapshot.
            beforeStep: () => {
              lastSnapshot = undefined;
            },
            onStep: async (result, index) => {
              const failing = result.status === 'failed' || result.status === 'ambiguous' || result.status === 'undefined';
              if (failing && options.report) {
                const dir = stepDir(options.reportDir, scenario, index, result.status);
                const snap = lastSnapshot ?? (await snapshot(page, { elements: true }).catch(() => undefined));
                if (await captureStep(page, dir, snap)) result.evidenceDir = dir;
              }
              options.reporter.step(scenario, result);
            },
          });
          const result: ScenarioResult = { scenario, steps };
          if (options.trace) {
            // --no-report --trace: report evidence is off, but --report-dir still applies to traces.
            const passed = steps.every((s) => s.status === 'passed' || s.status === 'healed');
            const dir = scenarioDir(options.reportDir, scenario);
            try {
              mkdirSync(dir, { recursive: true });
              const traceFile = join(dir, 'trace.zip');
              await context.tracing.stop(passed ? {} : { path: traceFile });
              if (!passed) result.trace = traceFile;
            } catch {
              // best-effort, same as screenshot/snapshot capture: a trace failure must not abort the run
            }
          }
          results.push(result);
          options.reporter.scenarioEnd?.(result);
        } finally {
          await context.close();
        }
      }
      completed = true;
    } finally {
      await browser.close();
    }
  } finally {
    // Persist whatever the run resolved even if it aborted, so completed work isn't lost.
    // Pruning is only safe after a complete, unfiltered run; an aborted run saves as-is.
    if (!frozen) {
      for (const lock of locks.values()) lock.save(completed && options.tags === undefined);
    }
  }

  options.reporter.end(results);
  return results;
}
