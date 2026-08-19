import { experimentDefinition } from "../config/experimentRegistry.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
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

export type SummarizerDeps = {
  groupRecoveryReminders: () => Promise<ReminderGroup[]>;
  experimentEndsAt: () => string | null;
  postExperimentEnabled: () => boolean;
};

export function createExperimentSummarizer(deps: SummarizerDeps) {
  async function recoveryReminderTiming(): Promise<ExperimentSummary> {
    const rows = await deps.groupRecoveryReminders();

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

    return {
      kind: "running",
      arms: [
        { key: "treatment", label: "Got a reminder", people: treatment },
        { key: "control", label: "Got nothing", people: control },
      ],
      notCounted: [...skipped.entries()]
        .map(([reason, people]) => ({ reason, people }))
        .sort((a, b) => b.people - a.people),
      endsAt: deps.experimentEndsAt(),
      whenItEnds: deps.postExperimentEnabled()
        ? "Reminders keep going after the window closes."
        : "When the window closes, reminders stop and wait for your decision. Nothing announces it.",
    };
  }

  const RUNNING: Record<string, () => Promise<ExperimentSummary>> = {
    "recovery-reminder-timing": recoveryReminderTiming,
  };

  return {
    deps,
    async summarize(key: string): Promise<ExperimentSummary> {
      const definition = experimentDefinition(key);
      if (!definition) throw new Error(`Unknown experiment: ${key}`);

      // Nothing to query, and no zeroes to print. A row of zeroes reads as
      // failure; "never switched on" reads as a decision.
      if (definition.state !== "running") {
        return {
          kind: "not_started",
          wouldCompare: definition.arms.map((a) => a.doesWhat).join(" versus "),
          blocker: definition.blocker,
        };
      }

      const summarize = RUNNING[key];
      if (!summarize) throw new Error(`No summary registered for running ${key}`);
      return summarize();
    },
  };
}

export const experimentSummarizer = createExperimentSummarizer({
  groupRecoveryReminders: async () => {
    const rows = await prisma.dmRecoveryReminder.groupBy({
      by: ["cohort", "status", "suppressionReason"],
      _count: { _all: true },
    });
    return rows.map((r) => ({
      cohort: r.cohort,
      status: r.status,
      suppressionReason: r.suppressionReason,
      _count: r._count._all,
    }));
  },
  experimentEndsAt: () => env.DM_RECOVERY_EXPERIMENT_END_AT ?? null,
  postExperimentEnabled: () => flags.bool("DM_RECOVERY_POST_EXPERIMENT_ENABLED"),
});

export const summarizeExperiment = (key: string) => experimentSummarizer.summarize(key);
