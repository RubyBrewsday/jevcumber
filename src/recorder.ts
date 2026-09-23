import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenarioDir } from './evidence.js';
import type { JevExchange } from './resolver.js';
import type { Scenario, Step } from './types.js';

/**
 * Writes exactly what a single Jev call sent and received, plus what jevcumber did with it, so a
 * misresolution can be reproduced offline. One file per call, under the same slugged
 * feature/scenario layout `evidence.ts` uses for report evidence:
 * `<dir>/<feature-dir>/<feature-basename>/<scenario-slug>/<index+1>.json` for a resolve call, and
 * `<index+1>-judge.json` for the judge call made while executing a semantic assertion. The
 * feature's own directory, relative to cwd, is included (e.g. `features/login.feature` →
 * `<dir>/features/login/…`) so two feature files sharing a basename don't collide.
 *
 * Best-effort, like `evidence.ts`'s `captureStep`: a bad --record-eval directory (e.g. it collides
 * with an existing file) must never throw into the run. Returns whether it actually wrote anything.
 */
export function recordEval(
  dir: string,
  scenario: Scenario,
  index: number,
  kind: 'resolve' | 'judge',
  data: { step: Step; exchange: JevExchange; outcome: unknown },
): boolean {
  try {
    const target = scenarioDir(dir, scenario);
    mkdirSync(target, { recursive: true });
    const file = join(target, `${index + 1}${kind === 'judge' ? '-judge' : ''}.json`);
    const content = {
      step: data.step,
      state: data.exchange.state,
      questions: data.exchange.questions,
      answers: data.exchange.answers,
      outcome: data.outcome,
    };
    writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
    return true;
  } catch {
    // recording is a courtesy, not a requirement: a bad --record-eval dir must not fail the run
    return false;
  }
}
