import type { PrismaClient } from "@prisma/client";
import {
  GUIDE_AUDIENCE_TIMEOUT_INCIDENT_ENDED_AT,
  GUIDE_AUDIENCE_TIMEOUT_INCIDENT_STARTED_AT,
  type AuthorizedGuideAudienceTimeoutRecoveryPlan,
  type GuideAudienceTimeoutRecoveryPlan,
} from "../src/services/guideAudienceTimeoutRecovery.js";

type JourneyIntentReader = Pick<PrismaClient, "journeyIntent">;

const SAFE_FAILURE_MESSAGES = new Set([
  "preview cohort drift: rerun the read-only preview",
  "approved send cohort drift: rerun classification before sending",
  "recovery cohort drift: rerun classification before sending",
  "disable GUIDE_AUDIENCE_BLOCK_ENABLED before a recovery send",
]);
const SAFE_OPENING_OUTCOMES = new Set([
  "action_expired",
  "access_attempt_needs_review",
  "guide_opening_failed",
  "guide_audience_blocked",
  "guide_audience_deferred",
]);

/**
 * Mirrors resolveJourneyIntent's live-window lookup. A reconciliation row may
 * not yet have a canonical conversation, but it still owns the person/guide
 * window and therefore must suppress a second private gate.
 */
export async function hasOpenGuideAudienceTimeoutRecoveryJourney(
  database: JourneyIntentReader,
  input: { igUserId: string; keywordId: string },
  now: Date,
): Promise<boolean> {
  const current = await database.journeyIntent.findFirst({
    where: {
      igUserId: input.igUserId,
      keywordId: input.keywordId,
      windowExpiresAt: { gt: now },
    },
    select: { id: true },
  });
  return Boolean(current);
}

/** Keep command stderr aggregate-only even when a provider or database throws. */
export function safeGuideAudienceTimeoutRecoveryFailure(error: unknown): string {
  if (!(error instanceof Error)) return "guide audience timeout recovery failed; inspect service logs";
  if (SAFE_FAILURE_MESSAGES.has(error.message)) return error.message;
  if (/^allowlisted candidate count drift: expected \d+, freshly classified \d+$/.test(error.message)) {
    return error.message;
  }
  const opening = /^guide recovery stopped after ([a-z_]+)$/.exec(error.message)?.[1];
  if (opening && SAFE_OPENING_OUTCOMES.has(opening)) return error.message;
  return "guide audience timeout recovery failed; inspect service logs";
}

export type GuideAudienceTimeoutRecoveryMode = "preview" | "classify" | "send";

export type GuideAudienceTimeoutRecoveryCommandOptions = {
  mode: GuideAudienceTimeoutRecoveryMode;
  cohortHash?: string;
  expectedCount?: number;
  actor?: string;
  sendInstagram: boolean;
};

export type GuideAudienceTimeoutRecoveryCommandDependencies = {
  loadPlan(): Promise<GuideAudienceTimeoutRecoveryPlan>;
  authorize(
    plan: GuideAudienceTimeoutRecoveryPlan,
  ): Promise<AuthorizedGuideAudienceTimeoutRecoveryPlan>;
  send(
    plan: AuthorizedGuideAudienceTimeoutRecoveryPlan,
    expectedCohortHash: string,
  ): Promise<{ sent: number; skipped: number }>;
  recordRun(input: {
    actor: string;
    mode: "classify" | "send";
    candidateCount: number;
    cohortHash: string;
    excluded: Record<string, number>;
  }): Promise<void>;
};

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/**
 * The command deliberately has three separate phases:
 *
 * - preview: read-only post/guide matching;
 * - classify: forced, non-contact classification and a new send hash;
 * - send: a second explicit approval for the exact allowlisted cohort.
 */
