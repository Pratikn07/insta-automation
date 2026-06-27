import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getIgUsers } from "../services/igUserService.js";

export const usersRouter = Router();

// ---- Directory: distinct users we've interacted with ------------------------
//
// We source the canonical user set from Conversation.igUserId (indexed, cheap),
// which covers everyone who triggered a keyword via comment or DM. We join the
// resolved IgUser rows for usernames, and order by most-recent conversation.
const listQuery = z.object({
  q: z.string().trim().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

usersRouter.get("/", async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { q, limit } = parsed.data;

  // Most recent conversation per user → defines the directory + lastActiveAt.
  const convos = await prisma.conversation.findMany({
    orderBy: { createdAt: "desc" },
    select: { igUserId: true, createdAt: true, state: true },
  });

  // Collapse to one row per user with counts + last activity.
  const byUser = new Map<
    string,
    { igUserId: string; lastActiveAt: Date; conversationCount: number }
  >();
  for (const c of convos) {
    const e = byUser.get(c.igUserId);
    if (e) {
      e.conversationCount += 1;
      if (c.createdAt > e.lastActiveAt) e.lastActiveAt = c.createdAt;
    } else {
      byUser.set(c.igUserId, {
        igUserId: c.igUserId,
        lastActiveAt: c.createdAt,
        conversationCount: 1,
      });
    }
  }

  const ids = [...byUser.keys()];
  const users = await getIgUsers(ids);

  let items = [...byUser.values()]
    .sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())
    .map((u) => ({
      igUserId: u.igUserId,
      username: users[u.igUserId]?.username ?? null,
      name: users[u.igUserId]?.name ?? null,
      isFollower: users[u.igUserId]?.isFollower ?? null,
      followerCount: users[u.igUserId]?.followerCount ?? null,
      isVerified: users[u.igUserId]?.isVerified ?? null,
      lastActiveAt: u.lastActiveAt,
      conversationCount: u.conversationCount,
    }));

  // Optional search on username / name / id (case-insensitive substring).
  if (q) {
    const needle = q.toLowerCase();
    items = items.filter(
      (u) =>
        u.username?.toLowerCase().includes(needle) ||
        u.name?.toLowerCase().includes(needle) ||
        u.igUserId.includes(needle),
    );
  }

  res.json({ items: items.slice(0, limit) });
});

// ---- Lineage: the full per-user journey, reconstructed from logs -------------
usersRouter.get("/:igUserId/lineage", async (req, res) => {
  const igUserId = req.params.igUserId;

  const [igUser, conversations] = await Promise.all([
    prisma.igUser.findUnique({ where: { id: igUserId } }),
    prisma.conversation.findMany({
      where: { igUserId },
      orderBy: { createdAt: "asc" },
      include: { keyword: { select: { id: true, keyword: true } } },
    }),
  ]);

  const convoIds = conversations.map((c) => c.id);

  // Events are attributed three ways depending on kind:
  //   comment_* → payload.fromId ; message_* / *_dm → payload.senderId ;
  //   gate/sequence/public_reply/done → payload.conversationId.
  // One OR query covers all three (conversationId expanded to this user's set).
  const merged = await prisma.eventLog.findMany({
    where: {
      OR: [
        { payload: { path: ["senderId"], equals: igUserId } },
        { payload: { path: ["fromId"], equals: igUserId } },
        ...convoIds.map((id) => ({
          payload: { path: ["conversationId"], equals: id },
        })),
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 1000,
  });

  // Normalize so the frontend renders without re-parsing payloads.
  const events = merged.map((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    return {
      id: e.id,
      kind: e.kind,
      createdAt: e.createdAt,
      text: typeof p.text === "string" ? p.text : null,
      keyword: typeof p.keyword === "string" ? p.keyword : null,
      source: typeof p.source === "string" ? p.source : null,
      subcode: typeof p.subcode === "number" ? p.subcode : null,
      message: typeof p.message === "string" ? p.message : null,
      conversationId: typeof p.conversationId === "string" ? p.conversationId : null,
    };
  });

  res.json({
    user: {
      igUserId,
      username: igUser?.username ?? null,
      name: igUser?.name ?? null,
      isFollower: igUser?.isFollower ?? null,
      followerCount: igUser?.followerCount ?? null,
      isVerified: igUser?.isVerified ?? null,
      followCheckedAt: igUser?.followCheckedAt ?? null,
    },
    conversations,
    events,
  });
});
