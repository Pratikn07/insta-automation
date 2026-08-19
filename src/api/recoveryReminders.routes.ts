import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { flags } from "../services/flagService.js";
import { getIgUsers } from "../services/igUserService.js";
import { logEvent } from "../services/eventLogger.js";
import { getRecoveryHealthSnapshot } from "../services/dmRecoveryHealth.js";
import { env } from "../config/env.js";
import {
  SettingsBlockedVerificationAdminError,
  activateSettingsBlockedVerification,
  retireSettingsBlockedVerification,
} from "../services/settingsBlockedVerificationAdminService.js";
import { asyncRouter } from "./asyncRouter.js";

/**
 * Read models and owner actions for the DM recovery lens.
 *
 * Mounted under apiRouter, so requireAdmin has already run.
 */
export const recoveryRemindersRouter = asyncRouter();

export const RECOVERY_VIEWS = [
  "all",
  "scheduled",
  "ready",
  "sent",
  "suppressed",
  "control",
  "attention",
] as const;

export type RecoveryView = (typeof RECOVERY_VIEWS)[number];

/**
 * The one definition of what each view means, shared by the list and the counts
 * so a row can never appear in a tab whose badge disagrees with it.
 */
export function viewWhere(view: RecoveryView, now: Date): Prisma.DmRecoveryReminderWhereInput {
  switch (view) {
    case "scheduled":
      return { status: "waiting", eligibleAt: { gt: now } };
    case "ready":
      return { status: "waiting", eligibleAt: { lte: now } };
    case "sent":
      return { status: "sent" };
    case "suppressed":
      return { status: "suppressed" };
    case "control":
      return { status: "control" };
    case "attention":
      return { status: { in: ["send_failed", "send_uncertain", "tracking_unavailable"] } };
    case "all":
    default:
      return {};
  }
}

/**
 * Explicit select rather than a whole row: publicReplyText is the message we
 * would post and has no business in a list response, and an accidental future
 * column must not leak by default.
 */
const ROW_SELECT = {
  id: true,
  conversationId: true,
  igUserId: true,
  mediaId: true,
  triggerKind: true,
  status: true,
  cohort: true,
  acceptedAt: true,
  eligibleAt: true,
  seenAt: true,
  engagedAt: true,
  firstEngagementKind: true,
  suppressionReason: true,
  sentAt: true,
  attempts: true,
  lastAttemptAt: true,
  lastErrorCategory: true,
  reviewedAt: true,
  createdAt: true,
  settingsEvidenceLegacy: true,
  settingsVerificationId: true,
  settingsVerificationVersion: true,
  settingsGraphCode: true,
  settingsGraphSubcode: true,
  settingsClassifiedAt: true,
  settingsEvidenceReference: true,
  settingsEvidenceSha256: true,
  settingsVerification: {
    select: {
      active: true,
      retiredAt: true,
      verifiedAt: true,
      validUntil: true,
      apiVersion: true,
    },
  },
  keyword: { select: { id: true, keyword: true, mediaPermalink: true, mediaCaption: true } },
} as const;

type SelectedRow = Prisma.DmRecoveryReminderGetPayload<{ select: typeof ROW_SELECT }>;

