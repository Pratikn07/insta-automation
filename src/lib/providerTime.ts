import { logger } from "./logger.js";

/**
 * The one place a Meta webhook timestamp becomes a Date.
 *
 * Meta sends epoch milliseconds, but webhook JSON is untrusted and the field is
 * easy to get wrong — a seconds epoch is the classic case and parses cleanly to
 * a 1970 date rather than failing. That matters more here than usual: recovery
 * evidence keeps the EARLIEST timestamp it has seen, so a single 1970 value
 * pins a row's seenAt or engagedAt to 1970 permanently and no later, correct
 * event can repair it.
 *
 * Anything outside a plausible range is treated as absent: the caller's receipt
 * time is used instead and `provider_timestamp_invalid` is logged, so a
 * provider or integration change surfaces rather than silently corrupting
 * measurement. The return value is always a valid Date.
 */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2015, 0, 1);

// Meta's clock may run slightly ahead of ours; a day is generous and still
// excludes anything that could reorder history.
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export function parseProviderTimestamp(raw: unknown, receivedAt: Date = new Date()): Date {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw >= EARLIEST_PLAUSIBLE_MS && raw <= receivedAt.getTime() + FUTURE_TOLERANCE_MS) {
      return new Date(raw);
    }
  }

  logger.warn(
    {
      errorCode: "provider_timestamp_invalid",
      // A number or nothing — never the raw payload.
      raw: typeof raw === "number" && Number.isFinite(raw) ? raw : null,
      rawType: typeof raw,
    },
    "Provider timestamp was implausible; using receipt time",
  );
  return receivedAt;
}
