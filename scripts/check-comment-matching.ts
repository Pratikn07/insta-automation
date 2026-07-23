import { prisma } from "../src/lib/prisma.js";
import {
  extractCandidates,
  scannableCommentTokens,
  findKeywordForComment,
} from "../src/services/keywordService.js";

// Verify all-token comment matching (fix #8).
//   npx tsx scripts/check-comment-matching.ts            # assertions vs live keywords
//   npx tsx scripts/check-comment-matching.ts --dry-run  # replay last 30d of comments
//
// Assertions hit the real keywords table (read-only). Expected results assume the
// standard active global keywords (SLEEP, POTTY, EGG, GUMMY, CALM, …).

const SELF_IG_ID = "17841473010795625";

async function assertions() {
  // [comment, expected matched keyword | null]
  const cases: [string, string | null][] = [
    ["Sleep", "SLEEP"], // baseline single token
    ["Potty🙏", "POTTY"], // emoji glued
    ["@tinysoho sleep", "SLEEP"], // leading @mention
    ["DM EGG", "EGG"], // keyword not first word
    ["Gummy!", "GUMMY"], // trailing punctuation
    ["Calm🙏", "CALM"],
    ["At what age we should start potty training?", null], // long → question, not a request
    ["cook him one egg at the same time", null], // long → incidental keyword
    ["I love to play and read a book", null], // long → PLAY/BOOK incidental, no gate
    ["❤️❤️❤️", null], // no word tokens
    ["@tinysoho", null], // mention only
  ];

  let failed = 0;
  for (const [text, expected] of cases) {
    const match = await findKeywordForComment(text, null);
    const got = match?.keyword.keyword ?? null;
    const ok = got === expected;
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${JSON.stringify(text)} → ${got ?? "null"} (expected ${expected ?? "null"})`);
  }
  console.log(failed === 0 ? "\nALL ASSERTIONS PASSED" : `\n${failed} ASSERTION(S) FAILED`);
  if (failed > 0) process.exitCode = 1;
}

async function dryRun() {
  // Active keywords → global set + per-reel scoped sets.
  const keywords = await prisma.keyword.findMany({
    where: { active: true },
    select: { keyword: true, mediaId: true },
  });
  const global = new Set(keywords.filter((k) => !k.mediaId).map((k) => k.keyword));
  const scoped = new Map<string, Set<string>>();
  for (const k of keywords) {
    if (k.mediaId) (scoped.get(k.mediaId) ?? scoped.set(k.mediaId, new Set()).get(k.mediaId)!).add(k.keyword);
  }
  const matchInMemory = (text: string, mediaId: string | null): string | null => {
    const scan = scannableCommentTokens(text);
    if (mediaId && scoped.has(mediaId)) {
      const hit = scan.find((t) => scoped.get(mediaId)!.has(t));
      if (hit) return hit;
    }
    return scan.find((t) => global.has(t)) ?? null;
  };

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const received = await prisma.eventLog.findMany({
    where: { kind: "comment_received", createdAt: { gte: since } },
    select: { payload: true },
  });
  const matchedIds = new Set(
    (
      await prisma.eventLog.findMany({
        where: { kind: "keyword_matched", createdAt: { gte: since } },
        select: { payload: true },
      })
    )
      .map((r) => (r.payload as { commentId?: string }).commentId)
      .filter(Boolean) as string[],
  );

  let newMatches = 0;
  let newMultiWord = 0;
  const longMatches: string[] = []; // matched despite >3 candidates — review these
  for (const r of received) {
    const p = r.payload as { commentId?: string; text?: string; mediaId?: string | null; fromId?: string };
    if (!p.commentId || !p.text || p.fromId === SELF_IG_ID) continue;
    const kw = matchInMemory(p.text, p.mediaId ?? null);
    if (!kw) continue;
    if (matchedIds.has(p.commentId)) continue; // already matched live
    newMatches++;
    const candCount = extractCandidates(p.text).length;
    if (candCount > 1) newMultiWord++;
    if (candCount > 3) longMatches.push(`${kw} ← ${JSON.stringify(p.text.slice(0, 80))}`);
  }

  console.log(`Comments scanned (30d, non-self): ${received.length}`);
  console.log(`NEW matches the old first-word matcher missed: ${newMatches}`);
  console.log(`  of which multi-word comments: ${newMultiWord}`);
  console.log(`Matches on comments with >3 tokens (first-word only): ${longMatches.length}`);
  for (const s of longMatches.slice(0, 15)) console.log(`   ${s}`);
}

async function main() {
  if (process.argv.includes("--dry-run")) await dryRun();
  else await assertions();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
