export type LearningMode = 'off' | 'propose' | 'auto';
export type ActivationPolicy = 'pending' | 'auto';
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Display the runtime's safe defaults without materializing opt-in in config. */
export function learningSettings(skills: unknown) {
  const workshop = record(record(skills).workshop);
  const rawMode = record(workshop.autonomous).mode;
  return {
    mode: rawMode === 'off' || rawMode === 'auto' ? rawMode : 'propose' as LearningMode,
    approvalPolicy: workshop.approvalPolicy === 'auto' ? 'auto' : 'pending' as ActivationPolicy,
  };
}

export function setLearningMode(skills: unknown, mode: LearningMode) {
  const source = record(skills);
  const workshop = record(source.workshop);
  return { ...source, workshop: { ...workshop, autonomous: { ...record(workshop.autonomous), mode } } };
}

export function setActivationPolicy(skills: unknown, approvalPolicy: ActivationPolicy) {
  const source = record(skills);
  return { ...source, workshop: { ...record(source.workshop), approvalPolicy } };
}
