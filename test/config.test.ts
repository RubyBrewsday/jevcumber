import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findConfigFile, loadConfig } from '../src/config.js';

describe('findConfigFile', () => {
  it('walks up from a nested directory to find jevcumber.config.mjs', () => {
    const root = mkdtempSync(join(tmpdir(), 'jevcumber-config-'));
    const a = join(root, 'a');
    const b = join(a, 'b');
    mkdirSync(b, { recursive: true });
    const configPath = join(a, 'jevcumber.config.mjs');
    writeFileSync(configPath, 'export default { baseUrl: "http://x", workers: 2 };\n');

    expect(findConfigFile(b)).toBe(configPath);
  });

  it('returns undefined when no config file exists up to the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'jevcumber-config-'));
    expect(findConfigFile(root)).toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('returns {} when no path is given', async () => {
    expect(await loadConfig(undefined)).toEqual({});
  });

  it('loads a default export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-config-'));
    const file = join(dir, 'jevcumber.config.mjs');
    writeFileSync(file, 'export default { baseUrl: "http://x", workers: 2 };\n');
    expect(await loadConfig(file)).toEqual({ baseUrl: 'http://x', workers: 2 });
  });

  it('loads named exports when there is no default export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-config-'));
    const file = join(dir, 'jevcumber.config.mjs');
    writeFileSync(file, 'export const baseUrl = "http://x";\nexport const workers = 3;\n');
    expect(await loadConfig(file)).toEqual({ baseUrl: 'http://x', workers: 3 });
  });

  it('throws on an unknown config key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-config-'));
    const file = join(dir, 'jevcumber.config.mjs');
    writeFileSync(file, 'export default { foo: 1 };\n');
    await expect(loadConfig(file)).rejects.toThrow(/unknown config key "foo"/);
  });

  it('throws when workers is not a positive integer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-config-'));
    const file = join(dir, 'jevcumber.config.mjs');
    writeFileSync(file, 'export default { workers: "two" };\n');
    await expect(loadConfig(file)).rejects.toThrow(/workers/);
  });

  it('throws when minConfidence is out of range', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-config-'));
    const file = join(dir, 'jevcumber.config.mjs');
    writeFileSync(file, 'export default { minConfidence: 1.5 };\n');
    await expect(loadConfig(file)).rejects.toThrow(/minConfidence/);
  });

  it('accepts hooks as an object of functions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-config-'));
    const file = join(dir, 'jevcumber.config.mjs');
    writeFileSync(
      file,
      'export default { hooks: { beforeScenario: async () => {}, afterScenario: () => {} } };\n',
    );
    const config = await loadConfig(file);
    expect(typeof config.hooks?.beforeScenario).toBe('function');
    expect(typeof config.hooks?.afterScenario).toBe('function');
  });
});
