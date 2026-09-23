import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { captureStep, scenarioDir, stepDir } from '../src/evidence.js';

const scenario = { uri: 'features/login.feature', feature: 'Login', name: 'Wrong password!', occurrence: 0, tags: [], steps: [] };

describe('evidence paths', () => {
  it('slugs the scenario name under the feature basename', () => {
    expect(scenarioDir('out', scenario)).toBe('out/login/wrong-password');
    expect(scenarioDir('out', { ...scenario, occurrence: 1 })).toBe('out/login/wrong-password-2');
  });

  it('numbers steps from 1 and appends the status', () => {
    expect(stepDir('out', scenario, 2, 'failed')).toBe('out/login/wrong-password/3-failed');
  });
});

describe('captureStep', () => {
  it('resolves without throwing when the screenshot rejects and the dir is unwritable', async () => {
    // A regular file where the evidence dir wants to be: mkdirSync(..., {recursive: true}) throws ENOTDIR.
    const blocker = join(mkdtempSync(join(tmpdir(), 'jevcumber-evidence-')), 'blocker');
    writeFileSync(blocker, 'not a directory');
    const dir = join(blocker, 'sub', '1-failed');

    const page = { screenshot: async () => { throw new Error('boom: screenshot failed'); }, url: () => 'http://example.test' } as unknown as Page;

    await expect(captureStep(page, dir, undefined)).resolves.toBeUndefined();
  });
});
