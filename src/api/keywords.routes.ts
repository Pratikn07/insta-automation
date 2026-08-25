import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { normalizeKeyword } from "../services/keywordService.js";
import { backfillKeyword } from "../services/keywordBackfillService.js";
import { mediaTimestamp } from "./mediaTimestamp.js";
import {
  classifyCreateReplay,
  idempotencyKeyMismatch,
  isPrimaryKeyViolation,
  isUniqueViolation,
} from "./createReplay.js";
import { asyncRouter } from "./asyncRouter.js";
import { isForeignKeyViolation } from "./foreignKeyViolation.js";

export const keywordsRouter = asyncRouter();

const createSchema = z.object({
  id: z.string().uuid(),
  keyword: z.string().min(1).max(60),
  resourceId: z.string().uuid(),
  publicReply: z.string().min(1).max(280),
  gateMessage: z.string().min(1).max(1000),
  active: z.boolean().optional(),
  // mediaId is REQUIRED: a keyword belongs to one post, so the API can no longer
  // mint a global. The 24 pre-existing globals stay valid and editable — they are
  // just the last of their kind. mediaCaption/mediaPermalink/mediaPostedAt are
  // denormalized snapshots so the Keywords list can show which post, and the
  // cold-DM fallback can rank by post date, without re-hitting the Graph API.
  mediaId: z.string().min(1),
  mediaCaption: z.string().nullable().optional(),
  mediaPermalink: z.string().nullable().optional(),
  // Forwarded verbatim from the Graph API, so it carries Meta's numeric offset
  // rather than a "Z" — see mediaTimestamp.ts.
  mediaPostedAt: mediaTimestamp,
});

/**
 * Compared against the stored row on a replay. `keyword` is compared *after*
 * normalization, because the request's casing is not part of the intent.
 */
const KEYWORD_REPLAY_KEYS = [
  "keyword",
  "mediaId",
  "mediaCaption",
  "mediaPermalink",
  "mediaPostedAt",
  "resourceId",
  "publicReply",
  "gateMessage",
  "active",
] as const;

// PATCH stays permissive on mediaId so the legacy globals remain editable (their
// mediaId is null and must be allowed to stay that way).
const updateSchema = createSchema.omit({ id: true }).partial().extend({
  mediaId: z.string().nullable().optional(),
});

keywordsRouter.get("/", async (_req, res) => {
  const rows = await prisma.keyword.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      resource: { select: { id: true, name: true, _count: { select: { messages: true } } } },
      _count: { select: { conversations: true } },
    },
  });
  res.json(rows);
});

keywordsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;
  const keyword = normalizeKeyword(data.keyword);

  // mediaId is required by the schema, so every new keyword is post-scoped and
  // @@unique([keyword, mediaId]) fully covers duplicates (P2002 below). The old
  // explicit global-duplicate guard is gone with it: Postgres treats NULLs as
  // distinct, but no request can create a NULL mediaId anymore.
  if (idempotencyKeyMismatch(req.headers["idempotency-key"], data.id)) {
    return res.status(400).json({ error: "idempotency_key_mismatch" });
  }

  const intended = {
    id: data.id,
    keyword,
    mediaId: data.mediaId,
    mediaCaption: data.mediaCaption ?? null,
    mediaPermalink: data.mediaPermalink ?? null,
    mediaPostedAt: data.mediaPostedAt ? new Date(data.mediaPostedAt) : null,
    resourceId: data.resourceId,
    publicReply: data.publicReply,
    gateMessage: data.gateMessage,
    active: data.active ?? true,
  };

  try {
    const created = await prisma.keyword.create({ data: intended });
    // Recover the last 7 days of commenters who used this keyword before it
    // existed — fire-and-forget; backfillKeyword is non-throwing and idempotent.
    if (created.active) void backfillKeyword(created.id);
    res.status(201).json(created);
  } catch (err: unknown) {
    // A clash on the primary key means this exact create already happened. A
    // clash on [keyword, mediaId] means a different row owns that pair, which is
    // the domain duplicate and keeps its own answer.
    if (isPrimaryKeyViolation(err)) {
      const existing = await prisma.keyword.findUnique({ where: { id: intended.id } });
      if (!existing) throw err;
      if (
        classifyCreateReplay({ existing, intended, keys: KEYWORD_REPLAY_KEYS }) === "conflict"
      ) {
        return res.status(409).json({ error: "idempotency_conflict" });
      }
      // The lost response may have taken the enqueue with it, and the backfill is
      // idempotent, so re-running it is the safe side of the bet.
      if (existing.active) void backfillKeyword(existing.id);
      return res.status(200).json(existing);
    }
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: "keyword_exists" });
    }
    throw err;
  }
});

