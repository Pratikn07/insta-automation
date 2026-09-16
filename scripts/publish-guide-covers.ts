/**
 * Publish guide covers and attach them to the live delivery path.
 *
 * Two phases, both idempotent, `--dry-run` by default:
 *
 *   1. publish — create the presentation + cover draft, approve it, publish it. This
 *      renders the PNG, uploads it to public Storage and returns a content-hashed URL.
 *   2. attach  — insert one `resource_messages` row so the cover is the first thing a
 *      parent receives.
 *
 * Why `order: -1` rather than 0. The live sender does
 * `[...messages].sort((a, b) => a.order - b.order)`, a plain numeric sort, so -1 leads.
 * Every guide here already has a text message at 0, and inserting at 0 would mean
 * renumbering every existing row — a multi-row rewrite of live content to add one image.
 * At -1 the change is a single INSERT that touches nothing else, and rolling back is one
 * DELETE. There is no CHECK constraining `order`, only a UNIQUE on (resource_id, order).
 *
 * Edition numbers are NOT set here. `presentation_category.next_edition_number` is
 * incremented atomically inside the publish transaction, so covers number themselves in
 * publish order — the first bedtime cover is SLEEP · 01, the next SLEEP · 02. That is the
 * counter that tells a parent more guides exist, and it only works if this script does not
 * try to assign it.
 */
