import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isInstagramGuideTextTooLong } from "../../shared/guideMessagePolicy.js";
import {
  classifyCreateReplay,
  idempotencyKeyMismatch,
  isPrimaryKeyViolation,
} from "./createReplay.js";
import { asyncRouter } from "./asyncRouter.js";

export const resourcesRouter = asyncRouter();

/**
 * Prisma's foreign-key constraint failure.
 *
 * Local rather than alongside the classifiers in `createReplay.ts`, which is about
 * whether a repeated create is the same create — a delete blocked by a reference is
 * a different question that happens to read the same field.
 */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: unknown }).code === "P2003"
  );
}

/**
 * `id` is required, and supplied by the browser. A create whose response was
 * lost can then be repeated safely: the same UUID either creates the row or
 * proves the row is already there.
 */
const createSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
});
const updateSchema = createSchema.omit({ id: true }).partial();

/** The fields this request owns, and therefore the fields a replay must match. */
const RESOURCE_REPLAY_KEYS = ["name", "description"] as const;

resourcesRouter.get("/", async (_req, res) => {
  const rows = await prisma.resource.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { messages: true, keywords: true } },
      messages: { select: { body: true } },
    },
  });
  res.json(
    rows.map(({ messages, ...resource }) => ({
      ...resource,
      invalidMessageCount: messages.filter(
        (message) => message.body !== null && isInstagramGuideTextTooLong(message.body),
      ).length,
    })),
  );
});

resourcesRouter.get("/:id", async (req, res) => {
  const row = await prisma.resource.findUnique({
    where: { id: req.params.id },
    include: {
      messages: { orderBy: { order: "asc" } },
      keywords: { select: { id: true, keyword: true } },
    },
  });
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json({
    ...row,
    invalidMessageCount: row.messages.filter(
      (message) => message.body !== null && isInstagramGuideTextTooLong(message.body),
    ).length,
  });
});

resourcesRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = { ...parsed.data, description: parsed.data.description ?? null };

  if (idempotencyKeyMismatch(req.headers["idempotency-key"], data.id)) {
    return res.status(400).json({ error: "idempotency_key_mismatch" });
  }

  try {
    res.status(201).json(await prisma.resource.create({ data }));
  } catch (error) {
    if (!isPrimaryKeyViolation(error)) throw error;
    const existing = await prisma.resource.findUnique({ where: { id: data.id } });
    // The row must exist: the primary key just told us so.
    if (!existing) throw error;
    if (classifyCreateReplay({ existing, intended: data, keys: RESOURCE_REPLAY_KEYS }) === "conflict") {
      return res.status(409).json({ error: "idempotency_conflict" });
    }
    res.status(200).json(existing);
  }
});

resourcesRouter.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated = await prisma.resource.update({
    where: { id: req.params.id },
    data: parsed.data,
  });
  res.json(updated);
});

resourcesRouter.delete("/:id", async (req, res, next) => {
  const id = req.params.id;
  const deliveryHistoryCount = await prisma.guideDelivery.count({
    where: { resourceId: id },
  });
  if (deliveryHistoryCount > 0) {
    return res.status(409).json({ error: "resource_has_delivery_history" });
  }

  /**
   * An upcoming setup holding this guide blocks the delete.
   *
   * `upcoming_automations.resource_id` is an ON DELETE RESTRICT foreign key, so
   * Postgres refuses regardless. Without this guard the constraint violation left
   * the async handler rejecting with nothing to catch it (see `next` below), so the
   * request was never answered at all: the browser waited out its 20s deadline and
   * reported a bare "Delete failed" that named neither the cause nor a way out.
   *
   * It refuses rather than cascading: cancelling someone's scheduled setup as a
   * side effect of deleting a guide is a bigger decision than the click implies.
   * The trigger words are returned so the answer is actionable.
   *
   * Every status, not only the open ones — the constraint does not care whether a
   * setup is waiting, attached or cancelled, so neither can this check.
   */
  const blockingSetups = await prisma.upcomingAutomation.findMany({
    where: { resourceId: id },
    select: { triggerWord: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  if (blockingSetups.length > 0) {
    return res.status(409).json({
      error: "resource_has_upcoming_setup",
      triggerWords: blockingSetups.map((setup) => setup.triggerWord),
      // True when cancelling a setup would unblock the delete. False means the
      // only rows holding it are already resolved, which the owner cannot clear
      // from the interface — worth distinguishing rather than telling them to
      // cancel something that is already cancelled.
      clearable: blockingSetups.some(
        (setup) => setup.status === "waiting" || setup.status === "needs_attention",
      ),
    });
  }

  // A published cover is immutable public history. Deleting the resource would
  // either strand its public PNG or require a broad Storage cleanup, neither of
  // which is an acceptable side effect of an ordinary guide delete.
  const publishedCoverCount = await prisma.resourceCoverVersion.count({
    where: { resourceId: id, status: "published" },
  });
  if (publishedCoverCount > 0) {
    return res.status(409).json({ error: "resource_has_published_cover" });
  }

  const storedCoverHistoryCount = await prisma.resourceCoverVersion.count({
    where: { resourceId: id, dmStoragePath: { not: null } },
  });
  if (storedCoverHistoryCount > 0) {
    return res.status(409).json({ error: "resource_has_cover_history" });
  }

  // Orphans name exact uploaded objects that the cleanup worker must reconcile.
  // Keep their resource/cover foreign keys intact until that exact-path cleanup
  // has settled; never replace this with a bucket-prefix delete.
  const pendingCoverCleanupCount = await prisma.guideCoverOrphan.count({
    where: { resourceId: id },
  });
  if (pendingCoverCleanupCount > 0) {
    return res.status(409).json({ error: "resource_has_cover_cleanup_pending" });
  }

  const keywordIds = (
    await prisma.keyword.findMany({ where: { resourceId: id }, select: { id: true } })
  ).map((k) => k.id);
  try {
    await prisma.$transaction([
      prisma.conversation.deleteMany({ where: { keywordId: { in: keywordIds } } }),
      prisma.keyword.deleteMany({ where: { resourceId: id } }),
      // Only unpublished database drafts are removed. Generated Storage objects
      // are never created for drafts, and no Storage call belongs in this route.
      prisma.resourceCoverVersion.deleteMany({ where: { resourceId: id } }),
      prisma.resourceCoverSuggestion.deleteMany({ where: { resourceId: id } }),
      prisma.resourcePresentation.deleteMany({ where: { resourceId: id } }),
      prisma.resource.delete({ where: { id } }),
    ]);
  } catch (error) {
    // Backstop for a restricting reference this route does not yet know about, so
    // the next one is a refusal that says "something still points at this" rather
    // than another silent hang.
    if (isForeignKeyViolation(error)) {
      return res.status(409).json({ error: "resource_still_referenced" });
    }
    // `next`, not `throw`. Express 4 does not forward a rejected promise from an
    // async handler, so throwing here answers nothing at all and the request hangs
    // until the browser gives up. Handing it over reaches the error middleware in
    // router.ts and becomes an honest 500. Same reason as guideDeliveries.routes.ts.
    return next(error);
  }
  res.status(204).end();
});
