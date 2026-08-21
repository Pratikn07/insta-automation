/**
 * Did this failure mean "another transaction got there first, try again"?
 *
 * Prisma normalises a serialization failure to `P2034` for its own query builder,
 * but a `$queryRaw` surfaces Postgres' native `40001` unchanged — and the row
 * locks this codebase relies on (`SELECT ... FOR UPDATE` on `dm_recovery_control`
 * and `ig_users`) are raw. Matching only `P2034` let a genuine race escape as a
 * hard failure, which under a burst of concurrent comments meant the caller could
 * not tell whether a gate had been sent — and, on 2026-08-21, dropped an inbound
 * DM outright because `recordInboundMessage` treated a retryable conflict as
 * fatal.
 *
 * `40P01` (deadlock_detected) is included for the same reason: it is retryable and
 * arrives by the same path.
 *
 * This lives in `lib` rather than in one service because six call sites classify
 * the same condition. A second copy is a second chance to drift back to the
 * narrow check.
 */
export function isRetryableConflict(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "P2034" || code === "40001" || code === "40P01") return true;
  // A raw-query failure carries the SQLSTATE in its message rather than `code`.
  const message = (err as { message?: string })?.message ?? "";
  return message.includes("40001") || message.includes("could not serialize access");
}
