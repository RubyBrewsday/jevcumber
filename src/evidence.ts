import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Scenario, Snapshot, StepStatus } from './types.js';

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';

export function scenarioDir(reportDir: string, scenario: Scenario): string {
  const feature = basename(scenario.uri).replace(/\.feature$/, '');
  const name = scenario.occurrence > 0 ? `${slug(scenario.name)}-${scenario.occurrence + 1}` : slug(scenario.name);
  return join(reportDir, feature, name);
}

export function stepDir(reportDir: string, scenario: Scenario, index: number, status: StepStatus): string {
  return join(scenarioDir(reportDir, scenario), `${index + 1}-${status}`);
}

/** What the failing step saw: a screenshot now, and the last snapshot Jev was shown (if any). */
export async function captureStep(page: Page, dir: string, snapshot: Snapshot | undefined): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: true }).catch(() => {});
  writeFileSync(join(dir, 'snapshot.json'), `${JSON.stringify(snapshot ?? { url: page.url() }, null, 2)}\n`);
}
