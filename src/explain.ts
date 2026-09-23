import { loadFeatures } from './gherkin.js';
import { Lockfile, lockPathFor, stepKey } from './lockfile.js';
import type { Assertion, LocatorSpec, ResolvedStep } from './types.js';

function locatorText(locator: LocatorSpec): string {
  switch (locator.by) {
    case 'testid':
      return `[data-testid=${locator.value}]`;
    case 'role':
      return `${locator.role} "${locator.name}"`;
    case 'label':
      return `field labelled "${locator.value}"`;
    case 'placeholder':
      return `field with placeholder "${locator.value}"`;
    case 'text':
      return `element with text "${locator.value}"`;
  }
}

const pinnedSuffix = (assertion: { pinned?: true }): string => (assertion.pinned ? ' (pinned)' : '');

function describeAssertion(assertion: Assertion): string {
  switch (assertion.form) {
    case 'text_visible':
      return `expect text "${assertion.value}" visible${pinnedSuffix(assertion)}`;
    case 'text_not_visible':
      return `expect text "${assertion.value}" absent${pinnedSuffix(assertion)}`;
    case 'url_contains':
      return `expect URL to contain "${assertion.value}"${pinnedSuffix(assertion)}`;
    case 'title_contains':
      return `expect title to contain "${assertion.value}"${pinnedSuffix(assertion)}`;
    case 'heading_visible':
      return `expect heading "${assertion.value}" visible${pinnedSuffix(assertion)}`;
    case 'element_visible':
      return `expect ${locatorText(assertion.locator)} visible`;
    case 'element_has_value':
      return `expect ${locatorText(assertion.locator)} to have value "${assertion.value}"`;
    case 'semantic':
      return 'judged live by Jev each run';
  }
}

export function describeResolved(resolved: ResolvedStep): string {
  switch (resolved.kind) {
    case 'navigate':
      return `open "${resolved.value}"`;
    case 'click':
    case 'check':
    case 'uncheck':
      return `${resolved.kind} ${locatorText(resolved.locator)}`;
    case 'hover':
    case 'clear':
    case 'scroll':
      return `${resolved.kind} ${locatorText(resolved.locator)}`;
    case 'fill': {
      const base = `type "${resolved.value}" into ${locatorText(resolved.locator)}`;
      return resolved.submit ? `${base} then press Enter` : base;
    }
    case 'select':
      return `choose "${resolved.value}" in ${locatorText(resolved.locator)}`;
    case 'press':
      return resolved.locator ? `press ${resolved.key} (in ${locatorText(resolved.locator)})` : `press ${resolved.key}`;
    case 'upload':
      return `upload "${resolved.value}" to ${locatorText(resolved.locator)}`;
    case 'wait':
      if (resolved.text) return `wait for "${resolved.text}"`;
      if (resolved.seconds !== undefined) return `wait ${resolved.seconds} s`;
      return 'wait for the page to settle';
    case 'assert':
      return describeAssertion(resolved.assertion);
  }
}

export function explain(paths: string[], tags: string | undefined, write: (line: string) => void): 0 | 1 {
  const scenarios = loadFeatures(paths, tags);
  const locks = new Map<string, Lockfile>();
  let ok = true;
  let currentFeatureUri: string | undefined;

  for (const scenario of scenarios) {
    if (!locks.has(scenario.uri)) locks.set(scenario.uri, Lockfile.load(lockPathFor(scenario.uri)));
    const lock = locks.get(scenario.uri)!;

    if (scenario.uri !== currentFeatureUri) {
      currentFeatureUri = scenario.uri;
      write(`Feature: ${scenario.feature}`);
    }
    write(`  Scenario: ${scenario.name}`);

    scenario.steps.forEach((step, index) => {
      const entry = lock.getEntry(stepKey(scenario, index));
      if (!entry) {
        ok = false;
        write(`    ✗ ${step.keyword} ${step.text} → missing from lockfile`);
        return;
      }
      const mark = entry.resolved.kind === 'assert' && entry.resolved.assertion.form === 'semantic' ? '~' : '✓';
      write(`    ${mark} ${step.keyword} ${step.text} → ${describeResolved(entry.resolved)}`);
    });
  }

  return ok ? 0 : 1;
}
