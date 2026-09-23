import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { extractValues } from './candidates.js';
import type { ConfigHooks } from './config.js';
import { captureStep, scenarioDir, stepDir } from './evidence.js';
import { actionLocators, execute } from './executor.js';
import { loadFeatures } from './gherkin.js';
import { toLocator } from './locators.js';
import { Lockfile, lockPathFor, stepKey } from './lockfile.js';
import { recordEval } from './recorder.js';
import { createClient, judge, resolve, type JevClient, type JevExchange } from './resolver.js';
import { snapshot } from './snapshot.js';
import type { Reporter } from './reporters/index.js';
import type { Assertion, ExecuteResult, Mode, ResolveOutcome, ResolvedStep, Scenario, ScenarioResult, Snapshot, Step, StepResult } from './types.js';

const VALIDATE_TIMEOUT = 2000;

export interface ScenarioDeps {
  mode: Mode;
  lock: Lockfile;
  resolve(step: Step, previousSteps: string[], index: number): Promise<ResolveOutcome>;
  isValid(resolved: ResolvedStep): Promise<boolean>;
  execute(resolved: ResolvedStep, step: Step): Promise<ExecuteResult | void>;
  /** Called at the very start of each step, before the cache is consulted. Lets the caller clear
   *  any per-step state (e.g. the last Jev snapshot) so a skipped resolve doesn't reuse stale data,
   *  and know which step is current for callbacks (e.g. judge) that execute() doesn't index itself. */
  beforeStep?(index: number): void | Promise<void>;
  onStep?(result: StepResult, index: number): void | Promise<void>;
  /** Runs once before the first step. A throw fails every step (as a synthetic "beforeScenario
   *  hook" step) without ever calling resolve(). */
  before?(): void | Promise<void>;
  /** Runs once after the last step (even if `before` failed), and is given the results so far.
   *  A throw appends a synthetic "afterScenario hook" failed result. */
  after?(results: StepResult[]): void | Promise<void>;
}

