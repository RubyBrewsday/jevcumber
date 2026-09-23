import { describe, expect, it } from 'vitest';
import { consoleReporter, exitCode } from '../src/reporter.js';
import type { Scenario, ScenarioResult, StepStatus } from '../src/types.js';

const scenario: Scenario = { uri: 'a.feature', feature: 'Login', name: 'logs in', occurrence: 0, tags: [], steps: [] };
const result = (...statuses: StepStatus[]): ScenarioResult => ({
  scenario,
  steps: statuses.map((status, i) => ({
    step: { keyword: 'When', text: `step ${i}` },
    status,
    detail: status === 'failed' ? 'boom\nline two' : undefined,
    durationMs: 0,
  })),
});

describe('consoleReporter', () => {
  it('prints feature once, scenarios, step marks, indented details, and a summary', () => {
    const lines: string[] = [];
    const reporter = consoleReporter({ write: (line) => lines.push(line) });
    const results = [result('passed', 'healed'), result('failed', 'skipped')];
    for (const r of results) {
      reporter.scenarioStart(r.scenario);
      r.steps.forEach((s) => reporter.step(r.scenario, s));
      reporter.scenarioEnd(r);
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
    const reporter = consoleReporter({ write: (line) => lines.push(line) });
    reporter.scenarioStart(scenario);
    reporter.step(scenario, { step: { keyword: 'When', text: 'step 0' }, status: 'passed', note: 'pinned to "X"', durationMs: 0 });
    reporter.scenarioEnd({ scenario, steps: [] });
    expect(lines).toContain('    ✓ When step 0 (pinned to "X")');
  });

  it('prints a trace path via scenarioEnd when the scenario result has one', () => {
    const lines: string[] = [];
    const reporter = consoleReporter({ write: (line) => lines.push(line) });
    reporter.scenarioStart(scenario);
    reporter.scenarioEnd({ scenario, steps: [], trace: 'jevcumber-report/a/b/trace.zip' });
    expect(lines).toContain('    trace: jevcumber-report/a/b/trace.zip');
  });

  it('does not print a trace line when the scenario result has no trace', () => {
    const lines: string[] = [];
    const reporter = consoleReporter({ write: (line) => lines.push(line) });
    reporter.scenarioStart(scenario);
    reporter.scenarioEnd({ scenario, steps: [] });
    expect(lines.some((l) => l.startsWith('    trace:'))).toBe(false);
  });

  it('prints the evidence path after the detail lines', () => {
    const lines: string[] = [];
    const reporter = consoleReporter({ write: (line) => lines.push(line) });
    reporter.scenarioStart(scenario);
    reporter.step(scenario, {
      step: { keyword: 'Then', text: 'step 0' },
      status: 'failed',
      detail: 'boom',
      evidenceDir: 'jevcumber-report/a/b/1-failed',
      durationMs: 0,
    });
    reporter.scenarioEnd({ scenario, steps: [] });
    expect(lines.indexOf('        evidence: jevcumber-report/a/b/1-failed')).toBeGreaterThan(lines.indexOf('        boom'));
  });

  it('reprints the feature header for a different file even when its Feature name is the same', () => {
    const lines: string[] = [];
    const reporter = consoleReporter({ write: (line) => lines.push(line) });
    const sameNameOtherFile: Scenario = { uri: 'b.feature', feature: 'Login', name: 'other scenario', occurrence: 0, tags: [], steps: [] };
    reporter.scenarioStart(scenario);
    reporter.scenarioEnd({ scenario, steps: [] });
    reporter.scenarioStart(sameNameOtherFile);
    reporter.scenarioEnd({ scenario: sameNameOtherFile, steps: [] });
    expect(lines.filter((l) => l === 'Feature: Login')).toHaveLength(2);
  });

  it('buffers steps per scenario and prints the block only when the scenario ends', () => {
    const lines: string[] = [];
    const reporter = consoleReporter({ write: (line) => lines.push(line) });
    reporter.scenarioStart(scenario);
    reporter.step(scenario, { step: { keyword: 'When', text: 'step 0' }, status: 'passed', durationMs: 0 });
    expect(lines).toEqual([]); // nothing printed yet: still buffered
    reporter.scenarioEnd({ scenario, steps: [] });
    expect(lines).toEqual(['Feature: Login', '  Scenario: logs in', '    ✓ When step 0']);
  });

  describe('status line', () => {
    it('writes nothing via writeStatus when not a TTY', () => {
      const statusLines: string[] = [];
      const reporter = consoleReporter({ write: () => {}, writeStatus: (s) => statusLines.push(s), isTTY: false });
      reporter.start?.([scenario, scenario]);
      reporter.scenarioStart(scenario);
      reporter.scenarioStart(scenario);
      reporter.scenarioEnd({ scenario, steps: [] });
      expect(statusLines).toEqual([]);
    });

    it('writes a status line after the first scenario ends when isTTY', () => {
      const statusLines: string[] = [];
      const reporter = consoleReporter({ write: () => {}, writeStatus: (s) => statusLines.push(s), isTTY: true });
      reporter.start?.([scenario, scenario]);
      reporter.scenarioStart(scenario);
      reporter.scenarioStart(scenario);
      reporter.scenarioEnd({ scenario, steps: [] });
      expect(statusLines.at(-1)).toBe('\r\x1b[K1/2 scenarios · 1 running · 0 failed');
    });

    it('clears the status line before writing the scenario block, then redraws after', () => {
      const events: string[] = [];
      const reporter = consoleReporter({
        write: (line) => events.push(`write:${line}`),
        writeStatus: (s) => events.push(`status:${s}`),
        isTTY: true,
      });
      reporter.start?.([scenario]);
      reporter.scenarioStart(scenario);
      reporter.step(scenario, { step: { keyword: 'When', text: 'step 0' }, status: 'passed', durationMs: 0 });
      events.length = 0; // drop scenarioStart's own redraw; only scenarioEnd's sequence matters here
      reporter.scenarioEnd({ scenario, steps: [] });

      expect(events).toEqual([
        'status:\r\x1b[K',
        'write:Feature: Login',
        'write:  Scenario: logs in',
        'write:    ✓ When step 0',
        'status:\r\x1b[K1/1 scenarios · 0 running · 0 failed',
      ]);
    });
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
