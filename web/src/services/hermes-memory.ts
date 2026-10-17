export interface MemoryField {
  key: string; label?: string; kind: 'text' | 'secret' | 'boolean' | 'integer' | 'number' | 'select' | 'json';
  value: string | boolean | number; isSet: boolean; required: boolean; description?: string; placeholder?: string;
  options: { value: string; label: string }[]; when?: Record<string, string | number | boolean>;
  minimum?: number; maximum?: number; step?: number;
}
export interface MemoryProvider {
  name: string; description: string; available: boolean; configured: boolean; status: string;
  setup: { dependenciesInstalled: boolean; pythonDependenciesDeclared: boolean; pythonPackages: string[];
    externalDependencies: { name: string; hasInstall: boolean }[]; requiredEnv: string[] };
}
export interface MemoryStatus { active: string; providers: MemoryProvider[]; builtinFiles: { memory?: number; user?: number } }
export interface MemorySchema { name: string; label?: string; docs_url?: string; surface: 'native' | 'declared'; fields: MemoryField[] }
export type MemoryDraft = Record<string, string | boolean | number>;

/** Edited fields only. A blank secret preserves the native credential. */
export function memoryProviderEdits(fields: MemoryField[], draft: MemoryDraft) {
  const known = new Map(fields.map(field => [field.key, field]));
  return Object.fromEntries(Object.entries(draft).filter(([key, value]) => {
    const field = known.get(key);
    if (!field) throw new Error('The memory provider form changed. Refresh before saving.');
    if (field.kind === 'secret') return typeof value === 'string' && Boolean(value.trim());
    return String(value) !== String(field.value);
  }));
}
