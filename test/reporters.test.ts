import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { combine, createReporters, type Reporter } from '../src/reporters/index.js';
import { toCucumberJson } from '../src/reporters/json.js';
import { toJunitXml } from '../src/reporters/junit.js';
import type { Scenario, ScenarioResult, StepResult } from '../src/types.js';

const results: ScenarioResult[] = [
  { scenario: { uri: 'features/login.feature', feature: 'Login', name: 'ok', occurrence: 0, tags: ['@smoke'], steps: [] },
    steps: [{ step: { keyword: 'Given', text: 'I am on "/login"' }, status: 'passed', durationMs: 12 }, { step: { keyword: 'Then', text: 'x' }, status: 'healed', durationMs: 3, note: 'pinned to "X"' }] },
  { scenario: { uri: 'features/login.feature', feature: 'Login', name: 'bad', occurrence: 0, tags: [], steps: [] },
    steps: [{ step: { keyword: 'When', text: 'I click it' }, status: 'ambiguous', durationMs: 40, detail: 'which one?' }, { step: { keyword: 'Then', text: 'y' }, status: 'skipped', durationMs: 0 }] },
  { scenario: { uri: 'features/todo.feature', feature: 'Todo', name: 'boom', occurrence: 0, tags: [], steps: [] },
    steps: [{ step: { keyword: 'Then', text: 'z' }, status: 'failed', durationMs: 5000, detail: 'not visible <b>' }] },
];

describe('cucumber json', () => {
  it('groups scenarios by feature with cucumber statuses and nanosecond durations', () => {
    const json = toCucumberJson(results) as any[];
    expect(json.map((f) => f.uri)).toEqual(['features/login.feature', 'features/todo.feature']);
    expect(json[0].name).toBe('Login');
    expect(json[0].elements.map((e: any) => e.name)).toEqual(['ok', 'bad']);
    const [ok, bad] = json[0].elements;
    expect(ok.tags).toEqual([{ name: '@smoke' }]);
    expect(ok.steps[0]).toEqual({ keyword: 'Given ', name: 'I am on "/login"', result: { status: 'passed', duration: 12_000_000 } });
    expect(ok.steps[1].result.status).toBe('passed');
    expect(bad.steps[0].result).toEqual({ status: 'undefined', duration: 40_000_000, error_message: 'which one?' });
    expect(bad.steps[1].result.status).toBe('skipped');
    expect(json[1].elements[0].steps[0].result.status).toBe('failed');
  });

  it('rounds fractional millisecond durations to whole nanoseconds', () => {
    const fractional: ScenarioResult[] = [
      {
        scenario: { uri: 'features/x.feature', feature: 'X', name: 'frac', occurrence: 0, tags: [], steps: [] },
        steps: [{ step: { keyword: 'Given', text: 'x' }, status: 'passed', durationMs: 33.333333333333336 }],
      },
    ];
    const json = toCucumberJson(fractional) as any[];
    const duration = json[0].elements[0].steps[0].result.duration;
    expect(Number.isInteger(duration)).toBe(true);
    expect(duration).toBe(Math.round(33.333333333333336 * 1_000_000));
  });

  it('disambiguates same-named scenario outline rows by occurrence in the id', () => {
    const rows: ScenarioResult[] = [
      { scenario: { uri: 'features/x.feature', feature: 'X', name: 'row', occurrence: 0, tags: [], steps: [] }, steps: [] },
      { scenario: { uri: 'features/x.feature', feature: 'X', name: 'row', occurrence: 1, tags: [], steps: [] }, steps: [] },
    ];
    const json = toCucumberJson(rows) as any[];
    const ids = json[0].elements.map((e: any) => e.id);
    expect(ids).toEqual(['x;row', 'x;row-2']);
  });
});

