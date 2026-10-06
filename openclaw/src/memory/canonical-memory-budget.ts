/** Canonical prompt content is bounded; retrieval sources retain their full contents. */
export const CANONICAL_MEMORY_BUDGET = Object.freeze({
  unit: "utf16-code-units" as const,
  userMaxChars: 2_000,
  memoryMaxChars: 4_000,
});

export type CanonicalMemoryKind = "user" | "memory";

/** Source identity is set by the loader before path projection or hook relabeling. */
export function resolveCanonicalMemoryKind(file: {
  name?: string;
  path?: string;
  personalUser?: boolean;
  canonicalMemoryKind?: CanonicalMemoryKind;
}): CanonicalMemoryKind | undefined {
  if (file.canonicalMemoryKind === "user" || file.canonicalMemoryKind === "memory") {
    return file.canonicalMemoryKind;
  }
  if (file.personalUser) {
    return "user";
  }
  const names = [file.name, file.path?.replaceAll("\\", "/").split("/").pop()];
  if (names.some((name) => name?.toLowerCase() === "user.md")) {
    return "user";
  }
  return names.some((name) => name?.toLowerCase() === "memory.md") ? "memory" : undefined;
}

export function canonicalMemoryMaxChars(kind: CanonicalMemoryKind): number {
  return kind === "user"
    ? CANONICAL_MEMORY_BUDGET.userMaxChars
    : CANONICAL_MEMORY_BUDGET.memoryMaxChars;
}
