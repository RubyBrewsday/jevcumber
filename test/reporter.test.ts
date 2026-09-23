import { describe, expect, it } from 'vitest';
import { consoleReporter, exitCode } from '../src/reporter.js';
import type { Scenario, ScenarioResult, StepStatus } from '../src/types.js';

const scenario: Scenario = { uri: 'a.feature', feature: 'Login', name: 'logs in', occurrence: 0, tags: [], steps: [] };
const result = (...statuses: StepStatus[]): ScenarioResult => ({
  scenario,
  steps: statuses.map((status, i) => ({ step: { keyword: 'When', text: `step ${i}` }, status, detail: status === 'failed' ? 'boom\nline two' : undefined })),
});

describe('consoleReporter', () => {
  it('prints feature once, scenarios, step marks, indented details, and a summary', () => {
    const lines: string[] = [];
    const reporter = consoleReporter((line) => lines.push(line));
    const results = [result('passed', 'healed'), result('failed', 'skipped')];
    for (const r of results) {
      reporter.scenarioStart(r.scenario);
      r.steps.forEach((s) => reporter.step(s));
    }
    reporter.end(results);

    expect(lines.filter((l) => l === 'Feature: Login')).toHaveLength(1);
    expect(lines).toContain('  Scenario: logs in');
    expect(lines).toContain('    ✓ When step 0');
    expect(lines).toContain('    ↻ When step 1 (healed — lockfile updated)');
    expect(lines).toContain('    ✗ When step 0');
    expect(lines).toContain('        boom');
    expect(lines).toContain('        line two');
    expect(lines).toContain('    - When step 1');
    expect(lines.at(-1)).toBe('2 scenarios (1 passed, 1 failed) · 4 steps (1 passed, 1 healed, 1 failed, 1 skipped)');
  });

  it('appends a note in parentheses after the status suffix', () => {
    const lines: string[] = [];
    const reporter = consoleReporter((line) => lines.push(line));
    reporter.step({ step: { keyword: 'When', text: 'step 0' }, status: 'passed', note: 'pinned to "X"' });
    expect(lines).toContain('    ✓ When step 0 (pinned to "X")');
  });

  it('prints a trace path via scenarioEnd when the scenario result has one', () => {
    const lines: string[] = [];
    const reporter = consoleReporter((line) => lines.push(line));
    reporter.scenarioEnd?.({ scenario, steps: [], trace: 'jevcumber-report/a/b/trace.zip' });
    expect(lines).toContain('    trace: jevcumber-report/a/b/trace.zip');
  });

  it('prints nothing via scenarioEnd when the scenario result has no trace', () => {
    const lines: string[] = [];
    const reporter = consoleReporter((line) => lines.push(line));
    reporter.scenarioEnd?.({ scenario, steps: [] });
    expect(lines).toEqual([]);
  });

  it('prints the evidence path after the detail lines', () => {
    const lines: string[] = [];
    const reporter = consoleReporter((line) => lines.push(line));
    reporter.step({
      step: { keyword: 'Then', text: 'step 0' },
      status: 'failed',
      detail: 'boom',
      evidenceDir: 'jevcumber-report/a/b/1-failed',
    });
    expect(lines.indexOf('        evidence: jevcumber-report/a/b/1-failed')).toBeGreaterThan(lines.indexOf('        boom'));
  });
});

describe('exitCode', () => {
  it('is 0 only when every step passed or healed', () => {
    expect(exitCode([result('passed', 'healed')])).toBe(0);
    expect(exitCode([result('passed'), result('ambiguous')])).toBe(1);
    expect(exitCode([result('undefined')])).toBe(1);
    expect(exitCode([])).toBe(0);
  });
});
