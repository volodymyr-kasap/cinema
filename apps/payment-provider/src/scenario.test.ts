import { describe, expect, it } from 'vitest';

import { pickScenario, type ScenarioWeights } from './scenario';

const weights: ScenarioWeights = { success: 0.85, decline: 0.1, error: 0.03, timeout: 0.02 };

describe('pickScenario', () => {
  it('obeys the header when one is given', () => {
    // Determinism for tests comes from here and nowhere else: a suite that had
    // to coax an outcome out of a random provider would be a flaky suite.
    expect(pickScenario('timeout', weights, () => 0)).toBe('timeout');
    expect(pickScenario('decline', weights, () => 0)).toBe('decline');
  });

  it('ignores a header it does not recognise and rolls instead', () => {
    expect(pickScenario('sideways', weights, () => 0)).toBe('success');
  });

  it('maps the unit interval onto the weights in order', () => {
    expect(pickScenario(undefined, weights, () => 0)).toBe('success');
    expect(pickScenario(undefined, weights, () => 0.849)).toBe('success');
    expect(pickScenario(undefined, weights, () => 0.851)).toBe('decline');
    expect(pickScenario(undefined, weights, () => 0.951)).toBe('error');
    expect(pickScenario(undefined, weights, () => 0.985)).toBe('timeout');
  });

  it('returns success when the roll lands past the last boundary', () => {
    // Weights that do not sum to one are a configuration mistake, not a reason
    // to return undefined into a switch statement.
    expect(
      pickScenario(undefined, { success: 0.1, decline: 0, error: 0, timeout: 0 }, () => 0.9),
    ).toBe('success');
  });
});