export function parseGuideAudienceTimeoutRecoveryArgs(
  args: string[],
): GuideAudienceTimeoutRecoveryCommandOptions {
  const options: GuideAudienceTimeoutRecoveryCommandOptions = {
    mode: "preview",
    sendInstagram: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--mode") {
      const value = requireValue(args, index, arg);
      if (value !== "preview" && value !== "classify" && value !== "send") {
        throw new Error(`unsupported guide audience timeout recovery mode: ${value}`);
      }
      options.mode = value;
      index += 1;
    } else if (arg === "--cohort-hash") {
      const value = requireValue(args, index, arg);
      if (!isSha256(value)) throw new Error("--cohort-hash must be a SHA-256 hash");
      options.cohortHash = value;
      index += 1;
    } else if (arg === "--expected-count") {
      const value = requireValue(args, index, arg);
      if (!/^\d+$/.test(value)) {
        throw new Error("--expected-count must be a non-negative integer");
      }
      options.expectedCount = Number(value);
      index += 1;
    } else if (arg === "--actor") {
      const value = requireValue(args, index, arg).trim();
      if (!value) throw new Error("--actor requires a non-empty value");
      options.actor = value;
      index += 1;
    } else if (arg === "--send-instagram") {
      options.sendInstagram = true;
    } else {
      throw new Error(`unsupported guide audience timeout recovery option: ${arg}`);
    }
  }

  if (options.mode === "preview") {
    if (options.cohortHash || options.expectedCount !== undefined || options.actor || options.sendInstagram) {
      throw new Error("preview mode is read-only and accepts no approval options");
    }
  } else {
    if (!options.cohortHash) throw new Error(`${options.mode} requires --cohort-hash from a fresh prior phase`);
    if (!options.actor) throw new Error(`${options.mode} requires --actor`);
  }
  if (options.mode === "send") {
    if (options.expectedCount === undefined) {
      throw new Error("send requires --expected-count from a fresh classification");
    }
    if (!options.sendInstagram) {
      throw new Error("send requires --send-instagram after owner approval");
    }
  } else if (options.expectedCount !== undefined || options.sendInstagram) {
    throw new Error(`${options.mode} does not accept send-only options`);
  }
  return options;
}

function excludedLines(excluded: Record<string, number>): string[] {
  return Object.entries(excluded)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `Excluded/${reason}: ${count}`);
}

function previewReport(plan: GuideAudienceTimeoutRecoveryPlan): string {
  return [
    "Guide audience timeout recovery",
    "Mode: preview",
    `Fixed outage window: ${GUIDE_AUDIENCE_TIMEOUT_INCIDENT_STARTED_AT.toISOString()} to ${GUIDE_AUDIENCE_TIMEOUT_INCIDENT_ENDED_AT.toISOString()}`,
    `Candidates awaiting classification: ${plan.candidates.length}`,
    `Candidate cohort hash: ${plan.cohortHash}`,
    ...excludedLines(plan.excluded),
  ].join("\n");
}

function classifiedReport(
  mode: "classify" | "send",
  plan: AuthorizedGuideAudienceTimeoutRecoveryPlan,
): string {
  return [
    "Guide audience timeout recovery",
    `Mode: ${mode}`,
    `Allowlisted gated DMs: ${plan.candidates.length}`,
    `Approved send cohort hash: ${plan.cohortHash}`,
    ...excludedLines(plan.excluded),
  ].join("\n");
}

export async function executeGuideAudienceTimeoutRecoveryCommand(
  options: GuideAudienceTimeoutRecoveryCommandOptions,
  dependencies: GuideAudienceTimeoutRecoveryCommandDependencies,
): Promise<string> {
  const plan = await dependencies.loadPlan();
  if (options.mode === "preview") return previewReport(plan);

  // Classification approves the output of the read-only matching phase. A send
  // instead carries the later allowlisted hash, so it must be checked only
  // after the fresh forced authorization below.
  if (options.mode === "classify" && options.cohortHash !== plan.cohortHash) {
    throw new Error("preview cohort drift: rerun the read-only preview");
  }

  const authorized = await dependencies.authorize(plan);
  if (options.mode === "classify") {
    await dependencies.recordRun({
      actor: options.actor!,
      mode: "classify",
      candidateCount: authorized.candidates.length,
      cohortHash: authorized.cohortHash,
      excluded: authorized.excluded,
    });
    return classifiedReport("classify", authorized);
  }

  if (options.expectedCount !== authorized.candidates.length) {
    throw new Error(
      `allowlisted candidate count drift: expected ${options.expectedCount}, freshly classified ${authorized.candidates.length}`,
    );
  }
  if (options.cohortHash !== authorized.cohortHash) {
    throw new Error("approved send cohort drift: rerun classification before sending");
  }

  await dependencies.recordRun({
    actor: options.actor!,
    mode: "send",
    candidateCount: authorized.candidates.length,
    cohortHash: authorized.cohortHash,
    excluded: authorized.excluded,
  });
  const result = await dependencies.send(authorized, options.cohortHash);
  return `${classifiedReport("send", authorized)}\nSent: ${result.sent}\nSkipped: ${result.skipped}`;
}
