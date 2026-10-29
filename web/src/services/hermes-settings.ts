export type HermesConfig = Record<string, unknown>;
export interface HermesCredential {
  is_set: boolean; description?: string; category?: string; is_password?: boolean;
  provider?: string; provider_primary?: boolean;
  provider_profiles?: { provider: string; primary?: boolean }[];
}

/** Configured model-catalog rows can omit key_env; credential metadata owns aliases. */
export function providerCredentialName(credentials: Record<string, HermesCredential>, provider: string, suggested?: string) {
  if (!provider) return '';
  if (suggested) return suggested;
  const matches = Object.entries(credentials).filter(([, value]) => value.is_password !== false
    && (value.provider === provider || value.provider_profiles?.some(identity => identity.provider === provider)));
  return matches.find(([, value]) => value.provider === provider && value.provider_primary
    || value.provider_profiles?.some(identity => identity.provider === provider && identity.primary))?.[0]
    || matches.find(([, value]) => value.is_set)?.[0] || matches[0]?.[0] || '';
}
export type HermesModelSelection = { saved: true; confirmation?: string } | { saved: false; confirmation: string };

export function hermesModelSelectionResult(value: unknown): HermesModelSelection {
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
