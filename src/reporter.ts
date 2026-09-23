import type { Reporter } from './runner.js';
import type { ScenarioResult, StepStatus } from './types.js';

const MARKS: Record<StepStatus, string> = {
  passed: '✓', healed: '↻', failed: '✗', ambiguous: '?', undefined: '?', skipped: '-',
};
const ORDER: StepStatus[] = ['passed', 'healed', 'failed', 'ambiguous', 'undefined', 'skipped'];

const scenarioPassed = (result: ScenarioResult) =>
  result.steps.every((step) => step.status === 'passed' || step.status === 'healed');

export function exitCode(results: ScenarioResult[]): 0 | 1 {
  return results.every(scenarioPassed) ? 0 : 1;
}

export function consoleReporter(write: (line: string) => void = console.log): Reporter {
  let currentFeature: string | undefined;
  return {
    scenarioStart(scenario) {
      if (scenario.feature !== currentFeature) {
        currentFeature = scenario.feature;
        write(`Feature: ${scenario.feature}`);
      }
      write(`  Scenario: ${scenario.name}`);
    },
    step({ step, status, detail, note }) {
      const suffix =
        status === 'healed' ? ' (healed — lockfile updated)' : status === 'ambiguous' || status === 'undefined' ? ` (${status})` : '';
      write(`    ${MARKS[status]} ${step.keyword} ${step.text}${suffix}${note ? ` (${note})` : ''}`);
      if (detail) for (const line of detail.split('\n')) write(`        ${line}`);
    },
    end(results) {
      const passed = results.filter(scenarioPassed).length;
      const scenarioParts = [`${passed} passed`];
      if (results.length - passed > 0) scenarioParts.push(`${results.length - passed} failed`);

      const steps = results.flatMap((result) => result.steps);
      const stepParts = ORDER.map((status) => [status, steps.filter((s) => s.status === status).length] as const)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => `${count} ${status}`);

      write('');
      write(`${results.length} scenarios (${scenarioParts.join(', ')}) · ${steps.length} steps (${stepParts.join(', ')})`);
    },
  };
}
