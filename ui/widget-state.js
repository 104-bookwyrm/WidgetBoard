/** Select a type's latest content while preserving the other types for future switches. */
export function contentForType(current, type, fallback = {}) {
  const stash = {
    ...structuredClone(fallback.stash ?? {}),
    ...structuredClone(current.stash ?? {}),
    [current.type]: structuredClone(current.settings ?? {}),
  };
  const settings = stash[type] ?? structuredClone(fallback.settings ?? {});
  delete stash[type];
  return { settings, stash };
}
