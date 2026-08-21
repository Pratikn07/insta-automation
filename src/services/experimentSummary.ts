import type { Prisma } from "@prisma/client";
import { experimentDefinition } from "../config/experimentRegistry.js";
import { env } from "../config/env.js";
import { RECOVERY_TIMING_V2_CUTOVER_AT } from "../config/recoveryTimingSchedule.js";
import { prisma } from "../lib/prisma.js";
import { DM_RECOVERY_TIMING_EXPERIMENT_VERSION } from "./dmRecoveryTimingExperiment.js";
import { configuredExperimentState } from "./experimentLifecycle.js";
import { flags } from "./flagService.js";

/**
 * What each experiment actually measured.
 *
 * One function per experiment, registered by key. NOT a generic metrics layer:
 * recovery counts arms out of dm_recovery_reminder and a rollout would compare two
 * delivery paths. A single abstraction over three different shapes would be
 * structure we invented rather than structure the data has.
 *
 * Counts only, never rates. 594 sends cannot support a percentage — see
 * docs/funnels.md, which refuses to print one its sample does not justify.
 *
 * Every person lands in exactly one bucket. `experimentSummary.test.ts` asserts the
 * books close, because the obvious implementation — treatment is `sent`, skipped is
 * `suppressed` — silently drops 71 real people and still looks complete.
 */

export type ArmCount = { key: string; label: string; people: number };
export type NotCounted = { reason: string; people: number };

export type ExperimentSummary =
  | { kind: "not_started"; wouldCompare: string; blocker: string }
  | {
      kind: "ended";
      arms: ArmCount[];
      notCounted: NotCounted[];
      endedAt: string;
      conclusion: string;
    }
  | {
      kind: "running";
      arms: ArmCount[];
      notCounted: NotCounted[];
      endsAt: string | null;
      whenItEnds: string;
    };

/** Suppression reasons in the owner's words. */
const SKIP_LABELS: Record<string, string> = {
  seen: "They opened it themselves",
  inbound_reply: "They replied, so they saw it",
  audience_out_of_market: "Outside your audience",
  person_cooldown: "Reminded too recently",
  attachment: "They sent something back",
  reaction: "They reacted to it",
};

/**
 * Every other way a treatment row can fail to be a reminder.
 *
 * These are people the experiment assigned to treatment and then did not remind —
 * still waiting, failed, unconfirmed, cancelled. They are not treatment (nothing was
 * posted) and not control (nothing was withheld on purpose), so they need names of
 * their own. Covers `DmRecoveryStatus` exhaustively apart from `sent`, `control` and
 * `suppressed`, which are handled above.
 */
const STATUS_LABELS: Record<string, string> = {
  waiting: "Waiting to be posted",
  sending: "Being posted now",
  send_failed: "The reminder could not be posted",
  send_uncertain: "We could not confirm it posted",
  tracking_unavailable: "We could not track it",
  cancelled: "Cancelled before posting",
};

type ReminderGroup = {
  cohort: string;
  status: string;
  suppressionReason: string | null;
  _count: number;
};

type TimingAssignment = {
  igUserId: string;
  timingArm: string | null;
};

export function legacyRecoverySummaryWhere(
  acceptedBefore: Date,
): Prisma.DmRecoveryReminderWhereInput {
  return {
    triggerKind: "no_confirmed_read",
    experimentVersionSnapshot: null,
    OR: [
      { acceptedAt: { lt: acceptedBefore } },
      // Tracking-unavailable exclusions are never accepted into the experiment;
      // for those rows, eligibleAt is the stable observation boundary.
      { acceptedAt: null, eligibleAt: { lt: acceptedBefore } },
    ],
  };
}

export type SummarizerDeps = {
  groupRecoveryReminders: (acceptedBefore: Date) => Promise<ReminderGroup[]>;
  listTimingAssignments: () => Promise<TimingAssignment[]>;
  experimentState: (key: string) => "running" | "not_started" | "ended";
  legacyExperimentEndedAt: () => string;
  experimentEndsAt: () => string | null;
  postExperimentEnabled: () => boolean;
};

