import { prisma } from "../src/lib/prisma.js";

// Gate copy for the HARD follow gate: following is a stated requirement to get
// the guide (the reply alone no longer unlocks it — see messageHandler's
// follow-gate). Phrased so the ~80% who already follow just reply DONE. Every
// gate asks for "DONE" (never a keyword word like PICKY, which would re-trigger
// the gate instead of completing it).
//
//   npx tsx scripts/reword-gates.ts --dry-run   # preview current -> new
//   npx tsx scripts/reword-gates.ts             # apply
const ALREADY = "Already following? Just reply DONE!";
const one = (deliverable: string) =>
  `Your ${deliverable} is ready! 💛 Follow @tinysoho and reply DONE, and I'll send it right over. ${ALREADY}`;
const many = (deliverable: string) =>
  `Your ${deliverable} are ready! 💛 Follow @tinysoho and reply DONE, and I'll send them right over. ${ALREADY}`;

// Keyed by the normalized (uppercase) keyword.
const GATES: Record<string, string> = {
  SLEEP: one("sleep guide"),
  POTTY: one("potty training guide"),
  WEAN: one("weaning guide"),
  PLAY: many("play ideas"),
  PICKY: one("FREE Toddler Feeding Handbook"),
  ACTIVITY: one("DIY Shape Matching Activity Guide"),
  OVERTIRED: one("overtired-signs guide"),
  RECIPE: one("recipe"),
  BREAKFAST: many("breakfast ideas"),
  BOOK: one("book"),
  GUIDE: one("guide"),
  CALM: one("calming guide"),
  EGG: one("egg carton activity guide"),
  GUMMY: one("homemade gummy recipe"),
  DOUGH: one("play dough recipe"),
  BOX: one("box play guide"),
  GREEN: one("veggie guide"),
  LINK: one("link"),
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const keywords = await prisma.keyword.findMany({
    select: { id: true, keyword: true, gateMessage: true },
  });

  const byName = new Map(keywords.map((k) => [k.keyword.toUpperCase(), k]));
  const mapped = Object.keys(GATES);
  const missing = mapped.filter((k) => !byName.has(k));
  const unmapped = keywords.filter((k) => !(k.keyword.toUpperCase() in GATES));
  if (missing.length) console.warn(`⚠ mapped keyword(s) not in DB: ${missing.join(", ")}`);
  if (unmapped.length) console.warn(`⚠ DB keyword(s) with no rewrite: ${unmapped.map((k) => k.keyword).join(", ")}`);

  let changed = 0;
  for (const [name, next] of Object.entries(GATES)) {
    const row = byName.get(name);
    if (!row) continue;
    if (row.gateMessage === next) {
      console.log(`= ${name} (already up to date)`);
      continue;
    }
    changed++;
    console.log(`\n${name}\n  - ${row.gateMessage}\n  + ${next}`);
    if (!dryRun) {
      await prisma.keyword.update({ where: { id: row.id }, data: { gateMessage: next } });
    }
  }

  console.log(
    `\n${dryRun ? "DRY RUN — " : ""}${changed} of ${mapped.length} gate message(s) ${dryRun ? "would change" : "updated"}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
