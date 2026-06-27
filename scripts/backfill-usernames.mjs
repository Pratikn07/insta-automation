import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();
const prisma = new PrismaClient();

const TOKEN = process.env.IG_ACCESS_TOKEN;
const VERSION = "v21.0";
const THROTTLE_MS = 350; // be gentle with the Graph API

// One-off backfill. Walks every distinct Instagram user id we've seen (in
// conversations + event payloads) and resolves username/name into the ig_users
// table, so historical users (e.g. alaira024) show names without re-interacting.
// Skips ids already resolved. Read-mostly: only writes ig_users rows.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collectIds() {
  const ids = new Set();

  const convos = await prisma.conversation.findMany({ select: { igUserId: true } });
  for (const c of convos) if (c.igUserId) ids.add(c.igUserId);

  // Scan event payloads for igUserId / senderId / fromId.
  const events = await prisma.eventLog.findMany({ select: { payload: true }, take: 5000 });
  for (const e of events) {
    const p = e.payload;
    if (p && typeof p === "object") {
      for (const key of ["igUserId", "senderId", "fromId"]) {
        if (typeof p[key] === "string") ids.add(p[key]);
      }
    }
  }
  return [...ids];
}

async function main() {
  if (!TOKEN) {
    console.error("IG_ACCESS_TOKEN missing — run from project root so .env loads.");
    process.exit(1);
  }

  const ids = await collectIds();
  // Skip ids we already resolved successfully.
  const already = await prisma.igUser.findMany({
    where: { id: { in: ids }, NOT: { resolvedAt: null } },
    select: { id: true },
  });
  const done = new Set(already.map((r) => r.id));
  const todo = ids.filter((id) => !done.has(id) && id !== process.env.IG_USER_ID);

  console.log(`Found ${ids.length} distinct ids; ${done.size} already resolved; resolving ${todo.length}.\n`);

  let ok = 0;
  let fail = 0;
  for (const id of todo) {
    try {
      const url = `https://graph.instagram.com/${VERSION}/${id}?fields=username,name&access_token=${TOKEN}`;
      const res = await fetch(url);
      const body = await res.json().catch(() => ({}));
      if (body.error || !body.username) {
        fail++;
        await prisma.igUser.upsert({
          where: { id },
          create: { id, username: null, name: null, resolvedAt: null },
          update: {},
        });
        console.log(`  ${id} → (unresolved${body.error ? `: ${body.error.message}` : ""})`);
      } else {
        ok++;
        await prisma.igUser.upsert({
          where: { id },
          create: { id, username: body.username, name: body.name ?? null, resolvedAt: new Date() },
          update: { username: body.username, name: body.name ?? null, resolvedAt: new Date() },
        });
        console.log(`  ${id} → @${body.username}${body.name ? ` (${body.name})` : ""}`);
      }
    } catch (e) {
      fail++;
      console.log(`  ${id} → ERROR ${e.message}`);
    }
    await sleep(THROTTLE_MS);
  }

  console.log(`\nDone. Resolved ${ok}, unresolved ${fail}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