export function createExperimentSummarizer(deps: SummarizerDeps) {
  async function legacyRecoveryReminderTiming(): Promise<ExperimentSummary> {
    const rows = await deps.groupRecoveryReminders(new Date(RECOVERY_TIMING_V2_CUTOVER_AT));

    let treatment = 0;
    let control = 0;
    const skipped = new Map<string, number>();

    for (const row of rows) {
      // Control is decided at creation and is terminal, so every control row is a
      // control person regardless of what its own reason column says. Its
      // `completed` reason means they got the guide anyway — that is the outcome we
      // are measuring, not a reason they were left out.
      if (row.cohort === "control") {
        control += row._count;
        continue;
      }
      if (row.cohort === "treatment" && row.status === "sent") {
        treatment += row._count;
        continue;
      }

      // Anything else was assigned but never reminded. Name it by its suppression
      // reason where there is one, otherwise by its status. The raw value is the
      // last resort so an unmapped one is visible rather than absent.
      const label =
        (row.status === "suppressed" && row.suppressionReason
          ? SKIP_LABELS[row.suppressionReason]
          : STATUS_LABELS[row.status]) ??
        row.suppressionReason ??
        row.status;
      skipped.set(label, (skipped.get(label) ?? 0) + row._count);
    }

    const arms = [
      { key: "treatment", label: "10 hours", people: treatment },
      { key: "control", label: "No reminder", people: control },
    ];
    const notCounted = [...skipped.entries()]
      .map(([reason, people]) => ({ reason, people }))
      .sort((a, b) => b.people - a.people);

    if (deps.experimentState("recovery-reminder-timing") === "running") {
      return {
        kind: "running",
        arms,
        notCounted,
        endsAt: deps.legacyExperimentEndedAt(),
        whenItEnds:
          "At cutover, new requests move to the 2 vs 6 hour test. Existing V1 assignments keep their original timing.",
      };
    }

    return {
      kind: "ended",
      arms,
      notCounted,
      endedAt: deps.legacyExperimentEndedAt(),
      conclusion: "This experiment concluded and was replaced by the 2 vs 6 hour test.",
    };
  }

  async function recoveryReminderTimingV2(): Promise<ExperimentSummary> {
    const rows = await deps.listTimingAssignments();
    const assignmentByPerson = new Map<string, string>();
    for (const row of rows) {
      if (
        !assignmentByPerson.has(row.igUserId) &&
        (row.timingArm === "two_hour" ||
          row.timingArm === "six_hour" ||
          row.timingArm === "no_reminder")
      ) {
        assignmentByPerson.set(row.igUserId, row.timingArm);
      }
    }

    const count = (arm: string) =>
      [...assignmentByPerson.values()].filter((assigned) => assigned === arm).length;

    return {
      kind: "running",
      arms: [
        { key: "two_hour", label: "2 hours", people: count("two_hour") },
        { key: "six_hour", label: "6 hours", people: count("six_hour") },
        { key: "no_reminder", label: "No reminder", people: count("no_reminder") },
      ],
      notCounted: [],
      endsAt: deps.experimentEndsAt(),
      whenItEnds:
        "When the window closes, reminders stop and wait for your decision. Nothing announces it.",
    };
  }

  const MEASURED: Record<string, () => Promise<ExperimentSummary>> = {
    "recovery-reminder-timing": legacyRecoveryReminderTiming,
    "recovery-reminder-timing-v2": recoveryReminderTimingV2,
  };

  return {
    deps,
    async summarize(key: string): Promise<ExperimentSummary> {
      const definition = experimentDefinition(key);
      if (!definition) throw new Error(`Unknown experiment: ${key}`);

      // Nothing to query, and no zeroes to print. A row of zeroes reads as
      // failure; "never switched on" reads as a decision.
      if (deps.experimentState(key) === "not_started") {
        return {
          kind: "not_started",
          wouldCompare: definition.arms.map((a) => a.doesWhat).join(" versus "),
          blocker: definition.blocker,
        };
      }

      const summarize = MEASURED[key];
      if (!summarize) throw new Error(`No summary registered for measured ${key}`);
      return summarize();
    },
  };
}

export const experimentSummarizer = createExperimentSummarizer({
  groupRecoveryReminders: async (acceptedBefore) => {
    const rows = await prisma.dmRecoveryReminder.groupBy({
      by: ["cohort", "status", "suppressionReason"],
      where: legacyRecoverySummaryWhere(acceptedBefore),
      _count: { _all: true },
    });
    return rows.map((r) => ({
      cohort: r.cohort,
      status: r.status,
      suppressionReason: r.suppressionReason,
      _count: r._count._all,
    }));
  },
  listTimingAssignments: async () =>
    prisma.dmRecoveryReminder.findMany({
      where: {
        triggerKind: "no_confirmed_read",
        experimentVersionSnapshot: DM_RECOVERY_TIMING_EXPERIMENT_VERSION,
        timingArm: { not: null },
      },
      select: { igUserId: true, timingArm: true },
      orderBy: [{ acceptedAt: "asc" }, { id: "asc" }],
    }),
  experimentState: (key) => {
    const definition = experimentDefinition(key);
    return configuredExperimentState(key, definition?.state ?? "not_started");
  },
  legacyExperimentEndedAt: () => RECOVERY_TIMING_V2_CUTOVER_AT,
  experimentEndsAt: () => env.DM_RECOVERY_EXPERIMENT_END_AT ?? null,
  postExperimentEnabled: () => flags.bool("DM_RECOVERY_POST_EXPERIMENT_ENABLED"),
});

export const summarizeExperiment = (key: string) => experimentSummarizer.summarize(key);
