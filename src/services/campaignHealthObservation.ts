import { prisma } from "../lib/prisma.js";

export type CampaignHealthSignal =
  | "complaint"
  | "opt_out"
  | "block"
  | "negative_reply"
  | "classifier_anomaly";

const SIGNALS: ReadonlySet<string> = new Set<CampaignHealthSignal>([
  "complaint",
  "opt_out",
  "block",
  "negative_reply",
  "classifier_anomaly",
]);

const OPT_OUT_MESSAGES = new Set([
  "stop",
  "unsubscribe",
  "unsubscribe please",
  "please unsubscribe",
  "do not contact me",
  "don't contact me",
  "do not message me",
  "don't message me",
  "stop messaging me",
  "remove me",
]);

const NEGATIVE_REPLY_MESSAGES = new Set([
  "leave me alone",
  "please leave me alone",
  "go away",
  "not interested",
]);

function normalizeWholeMessage(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

/** Conservative exact-message classifier. Substrings never count as evidence. */
export function classifyInboundHealthSignal(
  text: string,
): "opt_out" | "negative_reply" | null {
  const normalized = normalizeWholeMessage(text);
  if (OPT_OUT_MESSAGES.has(normalized)) return "opt_out";
  if (NEGATIVE_REPLY_MESSAGES.has(normalized)) return "negative_reply";
  return null;
}

/** Idempotently append one bounded, non-message health observation. */
export async function recordCampaignHealthObservation(input: {
  campaignId: string;
  kind: CampaignHealthSignal;
  sourceKey: string;
  observedAt: Date;
  safeDetail?: string;
}): Promise<{ created: boolean }> {
  const sourceKey = input.sourceKey.trim();
  const safeDetail = input.safeDetail?.trim();
  if (!SIGNALS.has(input.kind)) throw new Error("invalid_campaign_health_kind");
  if (!sourceKey || sourceKey.length > 200) throw new Error("invalid_campaign_health_source_key");
  if (safeDetail !== undefined && (!safeDetail || safeDetail.length > 200)) {
    throw new Error("invalid_campaign_health_safe_detail");
  }
  if (!Number.isFinite(input.observedAt.getTime())) {
    throw new Error("invalid_campaign_health_observed_at");
  }

  const inserted = await prisma.recoveryCampaignHealthObservation.createMany({
    data: [{
      campaignId: input.campaignId,
      kind: input.kind,
      sourceKey,
      observedAt: input.observedAt,
      safeDetail,
    }],
    skipDuplicates: true,
  });
  return { created: inserted.count === 1 };
}

/** Promote a newly persisted inbound provider message to campaign health evidence. */
export async function recordInboundCampaignHealthSignals(input: {
  igUserId: string;
  instagramMessageId: string;
  text: string;
  observedAt: Date;
}): Promise<{ recorded: number }> {
  const kind = classifyInboundHealthSignal(input.text);
  if (!kind) return { recorded: 0 };

  const cutoff = new Date(input.observedAt.getTime() - 30 * 24 * 60 * 60 * 1000);
  const dispatches = await prisma.publicRecoveryDispatch.findMany({
    where: {
      igUserId: input.igUserId,
      sourceKind: "historical",
      campaignId: { not: null },
      state: { in: ["sent", "uncertain"] },
      dispatchStartedAt: { gt: cutoff, lte: input.observedAt },
    },
    select: { campaignId: true },
    distinct: ["campaignId"],
  });

  let recorded = 0;
  for (const dispatch of dispatches) {
    if (!dispatch.campaignId) continue;
    const result = await recordCampaignHealthObservation({
      campaignId: dispatch.campaignId,
      kind,
      sourceKey: `inbound:${input.instagramMessageId}`,
      observedAt: input.observedAt,
    });
    if (result.created) recorded++;
  }
  return { recorded };
}