const listQuerySchema = z.object({
  view: z.enum(RECOVERY_VIEWS).default("all"),
  keywordId: z.string().uuid().optional(),
  cohort: z.enum(["treatment", "control", "not_applicable"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
  // The `scheduled` and `ready` views are split by an `eligibleAt` comparison
  // against now, so a fresh `now` per request moves the boundary mid-pagination
  // and a row can land on neither page: page 1 sees it as `scheduled`, and by
  // page 2 it has become `ready` and sorts above the cursor. The client echoes
  // this back so every page of one run shares page 1's boundary.
  asOf: z.coerce.date().optional(),
});

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

type SettingsEvidenceSource = {
  triggerKind: string;
  settingsEvidenceLegacy: boolean;
  settingsVerificationId: string | null;
  settingsVerificationVersion: string | null;
  settingsGraphCode: number | null;
  settingsGraphSubcode: number | null;
  settingsClassifiedAt: Date | null;
  settingsEvidenceReference: string | null;
  settingsEvidenceSha256: string | null;
  settingsVerification: {
    active: boolean;
    retiredAt: Date | null;
    verifiedAt: Date;
    validUntil: Date;
    apiVersion: string;
  } | null;
};

type SettingsEvidenceStatus = "current" | "stale" | "retired" | "missing";

function settingsEvidenceStatus(row: SettingsEvidenceSource, now: Date): SettingsEvidenceStatus {
  if (
    row.settingsEvidenceLegacy ||
    !row.settingsVerificationId ||
    !row.settingsVerificationVersion ||
    row.settingsGraphCode === null ||
    row.settingsGraphSubcode === null ||
    !row.settingsClassifiedAt ||
    !row.settingsEvidenceReference ||
    !row.settingsEvidenceSha256 ||
    !row.settingsVerification
  ) {
    return "missing";
  }
  if (!row.settingsVerification.active || row.settingsVerification.retiredAt) return "retired";
  if (row.settingsVerification.validUntil.getTime() <= now.getTime()) return "stale";
  return "current";
}

function serializeSettingsEvidence(
  row: SettingsEvidenceSource,
  now: Date,
): Record<string, unknown> | null {
  if (row.triggerKind !== "settings_blocked") return null;
  const status = settingsEvidenceStatus(row, now);
  const registry = row.settingsVerification;
  return {
    status,
    verificationId: row.settingsVerificationId,
    version: row.settingsVerificationVersion,
    graphCode: row.settingsGraphCode,
    graphSubcode: row.settingsGraphSubcode,
    classifiedAt: iso(row.settingsClassifiedAt),
    verifiedAt: iso(registry?.verifiedAt ?? null),
    validUntil: iso(registry?.validUntil ?? null),
    apiVersion: registry?.apiVersion ?? null,
    evidenceReference: row.settingsEvidenceReference,
    evidenceSha256: row.settingsEvidenceSha256,
  };
}

function serializeRow(
  row: SelectedRow,
  people: Record<string, { username: string | null; name: string | null }>,
  now = new Date(),
): Record<string, unknown> {
  const person = people[row.igUserId];
  return {
    id: row.id,
    conversationId: row.conversationId,
    igUserId: row.igUserId,
    username: person?.username ?? null,
    name: person?.name ?? null,
    keyword: { id: row.keyword.id, keyword: row.keyword.keyword },
    media: {
      id: row.mediaId,
      permalink: row.keyword.mediaPermalink ?? null,
      caption: row.keyword.mediaCaption ?? null,
    },
    triggerKind: row.triggerKind,
    status: row.status,
    cohort: row.cohort,
    acceptedAt: iso(row.acceptedAt),
    eligibleAt: row.eligibleAt.toISOString(),
    seenAt: iso(row.seenAt),
    engagedAt: iso(row.engagedAt),
    firstEngagementKind: row.firstEngagementKind,
    suppressionReason: row.suppressionReason,
    sentAt: iso(row.sentAt),
    attempts: row.attempts,
    lastAttemptAt: iso(row.lastAttemptAt),
    lastErrorCategory: row.lastErrorCategory,
    reviewedAt: iso(row.reviewedAt),
    createdAt: row.createdAt.toISOString(),
    settingsEvidence: serializeSettingsEvidence(row, now),
  };
}

const verificationIdSchema = z.string().uuid();
const retirementBodySchema = z.object({ reason: z.string().trim().min(3).max(200) });

function verificationAdminError(
  error: unknown,
  res: import("express").Response,
): void {
  if (error instanceof SettingsBlockedVerificationAdminError) {
    const status = error.reason === "verification_missing" ? 404 : 409;
    res.status(status).json({ error: error.reason });
    return;
  }
  res.status(500).json({ error: "verification_admin_failed" });
}

// Registered before /:id so the literal path cannot be captured as a reminder id.
recoveryRemindersRouter.get("/settings-verifications", async (_req, res) => {
  const now = new Date();
  const records = await prisma.settingsBlockedVerification.findMany({
    select: {
      id: true,
      version: true,
      graphCode: true,
      graphSubcode: true,
      semanticCategory: true,
      verifiedAt: true,
      validUntil: true,
      apiVersion: true,
      evidenceReference: true,
      evidenceSha256: true,
      active: true,
      retiredAt: true,
      retirementReason: true,
    },
    orderBy: [{ verifiedAt: "desc" }, { id: "asc" }],
  });

  res.json({
    records: records.map((record) => ({
      id: record.id,
      version: record.version,
      graphCode: record.graphCode,
      graphSubcode: record.graphSubcode,
      semanticCategory: record.semanticCategory,
      verifiedAt: record.verifiedAt.toISOString(),
      validUntil: record.validUntil.toISOString(),
      apiVersion: record.apiVersion,
      evidenceReference: record.evidenceReference,
      evidenceSha256: record.evidenceSha256,
      active: record.active,
      retiredAt: iso(record.retiredAt),
      retirementReason: record.retirementReason,
      status: record.retiredAt
        ? "retired"
        : record.validUntil.getTime() <= now.getTime()
          ? "stale"
          : record.active
            ? "current"
            : "inactive",
    })),
  });
});

recoveryRemindersRouter.post("/settings-verifications/:id/activate", async (req, res) => {
  const parsed = verificationIdSchema.safeParse(req.params.id);
  if (!parsed.success) return void res.status(400).json({ error: "invalid_verification_id" });
  try {
    await activateSettingsBlockedVerification(parsed.data, req.adminEmail ?? null);
    await logEvent("settings_blocked_verification_activated", {
      verificationId: parsed.data,
      actor: req.adminEmail ?? null,
    });
    res.status(204).end();
  } catch (error) {
    verificationAdminError(error, res);
  }
});

recoveryRemindersRouter.post("/settings-verifications/:id/retire", async (req, res) => {
  const id = verificationIdSchema.safeParse(req.params.id);
  const body = retirementBodySchema.safeParse(req.body);
  if (!id.success || !body.success) {
    return void res.status(400).json({ error: "invalid_retirement_request" });
  }
  try {
    await retireSettingsBlockedVerification(
      id.data,
      body.data.reason,
      req.adminEmail ?? null,
    );
    await logEvent("settings_blocked_verification_retired", {
      verificationId: id.data,
      actor: req.adminEmail ?? null,
      reason: body.data.reason,
    });
    res.status(204).end();
  } catch (error) {
    verificationAdminError(error, res);
  }
});

// Both literals are registered before /:id, or Express captures them as ids.
recoveryRemindersRouter.get("/metrics", metricsHandler);

recoveryRemindersRouter.get("/counts", async (_req, res) => {
  const now = new Date();

  const entries = await Promise.all(
    RECOVERY_VIEWS.map(async (view) => {
      // Grouping by person yields both totals in one pass: the row count is the
      // sum, and the number of groups is the distinct-people count.
      const groups = await prisma.dmRecoveryReminder.groupBy({
        by: ["igUserId"],
        where: viewWhere(view, now),
        _count: { _all: true },
      });
      const records = groups.reduce((total, group) => total + group._count._all, 0);
      return [view, { records, people: groups.length }] as const;
    }),
  );

  res.json(Object.fromEntries(entries));
});

recoveryRemindersRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });

  const { view, keywordId, cohort, limit, cursor, asOf } = parsed.data;
  // Page 1 establishes the boundary; later pages reuse the one they are handed.
  // Without this the time-split views silently drop rows mid-pagination.
  const now = asOf ?? new Date();

  const rows = await prisma.dmRecoveryReminder.findMany({
    where: {
      ...viewWhere(view, now),
      ...(keywordId ? { keywordId } : {}),
      ...(cohort ? { cohort } : {}),
    },
    select: ROW_SELECT,
    orderBy: [{ eligibleAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, limit);
  // Cursor is the LAST row of THIS page, because Prisma's `skip: 1` steps over
  // the cursor row itself. Pointing it at the extra limit+1 row made the next
  // page start after that row, dropping it entirely.
  const nextCursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;

  const people = page.length
    ? await getIgUsers(page.map((row) => row.igUserId))
    : {};

  res.json({
    rows: page.map((row) => serializeRow(row, people, now)),
    nextCursor,
    asOf: now.toISOString(),
  });
});

const DETAIL_SELECT = {
  ...ROW_SELECT,
  commentId: true,
  gateDmMessageId: true,
  instagramGateMessageId: true,
  templateVersion: true,
  keywordSnapshot: true,
  repliedAt: true,
  reactedAt: true,
  postbackAt: true,
  suppressedAt: true,
  cancelledAt: true,
  publicReplyId: true,
} as const;

type TimelineEntry = { kind: string; at: string; detail?: string | null };

/**
 * Built only from timestamps we stored ourselves. A provider response is never
 * replayed here, so the timeline cannot contain anything we did not record.
 */
function buildTimeline(row: Record<string, unknown>): TimelineEntry[] {
  const candidates: Array<[string, unknown, string | null]> = [
    ["created", row.createdAt, null],
    ["accepted", row.acceptedAt, null],
    ["eligible", row.eligibleAt, null],
    ["seen", row.seenAt, null],
    ["engaged", row.engagedAt, (row.firstEngagementKind as string) ?? null],
    ["replied", row.repliedAt, null],
    ["reacted", row.reactedAt, null],
    ["postback", row.postbackAt, null],
    ["attempted", row.lastAttemptAt, (row.lastErrorCategory as string) ?? null],
    ["sent", row.sentAt, null],
    ["suppressed", row.suppressedAt, (row.suppressionReason as string) ?? null],
    ["cancelled", row.cancelledAt, null],
    ["reviewed", row.reviewedAt, null],
  ];

  return candidates
    .filter((entry): entry is [string, Date, string | null] => entry[1] instanceof Date)
    .map(([kind, at, detail]) => ({ kind, at: at.toISOString(), detail }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * The server owns both lists. The web view model keeps its own copies to decide
 * whether to offer a button, because `web` is a separate build and cannot import
 * from here. Those copies are asserted against these in
 * `recoveryActionStatuses.test.ts`, so a change on either side fails a test
 * rather than silently offering an action the API will refuse.
 *
 * Drift is a mislabelled button, not corruption: every action re-reads the row
 * and answers 409 when the status is no longer eligible.
 */
export const CANCELLABLE = [
  "waiting",
  "control",
  "tracking_unavailable",
  // No public comment was accepted. Cancelling prevents a later retry; it does
  // not rewrite or undo the failed Meta attempt already recorded in the timeline.
  "send_failed",
] as const;
export const REVIEWABLE = ["send_failed", "send_uncertain", "tracking_unavailable"] as const;

recoveryRemindersRouter.get("/:id", async (req, res) => {
  const row = await prisma.dmRecoveryReminder.findUnique({
    where: { id: req.params.id },
    select: DETAIL_SELECT,
  });
  if (!row) return res.status(404).json({ error: "not_found" });

  const people = await getIgUsers([row.igUserId]);

  // The comment that started the journey, when we captured it. Best effort:
  // its absence is not an error.
  const commentEvent = row.commentId
    ? await prisma.eventLog.findFirst({
        where: { kind: "comment_received", payload: { path: ["commentId"], equals: row.commentId } },
        select: { payload: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      })
    : null;

  const commentText = (commentEvent?.payload as { text?: unknown } | null)?.text;

  res.json({
    ...serializeRow(row, people),
    commentId: row.commentId,
    keywordSnapshot: row.keywordSnapshot,
    templateVersion: row.templateVersion,
    publicReplyId: row.publicReplyId,
    trackingAvailable: row.instagramGateMessageId !== null,
    comment: commentEvent
      ? {
          text: typeof commentText === "string" ? commentText : null,
          receivedAt: commentEvent.createdAt.toISOString(),
        }
      : null,
    timeline: buildTimeline(row as unknown as Record<string, unknown>),
  });
});

/**
 * Owner actions are one conditional updateMany each, so two owners clicking at
 * once cannot both win. A zero count then means either "gone" or "someone got
 * there first", which one follow-up select distinguishes.
 */
async function resolveActionConflict(id: string, res: import("express").Response): Promise<void> {
  const existing = await prisma.dmRecoveryReminder.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.status(409).json({ error: "conflict", status: existing.status });
}

recoveryRemindersRouter.post("/:id/cancel", async (req, res) => {
  const now = new Date();

  const before = await prisma.dmRecoveryReminder.findUnique({
    where: { id: req.params.id },
    select: { status: true },
  });
  if (!before) return void res.status(404).json({ error: "not_found" });

  if (!CANCELLABLE.includes(before.status as (typeof CANCELLABLE)[number])) {
    return resolveActionConflict(req.params.id, res);
  }

  // Guarded on the exact status just read, not on the whole cancellable set.
  // That makes this a compare-and-set: if it updates a row, the status it
  // replaced was provably the one being reported, so the audit entry cannot
  // name a state the row was never in.
  const result = await prisma.dmRecoveryReminder.updateMany({
    where: {
      id: req.params.id,
      status: before.status,
      sentAt: null,
      publicReplyId: null,
    },
    data: { status: "cancelled", cancelledAt: now, suppressionReason: "owner_cancelled" },
  });

  if (result.count === 0) return resolveActionConflict(req.params.id, res);

  await logEvent("dm_recovery_cancelled", {
    id: req.params.id,
    actor: req.adminEmail ?? null,
    action: "cancel",
    previousStatus: before.status,
    newStatus: "cancelled",
  });
  res.status(204).end();
});

recoveryRemindersRouter.post("/:id/mark-reviewed", async (req, res) => {
  const before = await prisma.dmRecoveryReminder.findUnique({
    where: { id: req.params.id },
    select: { status: true, reviewedAt: true },
  });
  if (!before) return void res.status(404).json({ error: "not_found" });

  // Already acknowledged. Succeed without touching the row: a second click —
  // or a retried request — must not move the review timestamp off the moment a
  // person actually looked, nor add a second entry to the audit trail.
  if (before.reviewedAt !== null) return void res.status(204).end();

  const result = await prisma.dmRecoveryReminder.updateMany({
    // Reviewing is an acknowledgement, never a state change: the send status
    // stays exactly as it was. `reviewedAt: null` is what makes the write
    // happen once even when two requests race.
    where: { id: req.params.id, status: { in: [...REVIEWABLE] }, reviewedAt: null },
    data: { reviewedAt: new Date() },
  });

  // Lost the race to a concurrent review rather than to a status change, so the
  // caller's intent still holds: the row is reviewed.
  if (result.count === 0) {
    const now = await prisma.dmRecoveryReminder.findUnique({
      where: { id: req.params.id },
      select: { reviewedAt: true },
    });
    if (now?.reviewedAt) return void res.status(204).end();
    return resolveActionConflict(req.params.id, res);
  }

  await logEvent("dm_recovery_reviewed", {
    id: req.params.id,
    actor: req.adminEmail ?? null,
    action: "mark_reviewed",
    // Review does not change status, so both fields carry the same value —
    // stated explicitly so an auditor reading the stream never has to infer it.
    previousStatus: before.status,
    newStatus: before.status,
  });
  res.status(204).end();
});

// ── Experiment metrics ───────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

const METRICS_SELECT = {
  id: true,
  igUserId: true,
  keywordId: true,
  cohort: true,
  status: true,
  triggerKind: true,
  eligibleAt: true,
  sentAt: true,
  seenAt: true,
  seenReceivedAt: true,
  engagedAt: true,
  engagedReceivedAt: true,
  repliedAt: true,
  attempts: true,
  suppressionReason: true,
  lastErrorCategory: true,
  audienceOrigin: true,
  settingsEvidenceLegacy: true,
  settingsVerificationId: true,
  settingsVerificationVersion: true,
  settingsGraphCode: true,
  settingsGraphSubcode: true,
  settingsClassifiedAt: true,
  settingsEvidenceReference: true,
  settingsEvidenceSha256: true,
  settingsVerification: {
    select: {
      active: true,
      retiredAt: true,
      verifiedAt: true,
      validUntil: true,
      apiVersion: true,
    },
  },
  keyword: { select: { keyword: true } },
  conversation: { select: { completedAt: true } },
} as const;

type MetricsRow = Prisma.DmRecoveryReminderGetPayload<{ select: typeof METRICS_SELECT }>;

function within(from: Date, at: Date | null, windowMs: number): boolean {
  return at !== null && at.getTime() >= from.getTime() && at.getTime() - from.getTime() <= windowMs;
}

/** Distinct people among rows that satisfy a predicate. */
function peopleWhere(rows: MetricsRow[], predicate: (row: MetricsRow) => boolean): number {
  return new Set(rows.filter(predicate).map((row) => row.igUserId)).size;
}

function cohortSummary(rows: MetricsRow[]) {
  const eligiblePeople = new Set(rows.map((row) => row.igUserId)).size;
  // The primary comparison is by unique person — one person counts as
  // successful if ANY of their eligible journeys completed in the window —
  // with journey counts retained beside it.
  const completedWithin = (windowMs: number) =>
    peopleWhere(rows, (row) => within(row.eligibleAt, row.conversation?.completedAt ?? null, windowMs));
  const repliedWithin = (windowMs: number) =>
    peopleWhere(rows, (row) => within(row.eligibleAt, row.repliedAt, windowMs));

  const completedWithin48h = completedWithin(2 * DAY_MS);
  return {
    eligiblePeople,
    eligibleJourneys: rows.length,
    repliedWithin24h: repliedWithin(DAY_MS),
    repliedWithin48h: repliedWithin(2 * DAY_MS),
    completedWithin24h: completedWithin(DAY_MS),
    completedWithin48h,
    // A percentage, so the plan's lift arithmetic below is in percentage points.
    completionRate48h: eligiblePeople === 0 ? null : (completedWithin48h / eligiblePeople) * 100,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

async function metricsHandler(_req: import("express").Request, res: import("express").Response) {
  const startAt = env.DM_RECOVERY_EXPERIMENT_START_AT ?? null;
  const endAt = env.DM_RECOVERY_EXPERIMENT_END_AT ?? null;

  // Only prospective no-confirmed-read journeys inside the configured window
  // are comparable. settings_blocked rows are always treatment by design, so
  // including them would bias the treatment arm.
  //
  // With no window configured there is no experiment to report, so skip the
  // query rather than asking the database for an empty cohort. `id` is a uuid
  // column, so a sentinel like `id: ""` cannot express "match nothing" — Prisma
  // rejects it with P2023 before any SQL is sent, and the unconfigured window is
  // the documented default deploy state.
  const experimentRows =
    startAt && endAt
      ? await prisma.dmRecoveryReminder.findMany({
          where: {
            triggerKind: "no_confirmed_read",
            acceptedAt: { gte: new Date(startAt), lt: new Date(endAt) },
          },
          select: METRICS_SELECT,
        })
      : [];

  // Compare like with like. When the market filter is on, a treatment row for an
  // out-of-market person is suppressed and never sent — but the equivalent
  // control row is stamped terminal at creation and never runs that check, so it
  // stays in the control arm. Splitting on cohort alone therefore puts
  // never-sent people in treatment while control holds every origin, and the
  // measured lift reads low: those people convert at the no-reminder rate inside
  // the arm that is supposed to show the reminder's effect.
  //
  // Filtering both arms on the snapshot fixes it symmetrically. Rows predating
  // the snapshot column have a null origin and are kept — excluding them would
  // silently drop the start of the experiment.
  const inMarket = (row: { audienceOrigin: string | null }) =>
    !flags.bool("DM_RECOVERY_WESTERN_ONLY") || row.audienceOrigin !== "south_asian";

  const comparableRows = experimentRows.filter(inMarket);
  const treatmentRows = comparableRows.filter((row) => row.cohort === "treatment");
  const controlRows = comparableRows.filter((row) => row.cohort === "control");

  const treatment = { ...cohortSummary(treatmentRows), sent: treatmentRows.filter((r) => r.sentAt).length };
  const control = { ...cohortSummary(controlRows), withheld: controlRows.length };

  // Reported alongside the comparison so the filter's cost is visible rather
  // than inferred from a gap between two numbers.
  const withheldOutOfMarket = experimentRows.length - comparableRows.length;

  const tRate = treatment.completionRate48h;
  const cRate = control.completionRate48h;
  const absoluteLiftPercentagePoints = tRate !== null && cRate !== null ? tRate - cRate : null;
  const relativeLiftPercent =
    tRate !== null && cRate !== null && cRate !== 0 ? ((tRate - cRate) / cRate) * 100 : null;

  const reminderToReplyMinutes = treatmentRows
    .filter((row) => row.sentAt && row.repliedAt && row.repliedAt > row.sentAt)
    .map((row) => (row.repliedAt!.getTime() - row.sentAt!.getTime()) / 60000);

  const byKeywordMap = new Map<string, {
    keywordId: string; keyword: string;
    treatmentEligiblePeople: Set<string>; treatmentCompletedWithin48h: Set<string>;
    controlEligiblePeople: Set<string>; controlCompletedWithin48h: Set<string>;
  }>();
  for (const row of experimentRows) {
    const entry = byKeywordMap.get(row.keywordId) ?? {
      keywordId: row.keywordId,
      keyword: row.keyword.keyword,
      treatmentEligiblePeople: new Set<string>(),
      treatmentCompletedWithin48h: new Set<string>(),
      controlEligiblePeople: new Set<string>(),
      controlCompletedWithin48h: new Set<string>(),
    };
    const completed = within(row.eligibleAt, row.conversation?.completedAt ?? null, 2 * DAY_MS);
    if (row.cohort === "treatment") {
      entry.treatmentEligiblePeople.add(row.igUserId);
      if (completed) entry.treatmentCompletedWithin48h.add(row.igUserId);
    } else if (row.cohort === "control") {
      entry.controlEligiblePeople.add(row.igUserId);
      if (completed) entry.controlCompletedWithin48h.add(row.igUserId);
    }
    byKeywordMap.set(row.keywordId, entry);
  }

  // Accuracy is about whether the reminders we sent were warranted, so it looks
  // at every sent row rather than only the experiment window.
  const sentRows = await prisma.dmRecoveryReminder.findMany({
    where: { sentAt: { not: null } },
    select: METRICS_SELECT,
  });

  const laterSeen = sentRows.filter((r) => r.seenAt && r.sentAt && r.seenAt > r.sentAt).length;
  const laterEngaged = sentRows.filter((r) => r.engagedAt && r.sentAt && r.engagedAt > r.sentAt).length;
  const laterCompleted = sentRows.filter(
    (r) => r.conversation?.completedAt && r.sentAt && r.conversation.completedAt > r.sentAt,
  ).length;

  // The stricter subset: the provider's own event time precedes our send, so
  // the person had already read the DM and the comment was unnecessary — we
  // only learned too late.
  const delayedPreSendSignalFalsePositives = sentRows.filter(
    (r) =>
      r.sentAt &&
      ((r.seenAt && r.seenAt < r.sentAt && (r.seenReceivedAt ?? r.seenAt) > r.sentAt) ||
        (r.engagedAt && r.engagedAt < r.sentAt && (r.engagedReceivedAt ?? r.engagedAt) > r.sentAt)),
  ).length;

  const withoutLaterPositiveEvidence = sentRows.filter(
    (r) => !r.seenAt && !r.engagedAt && !r.conversation?.completedAt,
  ).length;

  // Read coverage is only meaningful among people who demonstrably read the DM
  // (they eventually replied); anything else conflates "not read" with
  // "no receipt delivered".
  const allRows = await prisma.dmRecoveryReminder.findMany({
    where: { repliedAt: { not: null } },
    select: { seenAt: true, repliedAt: true },
  });
  const eventualRepliers = allRows.length;
  const eventualRepliersWithPriorSeen = allRows.filter(
    (r) => r.seenAt && r.repliedAt && r.seenAt <= r.repliedAt,
  ).length;

  const settingsRows = await prisma.dmRecoveryReminder.findMany({
    where: { triggerKind: "settings_blocked" },
    select: METRICS_SELECT,
  });
  const settingsNow = new Date();
  const settingsStatusCounts: Record<SettingsEvidenceStatus, number> = {
    current: 0,
    stale: 0,
    retired: 0,
    missing: 0,
  };
  const settingsGroups = new Map<
    string,
    {
      version: string | null;
      graphCode: number | null;
      graphSubcode: number | null;
      evidenceStatus: SettingsEvidenceStatus;
      ageDays: number | null;
      count: number;
      people: Set<string>;
      byReminderStatus: Record<string, number>;
    }
  >();
  for (const row of settingsRows) {
    const evidenceStatus = settingsEvidenceStatus(row, settingsNow);
    settingsStatusCounts[evidenceStatus]++;
    const verifiedAt = row.settingsVerification?.verifiedAt ?? null;
    const ageDays = verifiedAt
      ? Math.max(0, Math.floor((settingsNow.getTime() - verifiedAt.getTime()) / DAY_MS))
      : null;
    const key = JSON.stringify([
      row.settingsVerificationVersion,
      row.settingsGraphCode,
      row.settingsGraphSubcode,
      evidenceStatus,
    ]);
    const entry = settingsGroups.get(key) ?? {
      version: row.settingsVerificationVersion,
      graphCode: row.settingsGraphCode,
      graphSubcode: row.settingsGraphSubcode,
      evidenceStatus,
      ageDays,
      count: 0,
      people: new Set<string>(),
      byReminderStatus: {},
    };
    entry.count++;
    entry.people.add(row.igUserId);
    entry.byReminderStatus[row.status] = (entry.byReminderStatus[row.status] ?? 0) + 1;
    settingsGroups.set(key, entry);
  }

  const [uncertain, failed, cooldownSuppressions, staleLeases, settingsClassifierMatches, duplicateAttempts] =
    await Promise.all([
      prisma.dmRecoveryReminder.count({ where: { status: "send_uncertain" } }),
      prisma.dmRecoveryReminder.count({ where: { status: "send_failed" } }),
      prisma.dmRecoveryReminder.count({ where: { suppressionReason: "person_cooldown" } }),
      prisma.dmRecoveryReminder.count({ where: { lastErrorCategory: "stale_lease" } }),
      prisma.dmRecoveryReminder.count({ where: { triggerKind: "settings_blocked" } }),
      prisma.dmRecoveryReminder.count({ where: { attempts: { gt: 1 } } }),
    ]);

  res.json({
    experiment: {
      version: env.DM_RECOVERY_EXPERIMENT_VERSION,
      startAt,
      endAt,
      treatment,
      control,
      // Assigned rows excluded from the comparison above because the market
      // filter would withhold from them. Not a failure — it is the filter's
      // measured cost, and both arms are reduced by it equally.
      withheldOutOfMarket,
      absoluteLiftPercentagePoints,
      relativeLiftPercent,
      medianReminderToReplyMinutes: median(reminderToReplyMinutes),
      byKeyword: [...byKeywordMap.values()].map((entry) => ({
        keywordId: entry.keywordId,
        keyword: entry.keyword,
        treatmentEligiblePeople: entry.treatmentEligiblePeople.size,
        treatmentCompletedWithin48h: entry.treatmentCompletedWithin48h.size,
        controlEligiblePeople: entry.controlEligiblePeople.size,
        controlCompletedWithin48h: entry.controlCompletedWithin48h.size,
      })),
    },
    accuracy: {
      eventualRepliers,
      eventualRepliersWithPriorSeen,
      readEventCoverage:
        eventualRepliers === 0 ? null : (eventualRepliersWithPriorSeen / eventualRepliers) * 100,
      sent: sentRows.length,
      laterSeen,
      laterEngaged,
      laterCompleted,
      delayedPreSendSignalFalsePositives,
      withoutLaterPositiveEvidence,
      uncertain,
      duplicateAttempts,
      cooldownSuppressions,
      staleLeases,
      failed,
      settingsClassifierMatches,
    },
    settingsEvidence: {
      ...settingsStatusCounts,
      byVerification: [...settingsGroups.values()].map(({ people, ...entry }) => ({
        ...entry,
        people: people.size,
      })),
    },
    health: await getRecoveryHealthSnapshot(new Date()),
  });
}
