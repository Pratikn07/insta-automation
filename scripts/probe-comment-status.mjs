import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { liveToken } from "./lib/live-token.mjs";

dotenv.config();
const prisma = new PrismaClient();

const TOKEN = await liveToken();
const VERSION = "v21.0";

// Read-only. For each comment that failed the gate DM with 2534025, ask Instagram
// directly whether the comment is hidden (spam-filtered) or still exists. This is
// the test that distinguishes "Instagram spam-hid the comment" from an
// account/rate-level cause — the two remaining theories.
async function fetchComment(id) {
  const url = `https://graph.instagram.com/${VERSION}/${id}?fields=id,hidden,text,username,timestamp,parent_id&access_token=${TOKEN}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  if (!TOKEN) {
    console.error("IG_ACCESS_TOKEN missing — run from project root so .env loads.");
    process.exit(1);
  }

  const failed = await prisma.eventLog.findMany({
    where: { kind: "dm_failed" },
    orderBy: { createdAt: "desc" },
    take: 25,
  });
  const ids = [...new Set(failed.map((e) => e.payload?.commentId).filter(Boolean))];

  if (ids.length === 0) {
    console.log("No dm_failed comment IDs found.");
    return;
  }

  console.log(`Probing ${ids.length} failed comment(s) via Instagram Graph API:\n`);
  let hidden = 0;
  let gone = 0;
  let visible = 0;

  for (const id of ids) {
    const { status, body } = await fetchComment(id);
    if (body.error) {
      gone++;
      console.log(
        `  ${id}  → ERROR ${status}: code ${body.error.code}/${body.error.error_subcode ?? "-"} "${body.error.message}"`,
      );
    } else {
      if (body.hidden === true) hidden++;
      else visible++;
      console.log(
        `  ${id}  → hidden=${body.hidden}  @${body.username ?? "?"}  parent_id=${body.parent_id ?? "—"}  "${(body.text ?? "").slice(0, 40)}"`,
      );
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  hidden=true (spam-filtered): ${hidden}`);
  console.log(`  visible (hidden=false):      ${visible}`);
  console.log(`  errored/deleted:             ${gone}`);
  console.log(`\nInterpretation:`);
  console.log(`  • mostly hidden=true  → Instagram spam-filtered these comments; you cannot`);
  console.log(`                          private-reply to a hidden comment. (Leading theory.)`);
  console.log(`  • mostly visible      → NOT a hide; cause is account/rate/surge-level.`);
  console.log(`  • mostly errored      → comments were deleted/removed before we replied.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
