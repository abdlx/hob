const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The Gateway merges ID-based arrays unless these paths explicitly replace them.
// The editor sends complete arrays, including removals, so preserve that intent.
export function arrayReplacementPaths(before: unknown, after: unknown, path = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (Array.isArray(after)) return path ? [path] : [];
  if (!object(after)) return [];
  return Object.keys(after).flatMap(key => arrayReplacementPaths(object(before) ? before[key] : undefined, after[key], path ? `${path}.${key}` : key));
}
