/** Normalize a snapshotted keyword for user-visible recovery instructions. */
export function normalizeRecoveryKeyword(keyword: string): string {
  const normalized = keyword.trim().toUpperCase();
  if (!normalized) {
    throw new Error("invalid recovery keyword: expected a non-empty keyword snapshot");
  }
  return normalized;
}

/**
 * Normalize an Instagram handle for the public reply's @mention.
 *
 * Instagram has no mention API and no tagging syntax — it parses `@handle` out
 * of plain comment text — so a malformed handle does not fail loudly at the
 * provider. It posts as literal text under our own name. Anything that is not a
 * valid handle therefore returns null, and the caller drops the mention rather
 * than publishing "@undefined" on the owner's post.
 */
export function normalizeRecoveryHandle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  // Tolerate a stored handle that already carries the sigil.
  const trimmed = raw.trim().replace(/^@+/, "");
  // Instagram handles are letters, digits, period and underscore, up to 30.
  return /^[A-Za-z0-9._]{1,30}$/.test(trimmed) ? trimmed : null;
}