import { createHash, randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { guideCoverPublicUrl } from "../src/lib/guideCoverProvider.js";
import { createGuideCoverRepository } from "../src/services/guideCoverRepository.js";
import { createGuideCoverPublishService } from "../src/services/guideCoverPublishService.js";
import { renderGuideCoverPng } from "../src/services/guideCoverPngRenderer.js";
import type { GuideCoverRenderInput } from "../shared/guideCoverPolicy.js";

const ACTOR = "publish-guide-covers-script";

type CoverPlan = {
  resourceId: string;
  label: string;
  categorySlug: "bedtime" | "potty-training" | "recipes" | "montessori-activities";
  headline: string;
  supportingLine: string;
  /**
   * Published but deliberately NOT attached to the live path. Used when a cover renders
   * correctly yet misrepresents its guide — the cover exists for review and can be
   * attached by flipping this off, without republishing.
   */
  holdAttach?: true;
};

/**
 * Categorised from each guide's own content, not from its name.
 *
 * Only guides that carry NO media today are included, so every attach is a pure insert.
 * `Picky` is deliberately absent: it already leads with 10 images, so it has a visual first
 * impression already and inserting ahead of it is a different, more invasive change.
 *
 * Four of these are categorised into the closest available fit rather than a true one, and
 * that is a known compromise pending more categories:
 *   - Calm / Green / DINNER / Dinner are mealtime BEHAVIOUR, not recipes. The kicker
 *     ("A LITTLE WIN AT THE TABLE") fits them; the "RECIPES" collection label does not.
 *   - Brush is a bedtime-routine guide, so bedtime's kicker and house/moon artwork fit.
 *   - Leave is a playground guide, and "PURPOSEFUL PLAY FOR TODAY" genuinely fits.
 *   - Car is the weakest fit in the set. Potty's "A LITTLE STEP FOR TODAY" suits a car-seat
 *     routine better, but its potty-seat illustration would misrepresent the guide, and the
 *     illustration carries more meaning than the kicker.
 */
const PLAN: CoverPlan[] = [
  // ─ bedtime ────────────────────────────────────────────────────────────────────────
  {
    resourceId: "a36ffee2-3a14-4028-b74a-cf6f90f4640b",
    label: "Bedtime (reset, 8 msgs)",
    categorySlug: "bedtime",
    headline: "Bedtime can feel softer",
    supportingLine: "A calmer bedtime, one small shift at a time.",
  },
  {
    resourceId: "1ad24300-0c28-4326-9863-fe777e4038e7",
    label: "Bedtime (reset, 6 msgs)",
    categorySlug: "bedtime",
    headline: "The bedtime reset",
    supportingLine: "Five small shifts for calmer evenings.",
  },
  {
    resourceId: "2d498174-c71f-44c3-b44d-f6f4954fcefb",
    label: "Bedtime (starts earlier, 9 msgs)",
    categorySlug: "bedtime",
    headline: "Bedtime starts before bedtime",
    supportingLine: "Why the battle begins earlier than you think.",
  },
  {
    resourceId: "6e39d6e0-6441-4100-8a40-9c6d500d432a",
    label: "OVERTIRED",
    categorySlug: "bedtime",
    headline: "Wired, not tired",
    supportingLine: "Spotting an overtired toddler, and what helps.",
  },
  {
    resourceId: "583f44ef-876f-4649-8a4e-50b08c504bac",
    label: "Pacifier",
    categorySlug: "bedtime",
    headline: "Letting go of the pacifier",
    supportingLine: "Building other ways to settle, before it goes.",
  },
  {
    resourceId: "455815fc-6d73-4296-8080-cd55cf8d1c98",
    label: "Wean",
    categorySlug: "bedtime",
    headline: "Weaning, one gentle step",
    supportingLine: "The exact process that worked for us.",
  },
  {
    resourceId: "7d74ae67-ab4e-4df1-a25f-7e378fd3cc7a",
    label: "Brush (bedtime routine)",
    categorySlug: "bedtime",
    headline: "Toothbrushing without the fight",
    supportingLine: "Less tension at the sink, starting tonight.",
  },
  {
    /**
     * The account's highest-volume keyword, by a factor of nine: 949 journeys in the 30 days
     * to 2026-08-24, against 37 for the next uncovered guide. It was missing from this list by
     * OMISSION, not judgement — it carries no media, so it always satisfied the pure order -1
     * insert this script was built around, and the only guide deliberately excluded is `Picky`
     * for leading with ten images.
     *
     * The cost of that omission was concrete: `loadGateCard` filters on a published square, so
     * until now the single most-requested guide on the account could only ever send its follow
     * request as plain text — the one message more than half of those parents ever receive.
     *
     * Copy is from the guide's own content, which is about reaching longer sleep stretches from
     * around two months through a consistent routine, full daytime feeds and room to
     * self-settle. Not from the keyword: "Sleep" as a name says nothing a parent would
     * recognise.
     */
    resourceId: "c5aa5d70-b6ac-455c-9e24-33eb5037e5ee",
    label: "Sleep (longer stretches, 3 msgs)",
    categorySlug: "bedtime",
    headline: "Longer sleep stretches",
    supportingLine: "Same routine, full days, room to self-settle.",
  },

  // ─ potty-training ─────────────────────────────────────────────────────────────────
  {
    resourceId: "90f8a6c1-b148-40b4-b539-04f7bab5f7e7",
    label: "Poop (refusal)",
    categorySlug: "potty-training",
    headline: "Pees in the potty, holds the rest",
    supportingLine: "Why it happens, and how to help them let go.",
  },
  {
    resourceId: "8d4d15d0-f80b-449a-a78f-985020a3aa7d",
    label: "Poop (refusal, duplicate post)",
    categorySlug: "potty-training",
    headline: "Pees in the potty, holds the rest",
    supportingLine: "Why it happens, and how to help them let go.",
  },
  {
    resourceId: "8d50f17b-8fd8-4550-b8fa-33000740abcc",
    label: "potty (Day 0)",
    categorySlug: "potty-training",
    headline: "Before you start potty training",
    supportingLine: "The signs that say wait, and the ones that say go.",
  },
  {
    resourceId: "caed94df-216b-4aa4-aaa7-4d5b7bd2fa83",
    label: "Potty (reminders backfire)",
    categorySlug: "potty-training",
    headline: "When reminders start to backfire",
    supportingLine: "What to try when every answer is no.",
  },

  // ─ montessori-activities ──────────────────────────────────────────────────────────
  {
    resourceId: "0450e548-c82f-4e91-ae76-931cc381d207",
    label: "Cardboard (feed the monster)",
    categorySlug: "montessori-activities",
    headline: "Feed the monster",
    supportingLine: "One cardboard box, one happy afternoon.",
  },
  {
    resourceId: "94031918-f961-4cb8-ab68-40b1a1064eeb",
    label: "Skills (life skills)",
    categorySlug: "montessori-activities",
    headline: "Little skills, big independence",
    supportingLine: "Everyday practice for ages one to three.",
  },
  {
    resourceId: "d6bbc6d4-77ed-486c-92d1-1130efa30041",
    label: "Leave (playground)",
    categorySlug: "montessori-activities",
    headline: "Playground goodbyes",
    supportingLine: "No countdowns, no carrying them out.",
  },
  {
    resourceId: "e67757d1-2451-4e5b-b1ab-1b42cca7d955",
    label: "Car (car seat) — HELD, wrong fit on inspection",
    categorySlug: "montessori-activities",
    headline: "Car seat, calmly",
    supportingLine: "They need to know what happens next, not to love it.",
    // Held after looking at the rendered cover. "PURPOSEFUL PLAY FOR TODAY" above a
    // car-seat guide, over a shape-sorter tray, reads as a play activity — it actively
    // misdescribes the guide rather than merely sitting oddly beside it. Waiting for a
    // routines/transitions category rather than shipping the closest wrong thing.
    holdAttach: true,
  },

  // ─ recipes (mealtime behaviour — closest available fit) ───────────────────────────
  {
    resourceId: "7d0da01b-0b6b-417d-b23e-abae688f6ebe",
    label: "Calm (mealtime framework)",
    categorySlug: "recipes",
    headline: "A calmer mealtime",
    supportingLine: "The framework that kept food battles out of our home.",
  },
  {
    resourceId: "e76b016e-a679-44dc-9532-1888a07b077e",
    label: "Green (green food fear)",
    categorySlug: "recipes",
    headline: "When green feels unsafe",
    supportingLine: "Why they refuse it, and how to make it feel safe.",
  },
  {
    resourceId: "373cbc35-1053-430a-9bda-05a34630eadc",
    label: "DINNER (2-bite reset)",
    categorySlug: "recipes",
    headline: "Two bites, then snack",
    supportingLine: "What to do when dinner ends and hunger arrives later.",
  },
  {
    resourceId: "fadcf5f7-2eb5-418d-a37a-63d556653145",
    label: "Dinner (2-bite reset, duplicate post)",
    categorySlug: "recipes",
    headline: "Two bites, then snack",
    supportingLine: "What to do when dinner ends and hunger arrives later.",
  },
];

/**
 * The 26 recipe guides, headlines drafted from each guide's own first recipe rather than
 * from its keyword — "Recipe" appears six times as a name and means six different dishes,
 * so the name carries no information a parent would recognise.
 *
 * Held behind `--include-recipes` because this is 26 guides of parent-facing copy that
 * wants a human read before it ships, not because it is technically different.
 */
const RECIPE_PLAN: CoverPlan[] = [
  { resourceId: "d3e3f5a9-2e91-432a-8eea-d92a01d8cfc5", label: "Breakfast", categorySlug: "recipes",
    headline: "Apple toast bites", supportingLine: "A warm breakfast in about ten minutes." },
  { resourceId: "ae4bfa77-2ec9-4de4-91b3-e748d5fec5a6", label: "Chicken", categorySlug: "recipes",
    headline: "One chicken, five dinners", supportingLine: "Five toddler meals from a single rotisserie chicken." },
  { resourceId: "c835aee7-a631-4e38-95a5-811b6af9a991", label: "Dinner (cheesy broccoli)", categorySlug: "recipes",
    headline: "Cheesy broccoli pasta", supportingLine: "Small shapes, soft greens, one bowl." },
  { resourceId: "4ff036c1-82b4-48bb-92a2-fdab6ff4a4b4", label: "Dinner (picky days)", categorySlug: "recipes",
    headline: "Five dinners for picky days", supportingLine: "Simple, familiar and toddler friendly." },
  { resourceId: "e522c3c2-c637-4e35-bdd6-d33520f54cba", label: "Dinner (ravioli)", categorySlug: "recipes",
    headline: "Ten-minute ravioli", supportingLine: "Lemon, pea and ricotta, ready in ten." },
  { resourceId: "44513b10-03ac-4737-814d-a48f3bfda400", label: "Dinner (picky days, 2)", categorySlug: "recipes",
    headline: "Five easy toddler dinners", supportingLine: "One toddler serving each, ready fast." },
  { resourceId: "dc2a26bf-6af4-46e0-9ae3-bc6aeae3c84b", label: "Dinner (tomato spinach)", categorySlug: "recipes",
    headline: "Creamy tomato spinach pasta", supportingLine: "Two toddler servings, greens blended in." },
  { resourceId: "248094f5-d030-4d2a-a8a6-67db3bcfa324", label: "Fancy", categorySlug: "recipes",
    headline: "Mini fruit tart cups", supportingLine: "Oats, yogurt and fruit. No baking." },
  { resourceId: "89118597-3f3d-4543-994a-4bc96bbc3ef5", label: "Fiber", categorySlug: "recipes",
    headline: "White bean mac and cheese", supportingLine: "Creamy and cheesy, quietly full of fibre." },
  { resourceId: "7fa88842-49cb-419e-b08a-5f549072b069", label: "Freezer", categorySlug: "recipes",
    headline: "Freezer-friendly rice cups", supportingLine: "Make a batch, freeze, reheat all week." },
  { resourceId: "4f4db9af-336f-488d-866c-7a87f2267784", label: "Fruit", categorySlug: "recipes",
    headline: "Raspberry yogurt bark", supportingLine: "Freeze it once, snack on it all week." },
  { resourceId: "b1bd806d-af38-4206-8adb-4479cbda70c5", label: "Gummies", categorySlug: "recipes",
    headline: "Strawberry raspberry gummies", supportingLine: "Fruit, water and gelatin. That is all." },
  { resourceId: "8b44a369-517c-4e8d-b502-29a5c9d0f2c2", label: "GUMMY", categorySlug: "recipes",
    headline: "Mango strawberry gummies", supportingLine: "Real fruit, set soft enough for little hands." },
  { resourceId: "594e9978-83dc-4cbe-ad21-a640662821c4", label: "Lunch", categorySlug: "recipes",
    headline: "Black bean taquitos", supportingLine: "A lunch they can hold all by themselves." },
  { resourceId: "7a90aef4-e4de-4d67-80d4-6d936448c500", label: "Meal", categorySlug: "recipes",
    headline: "Five toddler dinners", supportingLine: "The recipes I promised, all in one place." },
  { resourceId: "de9c341c-5bee-4778-9ad6-4625033a8911", label: "MealPrep", categorySlug: "recipes",
    headline: "Hidden veggie mac cups", supportingLine: "Prep once on Sunday, eat well all week." },
  { resourceId: "b993d258-b4d8-494f-8e5a-874e88d4e675", label: "Muffin", categorySlug: "recipes",
    headline: "Broccoli cheddar egg muffins", supportingLine: "Six muffins, ready for the week ahead." },
  { resourceId: "f2782a2e-6913-4165-b6bc-c439eb174ef3", label: "Pear", categorySlug: "recipes",
    headline: "Spiced pear and quinoa oats", supportingLine: "A warm breakfast worth waking up for." },
  { resourceId: "6513a99a-85b7-434d-aaa1-2777cb44fff3", label: "protein", categorySlug: "recipes",
    headline: "Pizza muffin bites", supportingLine: "Vegetables, egg and cheese in one bite." },
  { resourceId: "af09fe12-078a-4e45-b435-0cdc545793b2", label: "Recipe (berry smoothie)", categorySlug: "recipes",
    headline: "Berry brain boost smoothie", supportingLine: "Berries, yogurt and chia, blended smooth." },
  { resourceId: "ca49f0a7-b984-4452-9ac7-65e0e2942b9d", label: "Recipe (chicken meatballs)", categorySlug: "recipes",
    headline: "Chicken zucchini meatballs", supportingLine: "Soft, mild and easy to pick up." },
  { resourceId: "53693478-efaa-406d-a39b-2e6f2d699af2", label: "Recipe (pizza muffins)", categorySlug: "recipes",
    headline: "Pizza muffin bites", supportingLine: "Twelve mini muffins for the week." },
  { resourceId: "b52c74b1-e239-4b56-801b-56c0de853445", label: "Recipe (beef meatballs)", categorySlug: "recipes",
    headline: "Mini beef meatballs", supportingLine: "Parmesan, parsley and a soft bite." },
  { resourceId: "fc54cbce-2b9f-4f16-9c5d-1ed1bd22a373", label: "Recipe (peach smoothie)", categorySlug: "recipes",
    headline: "Peach almond oat smoothie", supportingLine: "Oats blended in, and no one notices." },
  { resourceId: "1ea43def-f312-4d91-ae4f-b87802d006e9", label: "Recipe (spinach muffins)", categorySlug: "recipes",
    headline: "Spinach cheese egg muffins", supportingLine: "Twelve muffins, greens included." },
  { resourceId: "42d449b4-aad3-4b14-9570-397edcd2eea3", label: "WAFFLE", categorySlug: "recipes",
    headline: "Banana oat waffles", supportingLine: "Banana, egg and oat flour. That is it." },
];

const CLOSING_LINE = "Made with care by TinySoho.";

/**
 * A stable cover-version id per resource, so a re-run replays through
 * `createOrLoadDraft` instead of creating a second draft. Derived rather than random
 * because the whole point is that running this twice is a no-op.
 */
function coverVersionIdFor(resourceId: string): string {
  const hex = createHash("sha256")
    .update(`tinysoho:guide-cover:v1:${resourceId}`)
    .digest("hex");
  const bytes = Buffer.from(hex.slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const s = bytes.toString("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function altTextFor(plan: CoverPlan): string {
  return `TinySoho guide cover. Headline: ${plan.headline}. ${plan.supportingLine}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const phase = args.includes("--attach-only")
    ? "attach"
    : args.includes("--publish-only")
      ? "publish"
      : "both";

  const prisma = new PrismaClient();
  const repository = createGuideCoverRepository({ database: prisma });
  const publishService = createGuideCoverPublishService({ database: prisma });

  const categories = await prisma.presentationCategory.findMany();
  const categoryBySlug = new Map(categories.map((c) => [c.slug, c]));

  let failures = 0;

  const includeRecipes = args.includes("--include-recipes");
  const plans = includeRecipes ? [...PLAN, ...RECIPE_PLAN] : PLAN;

  for (const plan of plans) {
    const category = categoryBySlug.get(plan.categorySlug);
    if (!category) {
      console.log(`FAIL ${plan.label}: category ${plan.categorySlug} missing`);
      failures += 1;
      continue;
    }

    // Validate the copy against the REAL font metrics before touching anything. This is
    // what catches a headline that overflows two lines, which no length check can: the
    // limit is measured width in the actual typeface, not code points.
    const renderInput: GuideCoverRenderInput = {
      categorySlug: category.slug as GuideCoverRenderInput["categorySlug"],
      editionNumber: 1,
      kicker: category.defaultKicker,
      collectionLabel: category.collectionLabel,
      templateKey: category.templateKey as GuideCoverRenderInput["templateKey"],
      paletteKey: category.paletteKey as GuideCoverRenderInput["paletteKey"],
      illustrationKey:
        category.illustrationKey as GuideCoverRenderInput["illustrationKey"],
      headline: plan.headline,
      supportingLine: plan.supportingLine,
      closingLine: CLOSING_LINE,
      alternativeDescription: altTextFor(plan),
    };
    for (const rendition of ["dm_cover", "square_card"] as const) {
      const probe = await renderGuideCoverPng(renderInput, rendition);
      if (!probe.ok) {
        console.log(
          `FAIL ${plan.label} [${rendition}]: ${probe.error.code}${
            "field" in probe.error && probe.error.field ? ` (${probe.error.field})` : ""
          }`,
        );
        failures += 1;
      }
    }
    if (failures > 0 && !apply) continue;

    if (!apply) {
      console.log(`OK   ${plan.label} → ${plan.categorySlug} | "${plan.headline}"`);
      continue;
    }

    // Already published? Skip straight to attach.
    //
    // `createOrLoadDraft` replays only an unpublished draft: once a cover is published it
    // carries a status and an edition number, so it no longer matches a fresh draft and the
    // repository correctly reports cover_create_conflict. Without this guard a second run
    // reports 19 failures on work that in fact succeeded — alarming, and it hides any real
    // failure in the noise. Nothing is mutated by that conflict, but a script whose rerun
    // looks like a disaster is a script nobody dares rerun.
    const alreadyPublished = await prisma.resourceCoverVersion.findFirst({
      where: { resourceId: plan.resourceId, status: "published" },
      select: { id: true, editionNumber: true },
    });

    if ((phase === "both" || phase === "publish") && alreadyPublished) {
      console.log(
        `SKIP ${plan.label}: already published as edition ${alreadyPublished.editionNumber}`,
      );
    } else if (phase === "both" || phase === "publish") {
      const presentation = await repository.createOrLoadPresentation({
        resourceId: plan.resourceId,
        categoryId: category.id,
      });
      if (!presentation.ok) {
        console.log(`FAIL ${plan.label}: presentation ${presentation.error}`);
        failures += 1;
        continue;
      }

      const coverVersionId = coverVersionIdFor(plan.resourceId);
      const draft = await repository.createOrLoadDraft({
        id: coverVersionId,
        resourceId: plan.resourceId,
        categoryId: category.id,
        templateKey: category.templateKey,
        paletteKey: category.paletteKey,
        illustrationKey: category.illustrationKey,
        suggestionId: null,
        copy: {
          kicker: category.defaultKicker,
          collectionLabel: category.collectionLabel,
          headline: plan.headline,
          supportingLine: plan.supportingLine,
          closingLine: CLOSING_LINE,
          alternativeDescription: altTextFor(plan),
        },
      });
      if (!draft.ok) {
        console.log(`FAIL ${plan.label}: draft ${draft.error}`);
        failures += 1;
        continue;
      }

      const mutation = {
        actorId: ACTOR,
        coverVersionId,
        expectedRevision: draft.value.revision,
        resourceId: plan.resourceId,
      };
      const approved = await publishService.approve(mutation);
      if (!approved.ok) {
        console.log(`FAIL ${plan.label}: approve ${approved.error}`);
        failures += 1;
        continue;
      }
      const published = await publishService.publish(mutation);
      if (!published.ok) {
        console.log(`FAIL ${plan.label}: publish ${published.error}`);
        failures += 1;
        continue;
      }
      console.log(
        `PUB  ${plan.label} → ${plan.categorySlug} edition ${published.editionNumber} ${published.outcome}`,
      );
    }

    if ((phase === "both" || phase === "attach") && plan.holdAttach) {
      console.log(`HELD ${plan.label}: published, not attached`);
    } else if (phase === "both" || phase === "attach") {
      const cover = await prisma.resourceCoverVersion.findFirst({
        where: { resourceId: plan.resourceId, status: "published" },
      });
      if (!cover?.dmStoragePath) {
        console.log(`FAIL ${plan.label}: no published cover to attach`);
        failures += 1;
        continue;
      }
      // The app's own helper, so the attached URL is byte-identical to the one the
      // publish pipeline returned rather than a second reconstruction of it.
      const url = guideCoverPublicUrl(cover.dmStoragePath);

      // Idempotent on (resource_id, order): a re-run updates the same slot rather than
      // colliding with the unique index or adding a second cover.
      const existing = await prisma.resourceMessage.findFirst({
        where: { resourceId: plan.resourceId, order: -1 },
      });
      if (existing) {
        await prisma.resourceMessage.update({
          where: { id: existing.id },
          data: { type: "image", mediaUrl: url, altText: altTextFor(plan), body: null },
        });
        console.log(`ATT  ${plan.label}: updated existing cover slot`);
      } else {
        await prisma.resourceMessage.create({
          data: {
            id: randomUUID(),
            resourceId: plan.resourceId,
            order: -1,
            type: "image",
            mediaUrl: url,
            altText: altTextFor(plan),
            body: null,
          },
        });
        console.log(`ATT  ${plan.label}: cover attached at order -1`);
      }
    }
  }

  await prisma.$disconnect();
  console.log(
    `\n${apply ? "APPLIED" : "DRY RUN"} — ${plans.length} guides, ${failures} failure(s)`,
  );
  if (failures > 0) process.exitCode = 1;
}

await main();
