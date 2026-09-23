import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { chromium, type Browser } from '@playwright/test';
import { startFixtureServer } from '../fixtures/app/server.js';
import { RESOLVED } from '../fixtures/expected.js';
import { extractValues } from '../src/candidates.js';
import { execute } from '../src/executor.js';
import { parseFeature } from '../src/gherkin.js';
import { createClient, judge, resolve, type JevClient } from '../src/resolver.js';
import { snapshot } from '../src/snapshot.js';

const FEATURES = ['fixtures/features/login.feature', 'fixtures/eval/live-only.feature'];

// Calls the real Jev API: asks Jev about every fixture step on the page state that step really sees
// (the known-good action is executed afterwards, so one wrong answer cannot derail later steps),
// and prints each answer's distribution so question wording can be tuned from evidence.
describe.skipIf(!process.env.TYPESAFE_API_KEY)('Jev resolves the fixture steps to their known-good resolutions', () => {
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  let browser: Browser;
  beforeAll(async () => {
    server = await startFixtureServer();
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it('matches on every step with confidence above the default threshold', async () => {
    const real = createClient();
    let lastAnswers: Record<string, any> = {};
    const client: JevClient = {
      systemOne: async (request) => {
        const response = await real.systemOne(request);
        lastAnswers = response.answers;
        return response;
      },
    };

    const lines: string[] = [];
    let wrong = 0;
    const scenarios = FEATURES.flatMap((file) => parseFeature(readFileSync(file, 'utf8'), file));
    for (const scenario of scenarios) {
      const context = await browser.newContext();
      const page = await context.newPage();
      lines.push(`\nScenario: ${scenario.name}`);
      for (const [index, step] of scenario.steps.entries()) {
        const outcome = await resolve({
          step,
          scenarioName: scenario.name,
          previousSteps: scenario.steps.slice(0, index).map((s) => s.text),
          snapshot: await snapshot(page, { relevantTo: step.text }),
          values: extractValues(step),
          client,
          minConfidence: 0.6,
        });
        const expected = RESOLVED[step.text];
        const matches = outcome.ok && JSON.stringify(outcome.resolved) === JSON.stringify(expected);
        if (!matches) wrong++;

        lines.push(`${matches ? 'ok  ' : 'MISS'} ${step.keyword} ${step.text}`);
        if (!matches) {
          lines.push(`       expected ${JSON.stringify(expected)}`);
          lines.push(`       got      ${outcome.ok ? JSON.stringify(outcome.resolved) : `${outcome.reason}: ${outcome.detail}`}`);
        }
        for (const [id, answer] of Object.entries(lastAnswers)) {
          const top = Object.entries(answer.probabilities as Record<string, number>)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([label, p]) => `${label} ${(p * 100).toFixed(0)}%`)
            .join(', ');
          lines.push(`       ${id.padEnd(16)} conf ${answer.confidence.toFixed(2)}  ${top}`);
        }
        await execute(page, expected, {
          baseUrl: server.url,
          stepText: step.text,
          semantic: async (text) => (await judge(real, text, await snapshot(page, { elements: false }))).holds,
        });
      }
      await context.close();
    }
    console.log(lines.join('\n'));
    expect(wrong).toBe(0);
  }, 180_000);
});
