import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getDashboardStats, type DashboardStats } from "../services/statsService.js";
import { getIgUsers } from "../services/igUserService.js";
import { createReadThroughCache } from "../lib/readThroughCache.js";
import { asyncRouter } from "./asyncRouter.js";

export const statsRouter = asyncRouter();

/**
 * Home reads this on every mount, and it is the most expensive read in the app:
 * twelve queries, two of which are multi-second aggregates over event_log.
 *
 * Everything in it is an hour-scale operational count — today's DM total, queue
 * depths, follower yield over a 30-day window, the token countdown. None of it
 * changes meaningfully inside half a minute, so recomputing per page load bought
 * nothing and starved the connection pool.
 *
 * Exported so tests can start from a cold cache; nothing in production should
 * need to reach for it.
 */
export const STATS_CACHE_TTL_MS = 30_000;
export const statsCache = createReadThroughCache<DashboardStats>({
  ttlMs: STATS_CACHE_TTL_MS,
  maxEntries: 1,
});

statsRouter.get("/", async (_req, res) => {
  const stats = await statsCache.get("dashboard", getDashboardStats);
  res.json(stats);
});

const eventsQuery = z.object({
  kind: z.string().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});

statsRouter.get("/events", async (req, res) => {
  const parsed = eventsQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { kind, limit, cursor } = parsed.data;

  const rows = await prisma.eventLog.findMany({
    where: kind ? { kind } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  // Events carry the user id inside payload (senderId / fromId). Collect them and
  // return a users map so the Activity feed can label rows with @handles.
  const ids: string[] = [];
  for (const e of items) {
    const p = e.payload as { senderId?: unknown; fromId?: unknown } | null;
    if (p && typeof p === "object") {
      if (typeof p.senderId === "string") ids.push(p.senderId);
      if (typeof p.fromId === "string") ids.push(p.fromId);
    }
  }
  const users = await getIgUsers(ids);

  res.json({
    items,
    users,
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
  });
});
