import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { liveToken } from "./lib/live-token.mjs";

dotenv.config();
const prisma = new PrismaClient();

const TOKEN = await liveToken();
const IG_USER_ID = process.env.IG_USER_ID;
const VERSION = "v21.0";

// FEASIBILITY PROBE (read-only). Before building username resolution for DM
// senders, find out whether Instagram will even resolve an IGSID -> username on
// THIS account/token. We try the documented approaches and report what works.
//
// Background: DM-sender IDs are Instagram-Scoped IDs (IGSID). Reversing them to
// a public @handle is privacy-restricted and frequently returns nothing. This
// script tells us, with real data, whether option C is viable here.

async function tryEndpoint(label, url) {
  try {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (body.error) {
      console.log(`  [${label}] ✗ ${res.status}  code ${body.error.code}/${body.error.error_subcode ?? "-"}  "${body.error.message}"`);
      return null;
    }
    console.log(`  [${label}] ✓ ${JSON.stringify(body)}`);
    return body;
  } catch (e) {
    console.log(`  [${label}] ✗ threw: ${e.message}`);
    return null;
  }
}

async function main() {
  if (!TOKEN || !IG_USER_ID) {
    console.error("IG_ACCESS_TOKEN / IG_USER_ID missing — run from project root.");
    process.exit(1);
  }

  // Grab a few distinct DM-sender ids we actually saw (keyword_matched src=dm).
  const dmEvents = await prisma.eventLog.findMany({
    where: { kind: "keyword_matched" },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const ids = [
    ...new Set(
      dmEvents
        .filter((e) => e.payload?.source === "dm" && e.payload?.senderId)
        .map((e) => e.payload.senderId),
    ),
  ].slice(0, 3);

  if (ids.length === 0) {
    console.log("No DM-sourced sender IDs found in logs to test with.");
    return;
  }

  console.log(`Testing IGSID -> username resolution on ${ids.length} real DM sender id(s).\n`);

  for (const id of ids) {
    console.log(`igUserId = ${id}`);
    // Approach 1: treat the sender id as a node and ask for username.
    await tryEndpoint("direct-node", `https://graph.instagram.com/${VERSION}/${id}?fields=username,name&access_token=${TOKEN}`);
    // Approach 2: via the business account's conversation/participant scope.
    await tryEndpoint(
      "business-scoped",
      `https://graph.instagram.com/${VERSION}/${id}?fields=username&access_token=${TOKEN}`,
    );
    console.log("");
  }

  console.log("=== Verdict ===");
  console.log("  • Any ✓ with a username  → option C is viable; we can resolve DM senders.");
  console.log("  • All ✗ (code 100/803/...) → IGSID is not resolvable on this token;");
  console.log("    fall back to comments-only usernames (option A), DM users stay numeric.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