// A thrown error's message can carry ANSI colour codes (Playwright's expect() matchers add them
// even outside a real terminal), which look like escaped garbage in console/JUnit/JSON output.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(ANSI, '');
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
    await deps.beforeStep?.(index);
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
        outcome = await deps.resolve(step, scenario.steps.slice(0, index).map((s) => s.text), index);
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

  if (deps.before) {
    try {
      await deps.before();
    } catch (error) {
      const result: StepResult = {
        step: { keyword: 'Given', text: 'beforeScenario hook' },
        status: 'failed',
        detail: `beforeScenario hook: ${message(error)}`,
        durationMs: 0,
      };
      results.push(result);
      // Index -1: this synthetic result precedes every real step, which are indexed from 0.
      await deps.onStep?.(result, -1);
      skipping = true;
    }
  }

  for (const [index, step] of scenario.steps.entries()) {
    const result = await runStep(step, index);
    if (result.status !== 'passed' && result.status !== 'healed') skipping = true;
    results.push(result);
    await deps.onStep?.(result, index);
  }

  if (deps.after) {
    try {
      await deps.after(results);
    } catch (error) {
      const result: StepResult = {
        step: { keyword: 'Given', text: 'afterScenario hook' },
        status: 'failed',
        detail: `afterScenario hook: ${message(error)}`,
        durationMs: 0,
      };
      results.push(result);
      // Index scenario.steps.length: this synthetic result follows every real step.
      await deps.onStep?.(result, scenario.steps.length);
    }
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
  /** Number of scenario workers to run concurrently. Ignored (treated as 1) when `headed` is true:
   *  a headed run against a single visible browser window can't usefully show two scenarios at once. */
  workers: number;
  hooks?: ConfigHooks;
  /** Directory to record every Jev exchange (what was sent, what came back, and the outcome) for
   *  offline reproduction. Never written to under `--frozen`, since no Jev calls happen. */
  recordEval?: string;
  /** Test seam: how to obtain the Playwright browser. Defaults to `chromium.launch`. */
  launch?: () => Promise<Browser>;
  /** Test seam: how a SIGINT during the run terminates the process. Defaults to `process.exit`. */
  exit?: (code: number) => void;
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

  let completed = false;
  // Warn at most once per run when --record-eval can't write its files (e.g. a bad or blocked
  // directory), rather than once per Jev call, which would otherwise spam stderr for the whole run.
  let recordEvalWarned = false;
  const warnIfRecordEvalFailed = (wrote: boolean) => {
    if (!wrote && !recordEvalWarned) {
      recordEvalWarned = true;
      process.stderr.write(`warning: could not write --record-eval files under ${options.recordEval}\n`);
    }
  };

  // Ctrl-C mid-run must not lose whatever Jev has already resolved: save every lockfile
  // (unpruned — the run never got the chance to finish touching every entry, so pruning here
  // would discard good ones) before the process actually exits.
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const onSigint = () => {
    if (!frozen) {
      for (const lock of locks.values()) lock.save(false);
    }
    exit(130);
  };
  const launch = options.launch ?? (() => chromium.launch({ headless: !options.headed }));
  const ordered: ScenarioResult[] = new Array(scenarios.length);
  // Registered inside the try so a failed launch still removes the listener in the finally.
  process.once('SIGINT', onSigint);
  let browser: Awaited<ReturnType<typeof launch>>;
  try {
    browser = await launch();
    try {
      options.reporter.start?.(scenarios);

      const runOne = async (scenario: Scenario): Promise<ScenarioResult> => {
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
          // beforeStep sets this for every step (cached or not), so the judge callback below —
          // which execute() invokes without an index of its own — knows which step it's judging.
          let currentIndex = 0;
          const steps = await runScenario(scenario, {
            mode: options.mode,
            lock: lockFor(scenario.uri),
            resolve: async (step, previousSteps, index) => {
              const snap = await snapshot(page, { relevantTo: step.text });
              lastSnapshot = snap;
              let exchange: JevExchange | undefined;
              let outcome: ResolveOutcome | undefined;
              let caught: unknown;
              try {
                outcome = await resolve({
                  step,
                  scenarioName: scenario.name,
                  previousSteps,
                  snapshot: snap,
                  values: extractValues(step),
                  client: getClient(),
                  minConfidence: options.minConfidence,
                  onRequest: options.recordEval ? (e) => (exchange = e) : undefined,
                });
                return outcome;
              } catch (error) {
                caught = error;
                throw error;
              } finally {
                // Record whenever onRequest fired, even if resolve() threw afterwards (e.g. a
                // malformed Jev response): the exchange that caused the failure is exactly what's
                // needed to reproduce it offline.
                if (options.recordEval && exchange) {
                  warnIfRecordEvalFailed(
                    recordEval(options.recordEval, scenario, index, 'resolve', {
                      step,
                      exchange,
                      outcome: outcome ?? { error: message(caught) },
                    }),
                  );
                }
              }
            },
            isValid: (resolved) => isValid(page, resolved),
            execute: (resolved, step) =>
              execute(page, resolved, {
                baseUrl: options.baseUrl,
                stepText: step.text,
                featureDir: dirname(resolvePath(scenario.uri)),
                judge: frozen
                  ? undefined
                  : async (text) => {
                      let exchange: JevExchange | undefined;
                      let judgment: Awaited<ReturnType<typeof judge>> | undefined;
                      let caught: unknown;
                      try {
                        judgment = await judge(
                          getClient(),
                          text,
                          await snapshot(page, { elements: false, relevantTo: text }),
                          options.recordEval ? (e) => (exchange = e) : undefined,
                        );
                        return judgment;
                      } catch (error) {
                        caught = error;
                        throw error;
                      } finally {
                        // Same as the resolve() wrapper above: record whenever onRequest fired,
                        // even when judge() threw afterwards.
                        if (options.recordEval && exchange) {
                          warnIfRecordEvalFailed(
                            recordEval(options.recordEval, scenario, currentIndex, 'judge', {
                              step,
                              exchange,
                              outcome: judgment ?? { error: message(caught) },
                            }),
                          );
                        }
                      }
                    },
              }),
            // A step that never calls resolve() (a cached hit, or --frozen) leaves no snapshot of
            // its own: clearing this at the start of every step stops a failing step from being
            // captured against the previous step's stale snapshot.
            beforeStep: (index) => {
              lastSnapshot = undefined;
              currentIndex = index;
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
            before: () => options.hooks?.beforeScenario?.({ page, scenario, baseUrl: options.baseUrl }),
            after: (results) => options.hooks?.afterScenario?.({ page, scenario, baseUrl: options.baseUrl, results }),
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
          return result;
        } finally {
          await context.close();
        }
      };

      // A headed run drives a single visible browser window, so it can only usefully show one
      // scenario at a time regardless of --workers.
      const workers = options.headed ? 1 : Math.max(1, Math.min(options.workers, scenarios.length));
      let next = 0;
      const worker = async () => {
        while (next < scenarios.length) {
          const index = next++;
          const scenario = scenarios[index];
          let result: ScenarioResult;
          try {
            result = await runOne(scenario);
          } catch (error) {
            // A worker crash on one scenario (e.g. context creation failing) must not take down
            // the others still in the queue. It also must not cause this scenario's lockfile
            // entries to be pruned: the crash happened before runScenario ever got a chance to
            // touch them itself, so every step key is touched here instead.
            if (!frozen) {
              const lock = lockFor(scenario.uri);
              for (let i = 0; i < scenario.steps.length; i++) lock.touch(stepKey(scenario, i));
            }
            const synthetic: StepResult = {
              step: { keyword: 'Given', text: 'scenario crashed' },
              status: 'failed',
              detail: message(error),
              durationMs: 0,
            };
            result = { scenario, steps: [synthetic] };
            options.reporter.step(scenario, synthetic);
          }
          ordered[index] = result;
          // scenarioEnd is emitted exactly once per scenario, outside the try/catch above, so a
          // throwing reporter can never cause this scenario to be reported (and land in the catch)
          // a second time.
          options.reporter.scenarioEnd?.(result);
        }
      };
      await Promise.all(Array.from({ length: workers }, worker));

      completed = true;
    } finally {
      await browser.close();
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    // Persist whatever the run resolved even if it aborted, so completed work isn't lost.
    // Pruning is only safe after a complete, unfiltered run; an aborted run saves as-is.
    if (!frozen) {
      for (const lock of locks.values()) lock.save(completed && options.tags === undefined);
    }
  }

  options.reporter.end(ordered);
  return ordered;
}
