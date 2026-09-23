import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { captureStep, scenarioDir, stepDir } from '../src/evidence.js';

const scenario = { uri: 'features/login.feature', feature: 'Login', name: 'Wrong password!', occurrence: 0, tags: [], steps: [] };

describe('evidence paths', () => {
  it('slugs the scenario name under the feature basename, prefixed by the feature\'s own directory relative to cwd', () => {
    // scenario.uri is 'features/login.feature': relative to cwd (the project root while tests
    // run) that's just the 'features' directory.
    expect(scenarioDir('out', scenario)).toBe('out/features/login/wrong-password');
    expect(scenarioDir('out', { ...scenario, occurrence: 1 })).toBe('out/features/login/wrong-password-2');
  });

  it('keeps two same-named feature files in different directories from colliding', () => {
    const admin = { ...scenario, uri: 'features/admin/login.feature' };
    const user = { ...scenario, uri: 'features/user/login.feature' };
    expect(scenarioDir('out', admin)).not.toBe(scenarioDir('out', user));
    expect(scenarioDir('out', admin)).toBe('out/features/admin/login/wrong-password');
    expect(scenarioDir('out', user)).toBe('out/features/user/login/wrong-password');
  });

  it('falls back to no directory prefix for a feature path outside cwd (e.g. an absolute tmp path)', () => {
    const outside = { ...scenario, uri: '/tmp/somewhere/else/login.feature' };
    expect(scenarioDir('out', outside)).toBe('out/login/wrong-password');
  });

  it('falls back to a short hash when the name slugs to nothing', () => {
    const nonLatin = { ...scenario, name: '日本語のシナリオ名' };
    const dir = scenarioDir('out', nonLatin);
    expect(dir).toMatch(/^out\/features\/login\/[0-9a-f]{8}$/);
    // Deterministic and distinct from a different non-Latin name.
    expect(scenarioDir('out', nonLatin)).toBe(dir);
    expect(scenarioDir('out', { ...nonLatin, name: '別のシナリオ' })).not.toBe(dir);
  });

  it('numbers steps from 1 and appends the status', () => {
    expect(stepDir('out', scenario, 2, 'failed')).toBe('out/features/login/wrong-password/3-failed');
  });
});

describe('captureStep', () => {
  it('resolves false instead of throwing when the screenshot rejects and the dir is unwritable', async () => {
    // A regular file where the evidence dir wants to be: mkdirSync(..., {recursive: true}) throws ENOTDIR.
    const blocker = join(mkdtempSync(join(tmpdir(), 'jevcumber-evidence-')), 'blocker');
    writeFileSync(blocker, 'not a directory');
    const dir = join(blocker, 'sub', '1-failed');

    const page = { screenshot: async () => { throw new Error('boom: screenshot failed'); }, url: () => 'http://example.test' } as unknown as Page;

    await expect(captureStep(page, dir, undefined)).resolves.toBe(false);
  });

  it('resolves true when it successfully writes the screenshot and snapshot', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'jevcumber-evidence-')), '1-failed');
    const page = { screenshot: async () => {}, url: () => 'http://example.test' } as unknown as Page;
    await expect(captureStep(page, dir, undefined)).resolves.toBe(true);
  });
});
