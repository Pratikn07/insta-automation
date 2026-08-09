/**
 * Campaign-level stop conditions for historical recovery (QA-13).
 *
 * `evaluateRecoveryHealth` derives every one of its six observations from
 * `dm_recovery_reminder` and never reads `recovery_candidate`. So historical sends could
 * be failing, or producing uncertainty on real people's public comments, while the shared
 * circuit stayed closed because the prospective feature was perfectly healthy.
 *
 * The shared circuit is also the wrong instrument for most of this. It stops ALL public
 * sending, which is right for a broken token — the credentials are shared — but wrong for
 * a campaign whose own copy or cohort is going badly. That should pause the campaign and
 * leave the healthy prospective feature running.
 *
 * Complaint/block/classifier evidence is accepted only from the authenticated admin
 * route. Opt-outs and conservative negative replies are captured from stable inbound
 * message IDs. The observation row never stores the private message text.
 */

import { prisma } from "../lib/prisma.js";
import { logEvent } from "./eventLogger.js";
import { pauseCampaign } from "./recoveryCampaignControl.js";

/** Why a campaign was stopped automatically. Each requires owner review to resume. */
export type CampaignStopReason =
  | "complaint"
  | "opt_out"
  | "block"
  | "classifier_anomaly"
  | "negative_reply"
  /** Meta rejected our public replies. Copy, permissions, or the comments themselves. */
  | "public_failure_rate"
  /** Too many sends whose outcome we cannot establish. Each may be a live comment. */
  | "uncertain_rate"
  /** The cohort has decayed: too many source comments gone or hidden. */
  | "source_unavailable_rate"
  /** Two public replies recorded for one person. The worst possible failure. */
  | "duplicate_public_reply";

/**
 * Thresholds, deliberately conservative.
 *
 * These govern public comments on real people's posts, and the copy has never run at
 * scale. Pausing early costs a review; not pausing costs public mistakes that cannot be
 * recalled.
 *
 * `MIN_SAMPLE` exists because a rate over 2 sends is noise: the first failure of a
 * 3-send stage would otherwise read as a 33% failure rate and stop the campaign before
 * it began.
 */
export const STOP_THRESHOLDS = {
  /** Below this many settled sends, rate-based checks stay silent. */
  minSample: 5,
  /** Percent of settled sends Meta rejected. */
  failurePercent: 20,
  /** Percent whose outcome is unknown. Lower: each one may be a live comment. */
  uncertainPercent: 10,
  /** Percent suppressed because the source comment was gone or hidden. */
  sourceUnavailablePercent: 40,
} as const;

export type CampaignHealth = {
  campaignId: string;
  settled: number;
  sent: number;
  failed: number;
  uncertain: number;
  sourceUnavailable: number;
  duplicatePeople: number;
  complaints: number;
  optOuts: number;
  blocks: number;
  negativeReplies: number;
  classifierAnomalies: number;
  stopReason: CampaignStopReason | null;
};

/**
 * Count what this campaign has actually produced.
 *
 * Scoped to the campaign, not the account: one campaign going wrong must not read as the
 * whole system failing, and vice versa.
 */
