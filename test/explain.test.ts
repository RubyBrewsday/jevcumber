import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeResolved, explain } from '../src/explain.js';
import { parseFeature } from '../src/gherkin.js';
import { lockPathFor, stepKey } from '../src/lockfile.js';
import type { ResolvedStep } from '../src/types.js';

describe('describeResolved', () => {
  const cases: [string, ResolvedStep, string][] = [
    ['navigate', { kind: 'navigate', value: '/login' }, 'open "/login"'],
    ['click role', { kind: 'click', locator: { by: 'role', role: 'button', name: 'Log in' } }, 'click button "Log in"'],
    ['check', { kind: 'check', locator: { by: 'role', role: 'checkbox', name: 'Remember me' } }, 'check checkbox "Remember me"'],
    ['uncheck', { kind: 'uncheck', locator: { by: 'role', role: 'checkbox', name: 'Remember me' } }, 'uncheck checkbox "Remember me"'],
    ['hover', { kind: 'hover', locator: { by: 'role', role: 'link', name: 'Sign out' } }, 'hover link "Sign out"'],
    ['clear', { kind: 'clear', locator: { by: 'role', role: 'textbox', name: 'New todo' } }, 'clear textbox "New todo"'],
    ['scroll', { kind: 'scroll', locator: { by: 'role', role: 'button', name: 'Add' } }, 'scroll button "Add"'],
    [
      'fill without submit',
      { kind: 'fill', locator: { by: 'role', role: 'searchbox', name: 'Search Wikipedia' }, value: 'bagel' },
      'type "bagel" into searchbox "Search Wikipedia"',
    ],
    [
      'fill with submit',
      { kind: 'fill', locator: { by: 'role', role: 'searchbox', name: 'Search Wikipedia' }, value: 'bagel', submit: true },
      'type "bagel" into searchbox "Search Wikipedia" then press Enter',
    ],
    [
      'select',
      { kind: 'select', locator: { by: 'role', role: 'combobox', name: 'Country' }, value: 'France' },
      'choose "France" in combobox "Country"',
    ],
    [
      'press with locator',
      { kind: 'press', key: 'Enter', locator: { by: 'role', role: 'textbox', name: 'Search' } },
      'press Enter (in textbox "Search")',
    ],
    ['press without locator', { kind: 'press', key: 'Enter' }, 'press Enter'],
    [
      'upload',
      { kind: 'upload', locator: { by: 'label', value: 'Avatar' }, value: 'avatar.png' },
      'upload "avatar.png" to field labelled "Avatar"',
    ],
    ['wait for text', { kind: 'wait', text: 'Done' }, 'wait for "Done"'],
    ['wait for seconds', { kind: 'wait', seconds: 3 }, 'wait 3 s'],
    ['wait for settle', { kind: 'wait' }, 'wait for the page to settle'],
    [
      'assert text visible',
      { kind: 'assert', assertion: { form: 'text_visible', value: 'Welcome' } },
      'expect text "Welcome" visible',
    ],
    [
      'assert text visible pinned',
      { kind: 'assert', assertion: { form: 'text_visible', value: 'Welcome', pinned: true } },
      'expect text "Welcome" visible (pinned)',
    ],
    [
      'assert text not visible',
      { kind: 'assert', assertion: { form: 'text_not_visible', value: 'Error' } },
      'expect text "Error" absent',
    ],
    [
      'assert url contains',
      { kind: 'assert', assertion: { form: 'url_contains', value: '/todos' } },
      'expect URL to contain "/todos"',
    ],
    [
      'assert title contains',
      { kind: 'assert', assertion: { form: 'title_contains', value: 'Bagel - Wikipedia' } },
      'expect title to contain "Bagel - Wikipedia"',
    ],
    [
      'assert heading visible',
      { kind: 'assert', assertion: { form: 'heading_visible', value: 'Bagel' } },
      'expect heading "Bagel" visible',
    ],
    [
      'assert element visible',
      { kind: 'assert', assertion: { form: 'element_visible', locator: { by: 'role', role: 'textbox', name: 'New todo' } } },
      'expect textbox "New todo" visible',
    ],
    [
      'assert element has value',
      {
        kind: 'assert',
        assertion: { form: 'element_has_value', locator: { by: 'role', role: 'textbox', name: 'New todo' }, value: 'x' },
      },
      'expect textbox "New todo" to have value "x"',
    ],
    ['assert semantic', { kind: 'assert', assertion: { form: 'semantic' } }, 'judged live by Jev each run'],
    [
      'testid locator',
      { kind: 'click', locator: { by: 'testid', value: 'submit-btn' } },
      'click [data-testid=submit-btn]',
    ],
    [
      'placeholder locator',
      { kind: 'click', locator: { by: 'placeholder', value: 'Search…' } },
      'click field with placeholder "Search…"',
    ],
    ['text locator', { kind: 'click', locator: { by: 'text', value: 'Learn more' } }, 'click element with text "Learn more"'],
  ];

  it.each(cases)('%s', (_label, resolved, expected) => {
    expect(describeResolved(resolved)).toBe(expected);
  });
});

describe('explain', () => {
  function workspace(): { dir: string; feature: string } {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-explain-'));
    const feature = join(dir, 'a.feature');
    writeFileSync(
      feature,
      [
        'Feature: A',
        '  Scenario: one',
        '    Given I am on "/login"',
        '    When I see a greeting',
        '    Then I click the Add button',
        '',
      ].join('\n'),
    );
    return { dir, feature };
  }

  it('prints each step\'s resolution with a confidence mark, and returns 1 when a step is missing', () => {
    const { dir, feature } = workspace();
    const [scenario] = parseFeature(readFileSync(feature, 'utf8'), feature);
    const entries = {
      [stepKey(scenario, 0)]: { text: scenario.steps[0].text, resolved: { kind: 'navigate', value: '/login' }, confidence: 0.97 },
      [stepKey(scenario, 1)]: { text: scenario.steps[1].text, resolved: { kind: 'assert', assertion: { form: 'semantic' } } },
    };
    writeFileSync(lockPathFor(feature), JSON.stringify({ version: 2, steps: entries }, null, 2));

    const lines: string[] = [];
    expect(explain([dir], undefined, (line) => lines.push(line))).toBe(1);

    expect(lines).toContain('Feature: A');
    expect(lines).toContain('  Scenario: one');
    expect(lines).toContain('    ✓ Given I am on "/login" → open "/login"');
    expect(lines).toContain('    ~ When I see a greeting → judged live by Jev each run');
    expect(lines.some((l) => l.startsWith('    ✗ Then I click the Add button'))).toBe(true);
  });

  it('returns 0 when every step has a lockfile entry', () => {
    const { dir, feature } = workspace();
    const [scenario] = parseFeature(readFileSync(feature, 'utf8'), feature);
    const resolved: Record<number, ResolvedStep> = {
      0: { kind: 'navigate', value: '/login' },
      1: { kind: 'assert', assertion: { form: 'semantic' } },
      2: { kind: 'click', locator: { by: 'role', role: 'button', name: 'Add' } },
    };
    const entries = Object.fromEntries(
      scenario.steps.map((step, index) => [stepKey(scenario, index), { text: step.text, resolved: resolved[index] }]),
    );
    writeFileSync(lockPathFor(feature), JSON.stringify({ version: 2, steps: entries }, null, 2));

    const lines: string[] = [];
    expect(explain([dir], undefined, (line) => lines.push(line))).toBe(0);
  });
});
