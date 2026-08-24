import { createHash } from "node:crypto";

import { GUIDE_PROFILE_URL } from "../meta/sendGuideAction.js";
import { buildGuideGateCapabilityPayload } from "../meta/guideGatePayloads.js";
import { sendMetaMessage } from "../meta/sendMessage.js";
import { publicMediaUrl } from "../lib/supabase.js";
import { prisma } from "../lib/prisma.js";
import { flags } from "./flagService.js";
import { guideAccessCopy } from "./guideAccessCopy.js";
import type { MetaSendResult } from "../types/meta.js";

/**
 * The V1 follow request, sent as a card.
 *
 * This is the single highest-leverage message in the funnel. In the 7 days to 2026-08-24,
 * 1,751 of 1,770 conversations were gated non-followers and 926 of them never converted — so
 * for more than half the people who ask for a guide, this one message is everything TinySoho
 * ever sends them. It has been plain text.
 *
 * It rides the comment path's private reply, which is where the volume actually is: 1,043
 * gates in 7 days against 6 on the DM path. That surface allows Meta exactly one private
 * reply per comment, so art and copy cannot be two messages — a template card is the only
 * shape that carries both at once.
 *
 * What this deliberately does NOT do is put a postback on the card. See `private_gate_card`
 * in guideGatePayloads: the action token that a postback needs is minted by the V2 access
 * flow, which has never executed, so the button would be tappable and inert. The card links
 * to the profile and its copy still says reply DONE, which is the mechanism V1 already
 * listens for.
 */

const HASH_SPACE_SIZE = 0x1_0000_0000;
const BUCKETS = 10_000;

/**
 * Stable share assignment, keyed on the commenter and the guide.
 *
 * Keyed on both so a rollout share is stable per person per guide rather than per request: a
 * parent who comments the same keyword twice sees the same treatment, and someone who is in
 * the share for one guide is not automatically in it for every guide. Not random, because a
 * coin flip per send would give the same person a card once and text the next time, which
 * reads as a broken account rather than an experiment.
 */
export function guideGateCardBucket(igUserId: string, resourceId: string): number {
  const hash = createHash("sha256").update(`guide-gate-card:v1:${igUserId}:${resourceId}`).digest();
  return Math.floor((hash.readUInt32BE(0) / HASH_SPACE_SIZE) * BUCKETS);
}

/** Whether this specific commenter, for this guide, is in the card share. */
export function guideGateCardSelected(input: {
  igUserId: string;
  resourceId: string;
}): boolean {
  let enabled: boolean;
  let percent: number;
  try {
    enabled = flags.bool("GUIDE_GATE_CARD_ENABLED");
    percent = flags.percent("GUIDE_GATE_CARD_PERCENT");
  } catch {
    // A flag-read problem must never decide to send something new. Fail to the text gate.
    return false;
  }
  if (!enabled || percent <= 0) return false;
  if (!input.igUserId || !input.resourceId) return false;
  return guideGateCardBucket(input.igUserId, input.resourceId) < percent * 100;
}

/**
 * The card's subtitle, which is also what gets recorded as the message's text.
 *
 * Says "reply DONE" because the card's button is a profile link and cannot confirm a follow,
 * so the copy has to carry that instruction. A card-specific string because Meta caps a
 * subtitle at 80 characters and the plain-text gate is 81.
 */
export const GUIDE_GATE_CARD_SUBTITLE = guideAccessCopy.nonFollowerGateCard;

/**
 * Everything the card needs, in one query, or null.
 *
 * Returns the guide name alongside the cover because a keyword row carries only a
 * `resourceId` — fetching the name separately would be a second query per gate for a string
 * this one already has to join to.
 *
 * Square specifically: a template's image slot centre-crops to roughly 1:1, so handing it the
 * 1200x916 dm cover would lose the headline's first word — verified on device. A guide with no
 * square yet simply gets the text gate.
 */
export async function loadGateCard(
  resourceId: string,
): Promise<{ coverUrl: string; guideName: string } | null> {
  try {
    const cover = await prisma.resourceCoverVersion.findFirst({
      where: { resourceId, status: "published", squareStoragePath: { not: null } },
      select: { squareStoragePath: true, resource: { select: { name: true } } },
    });
    if (!cover?.squareStoragePath) return null;
    return {
      coverUrl: publicMediaUrl(cover.squareStoragePath),
      guideName: cover.resource.name,
    };
  } catch {
    return null;
  }
}

/**
 * Sends the card as the private reply. Throws exactly like `sendPrivateReply` does, so the
 * caller's existing failure classification and recovery ladder apply unchanged.
 */
export function sendGuideGateCard(input: {
  commentId: string;
  guideName: string;
  coverUrl: string;
}): Promise<MetaSendResult> {
  const payload = buildGuideGateCapabilityPayload({
    case: "private_gate_card",
    commentId: input.commentId,
    guideName: input.guideName,
    profileUrl: GUIDE_PROFILE_URL,
    coverUrl: input.coverUrl,
    // The card's own subtitle. Uses the TEXT variant on purpose: it is the one that says
    // "reply DONE", which is what this card's button cannot do for them.
    gateText: GUIDE_GATE_CARD_SUBTITLE,
  });
  return sendMetaMessage(payload, {
    commentId: input.commentId,
    mode: "private_gate_card",
    messageLength: GUIDE_GATE_CARD_SUBTITLE.length,
  });
}
