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

keywordsRouter.delete("/:id", async (req, res) => {
  await prisma.$transaction([
    prisma.conversation.deleteMany({ where: { keywordId: req.params.id } }),
    prisma.keyword.delete({ where: { id: req.params.id } }),
  ]);
  res.status(204).end();
});
