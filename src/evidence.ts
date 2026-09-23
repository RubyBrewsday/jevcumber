import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { Page } from '@playwright/test';
import type { Scenario, Snapshot, StepStatus } from './types.js';

// A name that slugs to nothing (e.g. all non-Latin characters) falls back to a short hash, so two
// such scenarios still land in distinct directories instead of colliding on "scenario".
const slug = (text: string) => {
  const slugged = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slugged || createHash('sha1').update(text).digest('hex').slice(0, 8);
};

// Two feature files with the same basename (e.g. features/admin/login.feature and
// features/user/login.feature) must not land in the same report directory. Prefixing with the
// feature's own directory, relative to cwd, disambiguates them. A uri outside cwd (an absolute
// path elsewhere — typical of a test workspace in a tmp directory) falls back to no prefix rather
// than a deep chain of slugged ".." segments, matching the old, directory-less behaviour.
function featureDirSegments(uri: string): string[] {
  const rel = relative(process.cwd(), dirname(uri));
  if (rel === '' || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) return [];
  return rel.split(/[\\/]/).filter(Boolean).map(slug);
}

export function scenarioDir(reportDir: string, scenario: Scenario): string {
  const feature = basename(scenario.uri).replace(/\.feature$/, '');
  const name = scenario.occurrence > 0 ? `${slug(scenario.name)}-${scenario.occurrence + 1}` : slug(scenario.name);
  return join(reportDir, ...featureDirSegments(scenario.uri), feature, name);
}

export function stepDir(reportDir: string, scenario: Scenario, index: number, status: StepStatus): string {
  return join(scenarioDir(reportDir, scenario), `${index + 1}-${status}`);
}

/**
 * What the failing step saw: a screenshot now, and the last snapshot Jev was shown (if any).
 * Best-effort: evidence capture must never throw into the runner and abort an otherwise-good run.
 * Returns whether it actually wrote anything, so the caller only records `evidenceDir` when true.
 */
export async function captureStep(page: Page, dir: string, snapshot: Snapshot | undefined): Promise<boolean> {
  try {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: true }).catch(() => {});
    writeFileSync(join(dir, 'snapshot.json'), `${JSON.stringify(snapshot ?? { url: page.url() }, null, 2)}\n`);
    return true;
  } catch {
    // evidence is a courtesy, not a requirement: a bad report dir must not fail the run
    return false;
  }
}
