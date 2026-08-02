import { z } from "zod";

/**
 * A post timestamp as it arrives from the Instagram Graph API.
 *
 * Meta returns a numeric UTC offset with NO colon — "2026-08-02T20:00:02+0000"
 * (verified live against GET /{ig-user-id}/media). Zod's bare `.datetime()`
 * only accepts a "Z" suffix, so it rejected every real post timestamp the admin
 * UI forwarded verbatim from /api/media/content. `{ offset: true }` widens the
 * check to any RFC3339 offset while still rejecting a zone-less local time, so
 * we can never store an ambiguous instant.
 *
 * Shared by every route that accepts a Graph timestamp, so the next one to
 * appear can't reintroduce the bug.
 */
export const mediaTimestamp = z.string().datetime({ offset: true }).nullable().optional();
