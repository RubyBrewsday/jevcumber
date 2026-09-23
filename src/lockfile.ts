import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ResolvedStep, Scenario } from './types.js';

const VERSION = 2;
const READABLE_VERSIONS = new Set([1, 2]);

interface LockEntry {
  text: string;
  resolved: ResolvedStep;
  confidence?: number;
}

export function stepKey(scenario: Scenario, index: number): string {
  const step = scenario.steps[index];
  const identity = JSON.stringify([
    scenario.name,
    scenario.occurrence,
    index,
    step.text,
    step.table ?? null,
    step.docString ?? null,
  ]);
  return createHash('sha256').update(identity).digest('hex');
}

export function lockPathFor(featureUri: string): string {
  return `${featureUri}.lock.json`;
}

export class Lockfile {
  private touched = new Set<string>();
  private dirty: boolean;

  private constructor(
    private readonly path: string,
    private steps: Record<string, LockEntry>,
    dirty = false,
  ) {
    this.dirty = dirty;
  }

  static load(path: string): Lockfile {
    if (!existsSync(path)) return new Lockfile(path, {});
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!READABLE_VERSIONS.has(data.version)) {
      throw new Error(`${path}: unsupported lockfile version ${data.version} (expected ${VERSION})`);
    }
    return new Lockfile(path, data.steps ?? {}, data.version !== VERSION);
  }

  get(key: string): ResolvedStep | undefined {
    this.touched.add(key);
    return this.steps[key]?.resolved;
  }

  getEntry(key: string): { resolved: ResolvedStep; confidence?: number } | undefined {
    this.touched.add(key);
    const entry = this.steps[key];
    if (!entry) return undefined;
    return entry.confidence === undefined
      ? { resolved: entry.resolved }
      : { resolved: entry.resolved, confidence: entry.confidence };
  }

  set(key: string, text: string, resolved: ResolvedStep, confidence?: number): void {
    this.touched.add(key);
    this.steps[key] = { text, resolved, ...(confidence === undefined ? {} : { confidence }) };
    this.dirty = true;
  }

  touch(key: string): void {
    this.touched.add(key);
  }

  save(prune: boolean): void {
    if (prune) {
      for (const key of Object.keys(this.steps)) {
        if (!this.touched.has(key)) {
          delete this.steps[key];
          this.dirty = true;
        }
      }
    }
    if (!this.dirty) return;
    const sorted = Object.fromEntries(Object.entries(this.steps).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(this.path, `${JSON.stringify({ version: VERSION, steps: sorted }, null, 2)}\n`);
    this.dirty = false;
  }
}
