export type HermesConfig = Record<string, unknown>;

export function hermesModelSelectionResult(value: unknown): { saved: true } | { saved: false; confirmation: string } {
  if (value && typeof value === 'object') {
    const result = value as Record<string, unknown>;
    if (result.confirm_required === true && typeof result.confirm_message === 'string' && result.confirm_message.trim()) {
      return { saved: false, confirmation: result.confirm_message };
    }
    if (result.ok === true && result.confirm_required !== true) return { saved: true };
  }
  throw new Error('Hermes did not confirm the model selection. Refresh settings before retrying.');
}

const isObject = (value: unknown): value is HermesConfig => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Hermes merges config updates itself. Send only edits, preserving masked secrets. */
export function hermesConfigChanges(previous: HermesConfig, next: HermesConfig): HermesConfig {
  const changes: [string, unknown][] = [];
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(previous[key]) === JSON.stringify(value)) continue;
    if (isObject(previous[key]) && isObject(value)) {
      const nested = hermesConfigChanges(previous[key], value);
      if (Object.keys(nested).length) changes.push([key, nested]);
    } else changes.push([key, value]);
  }
  // Removing a field from JSON is ambiguous under Hermes' merge contract. An
  // explicit null is forwarded; silently deleting unrelated settings is not.
  for (const key of Object.keys(previous)) {
    if (!(key in next)) throw new Error(`Use an explicit value to reset ${key}; removing fields is not supported by this editor.`);
  }
  return Object.fromEntries(changes);
}
