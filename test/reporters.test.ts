import { describe, expect, it } from 'vitest';
import { toCucumberJson } from '../src/reporters/json.js';
import { toJunitXml } from '../src/reporters/junit.js';
import type { ScenarioResult } from '../src/types.js';

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
});
