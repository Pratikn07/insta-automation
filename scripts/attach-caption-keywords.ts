import { prisma } from "../src/lib/prisma.js";

// One-off (safe to re-run): give every post that NAMES its keyword in the caption
// its own post-scoped Keyword row.
//
// WHY. resolveCommentMatch is strict only for posts that already have a keyword
// attached; a post with none still answers all 24 legacy globals. Measured before
// this ran: 1,350 of 1,461 comment matches (92%) resolved by global fallback
// across 29 posts, and only 7 posts were strict. That is how GREEN — the veggie
// guide — fired on an activity reel and DM'd someone the wrong gate.
//
// Attaching the caption's own keyword flips that post to strict, so it answers
// that word and nothing else. The row copies resourceId, publicReply and
// gateMessage verbatim from the matching global, so the INTENDED keyword behaves
// exactly as it does today — only the cross-post leak stops.
//
// Reversal: set active = false on the rows this created (they are the ones with a
// non-null mediaId and a createdAt from this run) and the old fallback resumes.

// Captions write the call to action two ways, and both must be read:
//   Comment "FANCY" / Comment “FANCY”   — quoted, any case
//   Comment ACTIVITY                     — bare, always shouted
// Missing the bare form is not hypothetical: it is the exact reason GREEN could
// still fire on the "Comment ACTIVITY" reel after the first pass of this script.
//
// Requiring the literal word "comment" first keeps ordinary quoted prose (one
// caption quotes "serve and return") out of the match, and requiring ALL CAPS for
// the unquoted form keeps ordinary sentences out. Neither guard has to be perfect:
// a word is attached ONLY if it already exists as an active global keyword, so a
// stray match resolves to nothing and is skipped below.
const CTA_RE = /[Cc]omment\s*(?:["“']([A-Za-z]{2,20})["”']|([A-Z]{2,20})\b)/;

function captionKeyword(caption: string | null): string | null {
  if (!caption) return null;
  const match = CTA_RE.exec(caption);
  if (!match) return null;
  return (match[1] ?? match[2])?.toUpperCase() ?? null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const [reels, feedPosts, keywords] = await Promise.all([
    prisma.reelMeta.findMany({ select: { mediaId: true, caption: true, permalink: true, postedAt: true } }),
    prisma.feedPostMeta.findMany({ select: { mediaId: true, caption: true, permalink: true, postedAt: true } }),
    prisma.keyword.findMany({
      select: {
        id: true, keyword: true, mediaId: true, active: true,
        resourceId: true, publicReply: true, gateMessage: true,
      },
    }),
  ]);

  // A post is "converted" once ANY keyword points at it, active or not: an
  // inactive row is a deliberate choice, and re-attaching would undo it.
  const converted = new Set(keywords.filter((k) => k.mediaId).map((k) => k.mediaId!));
  const globals = new Map(
    keywords.filter((k) => !k.mediaId && k.active).map((k) => [k.keyword.toUpperCase(), k]),
  );

  let attached = 0;
  const skippedNoGlobal: Array<{ mediaId: string; keyword: string }> = [];

  for (const post of [...reels, ...feedPosts]) {
    const keyword = captionKeyword(post.caption);
    if (!keyword || converted.has(post.mediaId)) continue;

    const source = globals.get(keyword);
    if (!source) {
      // The caption asks for a word that has no keyword row at all, so there is
      // nothing to attach and no guide to send. Left alone on purpose: inventing
      // the guide is a content decision, not a data fix.
      skippedNoGlobal.push({ mediaId: post.mediaId, keyword });
      continue;
    }

    if (!dryRun) {
      await prisma.keyword.create({
        data: {
          keyword: source.keyword,
          mediaId: post.mediaId,
          resourceId: source.resourceId,
          publicReply: source.publicReply,
          gateMessage: source.gateMessage,
          active: true,
          mediaCaption: post.caption,
          mediaPermalink: post.permalink,
          mediaPostedAt: post.postedAt,
        },
      });
    }
    // Guard against two posts in this same run sharing a media id.
    converted.add(post.mediaId);
    attached++;
    console.log(`${dryRun ? "would attach" : "attached"} ${source.keyword} → ${post.mediaId}`);
  }

  console.log(`\n${dryRun ? "Would attach" : "Attached"}: ${attached} post-scoped keyword(s)`);
  if (skippedNoGlobal.length) {
    console.log(`\nDead CTAs — caption asks for a word with no keyword row (needs content, not code):`);
    for (const s of skippedNoGlobal) console.log(`  ${s.keyword.padEnd(12)} ${s.mediaId}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
