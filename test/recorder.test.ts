import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordEval } from '../src/recorder.js';
import type { Scenario } from '../src/types.js';

const scenario: Scenario = {
  uri: 'login.feature',
  feature: 'Login',
  name: 'Wrong password',
  occurrence: 0,
  tags: [],
  steps: [],
};

const step = { keyword: 'When' as const, text: 'I fill in the password field with "wrong"' };
const exchange = { state: { step }, questions: { kind: { type: 'choice' } }, answers: { kind: { choice: 'fill' } } };

describe('recordEval', () => {
  it('writes a resolve exchange under <dir>/<feature>/<scenario-slug>/<index+1>.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-record-'));
    recordEval(dir, scenario, 2, 'resolve', { step, exchange, outcome: { ok: true, resolved: { kind: 'fill' }, confidence: 0.9 } });

    const file = join(dir, 'login', 'wrong-password', '3.json');
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written).toEqual({
      step,
      state: exchange.state,
      questions: exchange.questions,
      answers: exchange.answers,
      outcome: { ok: true, resolved: { kind: 'fill' }, confidence: 0.9 },
    });
  });

  it('writes a judge exchange under <dir>/<feature>/<scenario-slug>/<index+1>-judge.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-record-'));
    recordEval(dir, scenario, 2, 'judge', { step, exchange, outcome: { holds: 0.9 } });

    const file = join(dir, 'login', 'wrong-password', '3-judge.json');
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.outcome).toEqual({ holds: 0.9 });
  });

  it('creates the directory when it does not exist yet', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'jevcumber-record-')), 'nested', 'more');
    expect(recordEval(dir, scenario, 0, 'resolve', { step, exchange, outcome: { ok: true, resolved: { kind: 'fill' }, confidence: 0.9 } })).toBe(true);
    expect(readFileSync(join(dir, 'login', 'wrong-password', '1.json'), 'utf8')).toBeTruthy();
  });

  it('is best-effort: a record dir colliding with an existing file returns false instead of throwing', () => {
    const parent = mkdtempSync(join(tmpdir(), 'jevcumber-record-'));
    const blockingFile = join(parent, 'not-a-directory');
    writeFileSync(blockingFile, 'just a file');

    let result: boolean | undefined;
    expect(() => {
      result = recordEval(blockingFile, scenario, 0, 'resolve', { step, exchange, outcome: { ok: true, resolved: { kind: 'fill' }, confidence: 0.9 } });
    }).not.toThrow();
    expect(result).toBe(false);
  });
});
