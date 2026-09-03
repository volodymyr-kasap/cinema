import { paymentScenarioSchema, type PaymentScenario } from '@cinema/contracts';

export interface ScenarioWeights {
  success: number;
  decline: number;
  error: number;
  timeout: number;
}

/**
 * The header wins; without it the weights decide.
 *
 * Tests name a scenario and get an exact outcome. The compose stack leaves the
 * header off and gets a realistic mix, which is what makes the demonstration
 * worth watching -- a provider that always succeeds proves nothing about a
 * retry ladder.
 */
export function pickScenario(
  header: string | undefined,
  weights: ScenarioWeights,
  random: () => number,
): PaymentScenario {
  const named = paymentScenarioSchema.safeParse(header);
  if (named.success) return named.data;

  const roll = random();
  const order: [PaymentScenario, number][] = [
    ['success', weights.success],
    ['decline', weights.decline],
    ['error', weights.error],
    ['timeout', weights.timeout],
  ];

  let boundary = 0;
  for (const [scenario, weight] of order) {
    boundary += weight;
    if (roll < boundary) return scenario;
  }
  // Weights that do not sum to 1 are a misconfiguration; charging is the
  // least surprising thing to do about it.
  return 'success';
}
