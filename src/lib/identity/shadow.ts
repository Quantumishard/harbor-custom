export type IdentityShadowObservation = {
  at: number;
  ids: string[];
  resolved: number;
  provisional: string[];
  note?: string;
};

const MAX_OBSERVATIONS = 100;
const observations: IdentityShadowObservation[] = [];

/**
 * Records what the identity layer *would* do without changing any behavior.
 * Nothing mounts this yet; the facade exposes it for the shadow phase.
 */
export function recordIdentityShadow(observation: IdentityShadowObservation): void {
  observations.push(observation);
  if (observations.length > MAX_OBSERVATIONS) observations.shift();
}

export function identityShadowLog(): IdentityShadowObservation[] {
  return observations.slice();
}

export function clearIdentityShadowLog(): void {
  observations.length = 0;
}
