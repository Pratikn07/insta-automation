/** Normalize a snapshotted keyword for user-visible recovery instructions. */
export function normalizeRecoveryKeyword(keyword: string): string {
  const normalized = keyword.trim().toUpperCase();
  if (!normalized) {
    throw new Error("invalid recovery keyword: expected a non-empty keyword snapshot");
  }
  return normalized;
}
