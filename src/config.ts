import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import type { Scenario, StepResult } from './types.js';

export interface HookContext {
  page: Page;
  scenario: Scenario;
  baseUrl?: string;
}

export interface ConfigHooks {
  beforeScenario?(ctx: HookContext): Promise<void> | void;
  afterScenario?(ctx: HookContext & { results: StepResult[] }): Promise<void> | void;
}

export interface Config {
  baseUrl?: string;
  workers?: number;
  tags?: string;
  minConfidence?: number;
  reportDir?: string;
  hooks?: ConfigHooks;
}

const CONFIG_NAMES = ['jevcumber.config.js', 'jevcumber.config.mjs'];
const ALLOWED_KEYS = new Set(['baseUrl', 'workers', 'tags', 'minConfidence', 'reportDir', 'hooks']);
const ALLOWED_HOOKS = new Set(['beforeScenario', 'afterScenario']);

/** Walks up from `from` looking for a `jevcumber.config.js`/`.mjs`, stopping at the filesystem root. */
export function findConfigFile(from: string): string | undefined {
  let dir = from;
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function validate(config: Record<string, unknown>): Config {
  if (typeof config !== 'object' || config === null) {
    throw new Error('config must export an object (a default export, or named exports)');
  }
  for (const key of Object.keys(config)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`unknown config key "${key}"`);
  }
  if ('baseUrl' in config) {
    if (typeof config.baseUrl !== 'string') throw new Error('baseUrl must be a string');
    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error('baseUrl must be an absolute URL, e.g. http://localhost:3000');
    }
  }
  if ('workers' in config && (!Number.isInteger(config.workers) || (config.workers as number) < 1)) {
    throw new Error('workers must be a positive integer');
  }
  if ('tags' in config && typeof config.tags !== 'string') {
    throw new Error('tags must be a string');
  }
  if (
    'minConfidence' in config &&
    (typeof config.minConfidence !== 'number' || config.minConfidence < 0 || config.minConfidence > 1)
  ) {
    throw new Error('minConfidence must be a number between 0 and 1');
  }
  if ('reportDir' in config && typeof config.reportDir !== 'string') {
    throw new Error('reportDir must be a string');
  }
  if ('hooks' in config) {
    const hooks = config.hooks;
    if (typeof hooks !== 'object' || hooks === null) throw new Error('hooks must be an object');
    for (const [name, value] of Object.entries(hooks)) {
      if (!ALLOWED_HOOKS.has(name)) throw new Error(`unknown hook "${name}" (expected beforeScenario or afterScenario)`);
      if (typeof value !== 'function') throw new Error(`hooks.${name} must be a function`);
    }
  }
  return config as Config;
}

/** Loads and validates a config file. `path` of `undefined` returns `{}` (no config). */
export async function loadConfig(path: string | undefined): Promise<Config> {
  if (!path) return {};
  if (!existsSync(path)) throw new Error(`config file not found: ${path}`);
  const url = pathToFileURL(path);
  // Node's import() cache keys on the URL, so re-loading a config file rewritten at the same path
  // (e.g. between test runs, or a future --watch mode) would otherwise silently return the stale
  // module. A unique query string forces a fresh import every call.
  url.search = `t=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const module = (await import(url.href)) as Record<string, unknown>;
  const raw = 'default' in module ? (module.default as Record<string, unknown>) : { ...module };
  return validate(raw);
}