describe('junit xml', () => {
  it('has a testsuite per feature and a testcase per scenario, failures with the failing step', () => {
    const xml = toJunitXml(results);
    expect(xml).toContain('<testsuite name="Login" tests="2" failures="1"');
    expect(xml).toContain('<testsuite name="Todo" tests="1" failures="1"');
    expect(xml).toContain('<testcase name="ok" classname="Login" time="0.015"');
    expect(xml).toMatch(/<testcase name="bad" classname="Login"[^>]*>\s*<failure message="When I click it: which one\?"/);
    expect(xml).toContain('&lt;b&gt;'); // escaped
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it('drops control characters and ANSI-derived bytes, and encodes newlines, in a detail', () => {
    const withControlChars: ScenarioResult[] = [
      {
        scenario: { uri: 'features/x.feature', feature: 'X', name: 'ctrl', occurrence: 0, tags: [], steps: [] },
        steps: [
          {
            step: { keyword: 'Then', text: 'x' },
            status: 'failed',
            detail: '\u001b[2mexpect\u001b[22m(locator).toBeVisible()\nreceived: hidden',
            durationMs: 1,
          },
        ],
      },
    ];
    const xml = toJunitXml(withControlChars);
    // eslint-disable-next-line no-control-regex
    expect(xml).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/); // the ESC byte (\x1b) is gone
    expect(xml).toContain('&#10;received: hidden'); // newline encoded, not a literal line break
  });
});

const scenario: Scenario = { uri: 'a.feature', feature: 'A', name: 's', occurrence: 0, tags: [], steps: [] };
const stepResult: StepResult = { step: { keyword: 'Given', text: 'x' }, status: 'passed', durationMs: 1 };
const scenarioResult: ScenarioResult = { scenario, steps: [stepResult] };

describe('combine', () => {
  it('fans out every event to every reporter, in order', () => {
    const calls: string[] = [];
    const spy = (name: string): Reporter => ({
      start: () => calls.push(`${name}:start`),
      scenarioStart: () => calls.push(`${name}:scenarioStart`),
      step: () => calls.push(`${name}:step`),
      scenarioEnd: () => calls.push(`${name}:scenarioEnd`),
      end: () => calls.push(`${name}:end`),
    });
    const reporter = combine([spy('a'), spy('b')]);

    reporter.start?.([scenario]);
    reporter.scenarioStart(scenario);
    reporter.step(scenario, stepResult);
    reporter.scenarioEnd(scenarioResult);
    reporter.end([scenarioResult]);

    expect(calls).toEqual([
      'a:start', 'b:start',
      'a:scenarioStart', 'b:scenarioStart',
      'a:step', 'b:step',
      'a:scenarioEnd', 'b:scenarioEnd',
      'a:end', 'b:end',
    ]);
  });

  it('tolerates a reporter with no start()', () => {
    const calls: string[] = [];
    const noStart: Reporter = {
      scenarioStart: () => calls.push('scenarioStart'),
      step: () => calls.push('step'),
      scenarioEnd: () => calls.push('scenarioEnd'),
      end: () => calls.push('end'),
    };
    const reporter = combine([noStart]);
    expect(() => reporter.start?.([scenario])).not.toThrow();
    reporter.scenarioStart(scenario);
    expect(calls).toEqual(['scenarioStart']);
  });
});

describe('createReporters', () => {
  it('builds a console reporter that writes lines via the given write function', () => {
    const lines: string[] = [];
    const reporter = createReporters(['console'], {
      reportDir: 'jevcumber-report',
      isTTY: false,
      write: (line) => lines.push(line),
    });
    reporter.scenarioStart(scenario);
    reporter.step(scenario, stepResult);
    reporter.scenarioEnd(scenarioResult);
    expect(lines).toContain('  Scenario: s');
  });

  it('builds a json reporter that writes cucumber JSON to reportDir/results.json on end', () => {
    const reportDir = mkdtempSync(join(tmpdir(), 'jevcumber-'));
    const reporter = createReporters(['json'], { reportDir, isTTY: false });
    reporter.end([scenarioResult]);
    const outPath = join(reportDir, 'results.json');
    expect(existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(parsed[0].elements[0].name).toBe('s');
  });

  it('builds a junit reporter that writes XML to the given output path on end', () => {
    const reportDir = mkdtempSync(join(tmpdir(), 'jevcumber-'));
    const outPath = join(reportDir, 'custom.xml');
    const reporter = createReporters(['junit'], { reportDir, isTTY: false, output: outPath });
    reporter.end([scenarioResult]);
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, 'utf8')).toContain('<testsuite name="A"');
  });

  it('combines multiple reporters selected by name', () => {
    const reportDir = mkdtempSync(join(tmpdir(), 'jevcumber-'));
    const lines: string[] = [];
    const reporter = createReporters(['console', 'json'], { reportDir, isTTY: false, write: (l) => lines.push(l) });
    reporter.scenarioStart(scenario);
    reporter.step(scenario, stepResult);
    reporter.scenarioEnd(scenarioResult);
    reporter.end([scenarioResult]);
    expect(lines).toContain('  Scenario: s');
    expect(existsSync(join(reportDir, 'results.json'))).toBe(true);
  });

  it('throws for an unknown reporter name', () => {
    expect(() => createReporters(['xml' as never], { reportDir: 'jevcumber-report', isTTY: false })).toThrow(
      /Unknown reporter "xml"/,
    );
  });
});
