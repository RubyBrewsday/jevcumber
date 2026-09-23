import type { Reporter } from './reporters/index.js';
import type { Scenario, ScenarioResult, StepResult, StepStatus } from './types.js';

const MARKS: Record<StepStatus, string> = {
  passed: '✓', healed: '↻', failed: '✗', ambiguous: '?', undefined: '?', skipped: '-',
};
const ORDER: StepStatus[] = ['passed', 'healed', 'failed', 'ambiguous', 'undefined', 'skipped'];

const scenarioPassed = (result: ScenarioResult) =>
  result.steps.every((step) => step.status === 'passed' || step.status === 'healed');

export function exitCode(results: ScenarioResult[]): 0 | 1 {
  return results.every(scenarioPassed) ? 0 : 1;
}

export interface ConsoleReporterOptions {
  write?: (line: string) => void;
  writeStatus?: (line: string) => void;
  isTTY?: boolean;
}

interface ScenarioBuffer {
  scenario: Scenario;
  lines: string[];
}

const bufferKey = (scenario: Scenario) => `${scenario.uri}\u0000${scenario.occurrence}\u0000${scenario.name}`;

function stepLines({ step, status, detail, note, evidenceDir }: StepResult): string[] {
  const lines: string[] = [];
  const suffix =
    status === 'healed' ? ' (healed — lockfile updated)' : status === 'ambiguous' || status === 'undefined' ? ` (${status})` : '';
  lines.push(`    ${MARKS[status]} ${step.keyword} ${step.text}${suffix}${note ? ` (${note})` : ''}`);
  if (detail) for (const line of detail.split('\n')) lines.push(`        ${line}`);
  if (evidenceDir) lines.push(`        evidence: ${evidenceDir}`);
  return lines;
}

export function consoleReporter(options: ConsoleReporterOptions = {}): Reporter {
  const write = options.write ?? console.log;
  const writeStatus = options.writeStatus ?? (() => {});
  const isTTY = options.isTTY ?? false;

  let currentFeatureUri: string | undefined;
  let total = 0;
  let started = 0;
  let ended = 0;
  let failed = 0;
  const buffers = new Map<string, ScenarioBuffer>();

  const redraw = () => {
    if (!isTTY) return;
    writeStatus(`\r\x1b[K${ended}/${total} scenarios · ${started - ended} running · ${failed} failed`);
  };

  return {
    start(scenarios) {
      total = scenarios.length;
    },
    scenarioStart(scenario) {
      started++;
      buffers.set(bufferKey(scenario), { scenario, lines: [] });
      redraw();
    },
    step(scenario, result) {
      const key = bufferKey(scenario);
      let buffer = buffers.get(key);
      if (!buffer) {
        buffer = { scenario, lines: [] };
        buffers.set(key, buffer);
      }
      buffer.lines.push(...stepLines(result));
    },
    scenarioEnd(result) {
      const key = bufferKey(result.scenario);
      const buffer = buffers.get(key);
      buffers.delete(key);

      if (isTTY) writeStatus('\r\x1b[K');

      // Keyed by uri, not the Feature: display name, so two different files that happen to share
      // a Feature title each still get their own header printed.
      if (result.scenario.uri !== currentFeatureUri) {
        currentFeatureUri = result.scenario.uri;
        write(`Feature: ${result.scenario.feature}`);
      }
      write(`  Scenario: ${result.scenario.name}`);
      for (const line of buffer?.lines ?? []) write(line);
      if (result.trace) write(`    trace: ${result.trace}`);

      ended++;
      if (!scenarioPassed(result)) failed++;
      redraw();
    },
    end(results) {
      if (isTTY) writeStatus('\r\x1b[K');

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
