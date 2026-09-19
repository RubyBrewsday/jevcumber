import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ResolvedStep, Scenario } from './types.js';

const VERSION = 1;

interface LockEntry {
  text: string;
  resolved: ResolvedStep;
}

export function stepKey(scenario: Scenario, index: number): string {
  const step = scenario.steps[index];
  const identity = JSON.stringify([scenario.name, index, step.text, step.table ?? null, step.docString ?? null]);
  return createHash('sha256').update(identity).digest('hex');
}

export function lockPathFor(featureUri: string): string {
  return `${featureUri}.lock.json`;
}

export class Lockfile {
  private touched = new Set<string>();
  private dirty = false;

  private constructor(
    private readonly path: string,
    private steps: Record<string, LockEntry>,
  ) {}

  static load(path: string): Lockfile {
    if (!existsSync(path)) return new Lockfile(path, {});
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data.version !== VERSION) {
      throw new Error(`${path}: unsupported lockfile version ${data.version} (expected ${VERSION})`);
    }
    return new Lockfile(path, data.steps ?? {});
  }

  get(key: string): ResolvedStep | undefined {
    this.touched.add(key);
    return this.steps[key]?.resolved;
  }

  set(key: string, text: string, resolved: ResolvedStep): void {
    this.touched.add(key);
    this.steps[key] = { text, resolved };
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
