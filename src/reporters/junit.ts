import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ScenarioResult, StepResult } from '../types.js';
import type { Reporter } from './index.js';

const scenarioPassed = (result: ScenarioResult) =>
  result.steps.every((step) => step.status === 'passed' || step.status === 'healed');

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const scenarioTimeSeconds = (result: ScenarioResult) =>
  result.steps.reduce((total, step) => total + step.durationMs, 0) / 1000;

function firstFailingStep(result: ScenarioResult): StepResult | undefined {
  return result.steps.find((step) => step.status !== 'passed' && step.status !== 'healed' && step.status !== 'skipped');
}

function stepLine(step: StepResult): string {
  const reason = step.detail ?? step.status;
  return `${step.step.keyword} ${step.step.text}: ${reason}`;
}

function testcaseXml(result: ScenarioResult): string {
  const time = scenarioTimeSeconds(result).toFixed(3);
  const name = escapeXml(result.scenario.name);
  const classname = escapeXml(result.scenario.feature);
  const open = `    <testcase name="${name}" classname="${classname}" time="${time}"`;

  if (scenarioPassed(result)) return `${open}/>`;

  const failingStep = firstFailingStep(result) ?? result.steps[0];
  const reason = failingStep ? (failingStep.detail ?? failingStep.status) : 'failed';
  const message = failingStep ? `${failingStep.step.keyword} ${failingStep.step.text}: ${reason}` : 'failed';
  const content = result.steps.map(stepLine).join('\n');

  return [
    `${open}>`,
    `      <failure message="${escapeXml(message)}">`,
    escapeXml(content),
    '      </failure>',
    '    </testcase>',
  ].join('\n');
}

export function toJunitXml(results: ScenarioResult[]): string {
  const features = new Map<string, ScenarioResult[]>();
  for (const result of results) {
    const list = features.get(result.scenario.uri) ?? [];
    list.push(result);
    features.set(result.scenario.uri, list);
  }

  const suites = [...features.values()].map((scenarios) => {
    const featureName = escapeXml(scenarios[0].scenario.feature);
    const tests = scenarios.length;
    const failures = scenarios.filter((r) => !scenarioPassed(r)).length;
    // A scenario's first step is never itself skipped (runScenario only starts skipping after a
    // step fails), so no scenario is ever "wholly skipped" — this JUnit dialect has no concept of
    // a partially-skipped-but-failed scenario distinct from `failures`, so `skipped` is always 0.
    const skipped = 0;
    const time = scenarios.reduce((total, r) => total + scenarioTimeSeconds(r), 0).toFixed(3);

    return [
      `  <testsuite name="${featureName}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time}">`,
      ...scenarios.map(testcaseXml),
      '  </testsuite>',
    ].join('\n');
  });

  return ['<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>', ...suites, '</testsuites>'].join('\n');
}

export function junitReporter(outputPath: string): Reporter {
  return {
    scenarioStart() {},
    step() {},
    scenarioEnd() {},
    end(results) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${toJunitXml(results)}\n`);
    },
  };
}