keywordsRouter.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;
  const before = await prisma.keyword.findUnique({ where: { id: req.params.id } });
  const updated = await prisma.keyword.update({
    where: { id: req.params.id },
    data: {
      ...(data.keyword !== undefined && { keyword: normalizeKeyword(data.keyword) }),
      ...(data.resourceId !== undefined && { resourceId: data.resourceId }),
      ...(data.publicReply !== undefined && { publicReply: data.publicReply }),
      ...(data.gateMessage !== undefined && { gateMessage: data.gateMessage }),
      ...(data.active !== undefined && { active: data.active }),
      ...(data.mediaId !== undefined && { mediaId: data.mediaId }),
      ...(data.mediaCaption !== undefined && { mediaCaption: data.mediaCaption }),
      ...(data.mediaPermalink !== undefined && { mediaPermalink: data.mediaPermalink }),
      ...(data.mediaPostedAt !== undefined && {
        mediaPostedAt: data.mediaPostedAt ? new Date(data.mediaPostedAt) : null,
      }),
    },
  });
  // Backfill when matching could newly apply: keyword (re)activated, the word
  // itself changed, or the reel scope changed. Idempotent, so over-triggering
  // only costs a scan.
  const matchingChanged =
    (updated.active && before?.active === false) ||
    (before && updated.keyword !== before.keyword) ||
    (before && updated.mediaId !== before.mediaId);
  if (updated.active && matchingChanged) void backfillKeyword(updated.id);
  res.json(updated);
});

/**
 * Deleting a keyword clears its tracking, and refuses when what points at it is a
 * record of something a real person was actually sent or asked.
 *
 * Every guard below stands in front of an ON DELETE RESTRICT foreign key. Without
 * them Postgres refused anyway, but as a constraint violation that reached the error
 * middleware as a 500 — and `apiMutation` classifies any 5xx as an outcome nobody
 * knows rather than an `ApiError`, so the browser could only show a bare "Delete
 * failed" that named neither the cause nor a way out. Answering 409 with a code is
 * what turns that into a sentence the owner can act on.
 *
 * Refusing rather than cascading is the same trade the guide delete in
 * `resources.routes.ts` already makes: erasing what someone was sent is a bigger
 * decision than the click implies. A keyword carrying history is retired by pausing
 * it — the toggle on the Keywords list — which stops it matching new comments and
 * leaves the record alone.
 */
keywordsRouter.delete("/:id", async (req, res, next) => {
  const id = req.params.id;

  // Already gone: the owner's intent is satisfied. A delete whose response was lost
  // is repeated by hand often enough that turning the second attempt into an error
  // would be answering the wrong question.
  const existing = await prisma.keyword.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return res.status(204).end();

  /**
   * Counted together rather than one short-circuiting await at a time: almost every
   * blocked keyword trips the last of them, so stopping early saves nothing and costs
   * five round trips instead of one.
   *
   * `guide_delivery` and `guide_access_attempt` restrict the *conversation*, so they
   * block the `deleteMany` below rather than the keyword row. The rest restrict
   * `keyword_id` directly.
   */
  const [deliveries, accessAttempts, reminders, candidates, intents] = await Promise.all([
    prisma.guideDelivery.count({ where: { conversation: { keywordId: id } } }),
    prisma.guideAccessAttempt.count({ where: { conversation: { keywordId: id } } }),
    prisma.dmRecoveryReminder.count({ where: { keywordId: id } }),
    prisma.recoveryCandidate.count({ where: { keywordId: id } }),
    prisma.journeyIntent.count({ where: { keywordId: id } }),
  ]);

  /**
   * Ordered by how much each answer tells the owner, because several are usually true
   * at once. A delivery names a guide that reached a real person and an access attempt
   * names one they were asked for — "someone already got this" beats any of the
   * bookkeeping below it.
   */
  if (deliveries > 0) {
    return res.status(409).json({ error: "keyword_has_delivery_history" });
  }
  if (accessAttempts > 0) {
    return res.status(409).json({ error: "keyword_has_guide_access_history" });
  }
  // The follow-up record for people who asked and never finished.
  if (reminders + candidates > 0) {
    return res.status(409).json({ error: "keyword_has_recovery_history" });
  }
  /**
   * Last, and by far the most common — 78 of 100 production keywords carry intents,
   * so this is the answer an owner usually gets. An intent is the 48-hour window that
   * collapsed someone's repeat comments into a single journey, and its triggers hold
   * the originating comment ids; deleting the keyword would strip the audit trail they
   * exist to keep.
   */
  if (intents > 0) {
    return res.status(409).json({ error: "keyword_has_journey_history" });
  }

  try {
    await prisma.$transaction([
      prisma.conversation.deleteMany({ where: { keywordId: id } }),
      prisma.keyword.delete({ where: { id } }),
    ]);
  } catch (error) {
    // Backstop for a restricting reference this route does not name yet — an owner
    // reply draft written against one of these conversations is the one that exists
    // today. A vague refusal is still a refusal; a 500 is another silent "Delete
    // failed".
    if (isForeignKeyViolation(error)) {
      return res.status(409).json({ error: "keyword_still_referenced" });
    }
    return next(error);
  }
  res.status(204).end();
});
