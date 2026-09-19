import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFeatureFiles, loadFeatures, parseFeature } from '../src/gherkin.js';

const SOURCE = `Feature: Login
  Background:
    Given I am on "/login"

  @smoke
  Scenario Outline: log in as <email>
    When I fill in the email field with "<email>"
    And I click the Log in button
    Then I should see "Welcome"
    But I should not see "Error"

    Examples:
      | email   |
      | a@b.c   |
      | d@e.f   |

  Scenario: table and docstring
    When I add todos
      | Buy milk |
      | Walk dog |
    Then the note reads
      """
      hello
      """
`;

describe('parseFeature', () => {
  const scenarios = parseFeature(SOURCE, 'login.feature');

  it('expands outlines and prepends the background', () => {
    expect(scenarios.map((s) => s.name)).toEqual([
      'log in as a@b.c',
      'log in as d@e.f',
      'table and docstring',
    ]);
    expect(scenarios[0].steps.map((s) => s.text)).toEqual([
      'I am on "/login"',
      'I fill in the email field with "a@b.c"',
      'I click the Log in button',
      'I should see "Welcome"',
      'I should not see "Error"',
    ]);
  });

  it('normalizes And/But to the preceding primary keyword', () => {
    expect(scenarios[0].steps.map((s) => s.keyword)).toEqual(['Given', 'When', 'When', 'Then', 'Then']);
  });

  it('carries feature name, uri, and tags', () => {
    expect(scenarios[0]).toMatchObject({ uri: 'login.feature', feature: 'Login', tags: ['@smoke'] });
    expect(scenarios[2].tags).toEqual([]);
  });

  it('carries data tables and docstrings', () => {
    expect(scenarios[2].steps[1].table).toEqual([['Buy milk'], ['Walk dog']]);
    expect(scenarios[2].steps[2].docString).toBe('hello');
  });

  it('throws on a parse error, naming the file', () => {
    expect(() => parseFeature('this is not gherkin\n', 'bad.feature')).toThrow(/bad\.feature/);
  });
});

describe('loadFeatures', () => {
  it('finds .feature files recursively and filters by tag expression', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-'));
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'login.feature'), SOURCE);
    writeFileSync(join(dir, 'notes.txt'), 'ignore me');

    expect(findFeatureFiles([dir])).toEqual([join(dir, 'nested', 'login.feature')]);
    expect(loadFeatures([dir], '@smoke').map((s) => s.name)).toEqual(['log in as a@b.c', 'log in as d@e.f']);
    expect(loadFeatures([dir], 'not @smoke').map((s) => s.name)).toEqual(['table and docstring']);
    expect(loadFeatures([dir])).toHaveLength(3);
  });
});
