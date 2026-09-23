import { describe, expect, it } from 'vitest';
import { scenarioDir, stepDir } from '../src/evidence.js';

const scenario = { uri: 'features/login.feature', feature: 'Login', name: 'Wrong password!', occurrence: 0, tags: [], steps: [] };

describe('evidence paths', () => {
  it('slugs the scenario name under the feature basename', () => {
    expect(scenarioDir('out', scenario)).toBe('out/login/wrong-password');
    expect(scenarioDir('out', { ...scenario, occurrence: 1 })).toBe('out/login/wrong-password-2');
  });

  it('numbers steps from 1 and appends the status', () => {
    expect(stepDir('out', scenario, 2, 'failed')).toBe('out/login/wrong-password/3-failed');
  });
});
