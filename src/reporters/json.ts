import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ScenarioResult, StepResult, StepStatus } from '../types.js';
import type { Reporter } from './index.js';

// Cucumber "classic" JSON statuses: no place for 'healed' or 'ambiguous', so they collapse
// onto the nearest cucumber status (healed -> passed since the scenario still holds;
// ambiguous -> undefined since cucumber has no separate concept for it).
const CUCUMBER_STATUS: Record<StepStatus, string> = {
  passed: 'passed',
  healed: 'passed',
  failed: 'failed',
  ambiguous: 'undefined',
  undefined: 'undefined',
  skipped: 'skipped',
};

function slug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toStepJson(result: StepResult) {
  const stepResult: { status: string; duration: number; error_message?: string } = {
    status: CUCUMBER_STATUS[result.status],
    duration: result.durationMs * 1_000_000,
  };
  if (result.detail) stepResult.error_message = result.detail;
  return {
    keyword: `${result.step.keyword} `,
    name: result.step.text,
    result: stepResult,
  };
}

export function toCucumberJson(results: ScenarioResult[]): unknown {
  const features = new Map<string, { uri: string; id: string; keyword: 'Feature'; name: string; elements: unknown[] }>();

  for (const result of results) {
    const { scenario } = result;
    let feature = features.get(scenario.uri);
    if (!feature) {
      feature = { uri: scenario.uri, id: slug(scenario.feature), keyword: 'Feature', name: scenario.feature, elements: [] };
      features.set(scenario.uri, feature);
    }
    const scenarioSlug = scenario.occurrence > 0 ? `${slug(scenario.name)}-${scenario.occurrence + 1}` : slug(scenario.name);
    feature.elements.push({
      id: `${feature.id};${scenarioSlug}`,
      keyword: 'Scenario',
      name: scenario.name,
      type: 'scenario',
      tags: scenario.tags.map((name) => ({ name })),
      steps: result.steps.map(toStepJson),
    });
  }

  return [...features.values()];
}

export function jsonReporter(outputPath: string): Reporter {
  return {
    scenarioStart() {},
    step() {},
    scenarioEnd() {},
    end(results) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(toCucumberJson(results), null, 2)}\n`);
    },
  };
}