async function observe(campaignId: string): Promise<Omit<CampaignHealth, "stopReason">> {
  const [sent, failed, uncertain, sourceUnavailable, duplicates, signals] = await Promise.all([
    prisma.recoveryCandidate.count({ where: { campaignId, outcome: "sent" } }),
    prisma.recoveryCandidate.count({ where: { campaignId, outcome: "send_failed" } }),
    prisma.recoveryCandidate.count({ where: { campaignId, outcome: "send_uncertain" } }),
    prisma.recoveryCandidate.count({
      where: {
        campaignId,
        outcome: "suppressed",
        suppressionReason: { in: ["source_comment_deleted", "source_comment_hidden"] },
      },
    }),
    // The shared dispatch ledger, not candidate shape, owns public contact truth. Two
    // terminal attempts for one person can exist after a retry/interleaving even though
    // candidate selection correctly contains one person once.
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*) AS n FROM (
        SELECT "ig_user_id"
        FROM "public_recovery_dispatch"
        WHERE "campaign_id" = ${campaignId}::uuid
          AND "state" IN ('sent', 'uncertain')
        GROUP BY "ig_user_id"
        HAVING COUNT(*) > 1
      ) d
    `,
    prisma.recoveryCampaignHealthObservation.groupBy({
      by: ["kind"],
      where: { campaignId },
      _count: { _all: true },
    }),
  ]);

  const signalCount = (kind: string) =>
    signals.find((signal) => signal.kind === kind)?._count._all ?? 0;

  return {
    campaignId,
    // Rows that reached a public-send outcome. Suppressed and holdout rows never
    // attempted one, so including them would dilute every rate towards zero.
    settled: sent + failed + uncertain,
    sent,
    failed,
    uncertain,
    sourceUnavailable,
    duplicatePeople: Number(duplicates[0]?.n ?? 0),
    complaints: signalCount("complaint"),
    optOuts: signalCount("opt_out"),
    blocks: signalCount("block"),
    negativeReplies: signalCount("negative_reply"),
    classifierAnomalies: signalCount("classifier_anomaly"),
  };
}

/**
 * Which stop condition, if any, this campaign has tripped.
 *
 * Pure so every branch is testable without a database. Order is by severity: a duplicate
 * public reply is reported ahead of any rate, because it is a visible mistake on
 * someone's post rather than a statistic.
 */
export function chooseStopReason(
  o: Omit<CampaignHealth, "stopReason">,
): CampaignStopReason | null {
  if (o.complaints > 0) return "complaint";
  if (o.optOuts > 0) return "opt_out";
  if (o.blocks > 0) return "block";
  if (o.classifierAnomalies > 0) return "classifier_anomaly";
  if (o.negativeReplies > 0) return "negative_reply";
  if (o.duplicatePeople > 0) return "duplicate_public_reply";

  // Send-outcome rates need a sample of SENDS. Below the minimum a single failure would
  // read as catastrophic and stop a stage-0 campaign on its first hiccup.
  if (o.settled >= STOP_THRESHOLDS.minSample) {
    const pct = (n: number) => (n / o.settled) * 100;
    if (pct(o.failed) >= STOP_THRESHOLDS.failurePercent) return "public_failure_rate";
    if (pct(o.uncertain) >= STOP_THRESHOLDS.uncertainPercent) return "uncertain_rate";
  }

  // Source availability is measured against everything the campaign has TOUCHED, and is
  // checked even when nothing has settled.
  //
  // It has its own sample floor rather than sharing the send floor: a cohort whose
  // comments have ALL been deleted sends nothing at all, so `settled` stays 0 and an
  // early return on the send floor would leave the campaign grinding through
  // suppressions forever without ever reporting why. That was the first version of this
  // function, and its test caught it.
  const touched = o.settled + o.sourceUnavailable;
  if (
    touched >= STOP_THRESHOLDS.minSample &&
    (o.sourceUnavailable / touched) * 100 >= STOP_THRESHOLDS.sourceUnavailablePercent
  ) {
    return "source_unavailable_rate";
  }

  return null;
}

/**
 * Evaluate one campaign and pause it if it has tripped a stop condition.
 *
 * Returns the health reading either way, so a caller can log it without a second query.
 *
 * The pause LATCHES: `pauseReason` is prefixed `auto:` so `resumeCampaign` can refuse to
 * clear it without an explicit owner acknowledgement. An automatic stop that any resume
 * could undo would be a suggestion, not a stop.
 */
export async function evaluateCampaignHealth(campaignId: string, now = new Date()): Promise<CampaignHealth> {
  const observations = await observe(campaignId);
  const stopReason = chooseStopReason(observations);

  if (!stopReason) return { ...observations, stopReason: null };

  const paused = await pauseCampaign(campaignId, `auto:${stopReason}`, now);
  if (paused.ok) {
    await logEvent("historical_campaign_auto_paused", {
      campaignId,
      reason: stopReason,
      settled: observations.settled,
      failed: observations.failed,
      uncertain: observations.uncertain,
      sourceUnavailable: observations.sourceUnavailable,
      duplicatePeople: observations.duplicatePeople,
      complaints: observations.complaints,
      optOuts: observations.optOuts,
      blocks: observations.blocks,
      negativeReplies: observations.negativeReplies,
      classifierAnomalies: observations.classifierAnomalies,
    });
  }

  return { ...observations, stopReason };
}

/** Was this campaign stopped automatically rather than by its owner? */
export function isAutoPause(pauseReason: string | null): boolean {
  return Boolean(pauseReason?.startsWith("auto:"));
}
