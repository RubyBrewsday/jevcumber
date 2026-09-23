import { join } from 'node:path';
import { consoleReporter } from '../reporter.js';
import type { Scenario, ScenarioResult, StepResult } from '../types.js';
import { jsonReporter } from './json.js';
import { junitReporter } from './junit.js';

export interface Reporter {
  /** Called once, before any scenario runs, with the full set of scenarios that will run.
   *  Lets a reporter know the total up front (e.g. for a status line). Optional. */
  start?(scenarios: Scenario[]): void;
  scenarioStart(scenario: Scenario): void;
  step(scenario: Scenario, result: StepResult): void;
  scenarioEnd(result: ScenarioResult): void;
  end(results: ScenarioResult[]): void;
}

export type ReporterName = 'console' | 'json' | 'junit';

export interface CreateReportersOptions {
  output?: string;
  reportDir: string;
  isTTY: boolean;
  write?: (line: string) => void;
  writeStatus?: (line: string) => void;
}

export function combine(reporters: Reporter[]): Reporter {
  return {
    start(scenarios) {
      for (const reporter of reporters) reporter.start?.(scenarios);
    },
    scenarioStart(scenario) {
      for (const reporter of reporters) reporter.scenarioStart(scenario);
    },
    step(scenario, result) {
      for (const reporter of reporters) reporter.step(scenario, result);
    },
    scenarioEnd(result) {
      for (const reporter of reporters) reporter.scenarioEnd(result);
    },
    end(results) {
      for (const reporter of reporters) reporter.end(results);
    },
  };
}

export function createReporters(names: ReporterName[], options: CreateReportersOptions): Reporter {
  const reporters = names.map((name): Reporter => {
    switch (name) {
      case 'console':
        return consoleReporter({ write: options.write, writeStatus: options.writeStatus, isTTY: options.isTTY });
      case 'json':
        return jsonReporter(options.output ?? join(options.reportDir, 'results.json'));
      case 'junit':
        return junitReporter(options.output ?? join(options.reportDir, 'results.xml'));
      default:
        throw new Error(`Unknown reporter "${name}"`);
    }
  });
  return combine(reporters);
}
