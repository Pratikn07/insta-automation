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
import { createGuideCoverRepository } from "../src/services/guideCoverRepository.js";
import { createGuideCoverPublishService } from "../src/services/guideCoverPublishService.js";
import { renderGuideCoverPng } from "../src/services/guideCoverPngRenderer.js";
import { publicMediaUrl } from "../src/lib/supabase.js";
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

  for (const plan of PLAN) {
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
      const url = publicMediaUrl(cover.dmStoragePath);

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
    `\n${apply ? "APPLIED" : "DRY RUN"} — ${PLAN.length} guides, ${failures} failure(s)`,
  );
  if (failures > 0) process.exitCode = 1;
}

await main();
