/**
 * The experiments, and what makes something one.
 *
 * An experiment is a flag with DECLARED ARMS — named, split stated, outcome chosen.
 * No arms means it is a switch. That line is checkable rather than debatable, which
 * matters: the older Insights → Experiments tab defined it by feeling and now holds
 * 94 rows nobody can close.
 *
 * Lifecycle states are shown in separate Active, Planned, and Concluded tabs. A
 * planned experiment carries a `blocker` instead of zeroes — zeroes read as failure,
 * while a schedule or unmet prerequisite explains why no comparison exists yet.
 */

export type ExperimentState = "running" | "not_started" | "ended";

export interface ExperimentArm {
  key: string;
  /** Share of eligible people, 0-100. Null when the split is not fixed in code. */
  percent: number | null;
  doesWhat: string;
  isControl: boolean;
}

export interface ExperimentDefinition {
  key: string;
  name: string;
  state: ExperimentState;
  doesWhat: string;
  affectsWho: string;
  /** What decides the winner, in plain words. */
  outcome: string;
  arms: ExperimentArm[];
  /** Flags that belong to this experiment. Each appears under exactly one. */
  ownedFlagKeys: string[];
  /** Schedule or reason it is not running; may be retained for dynamic lifecycle UI. */
  blocker: string;
}

export const EXPERIMENT_REGISTRY: readonly ExperimentDefinition[] = [
  {
    key: "recovery-reminder-timing",
    name: "Recovery reminder — 10 hours vs none",
    state: "ended",
    doesWhat:
      "Tested whether leaving a public comment ten hours after a guide request helped, by reminding most people and deliberately saying nothing to the rest.",
    affectsWho:
      "People who commented a keyword, were sent a guide, and had not opened it ten hours later.",
    outcome: "Whether they received the guide within 48 hours of first asking.",
    arms: [
      {
        key: "treatment",
        percent: 90,
        doesWhat: "Got a public comment after ten hours telling them to check their requests.",
        isControl: false,
      },
      {
        key: "control",
        percent: 10,
        doesWhat: "Got no reminder, so the reminder's effect could be measured.",
        isControl: true,
      },
    ],
    ownedFlagKeys: ["DM_RECOVERY_HOLDOUT_PERCENT", "DM_RECOVERY_POST_EXPERIMENT_ENABLED"],
    blocker: "This experiment concluded when the 2 vs 6 hour timing test began.",
  },
  {
    key: "recovery-reminder-timing-v2",
    name: "Recovery reminder — 2 vs 6 hours",
    state: "running",
    doesWhat:
      "Compares an earlier public reminder with a later one, while leaving a small holdout without a reminder to show whether either reminder helps at all.",
    affectsWho:
      "People who commented a keyword and were sent a guide but have not opened it. Around 190 a week.",
    outcome: "Whether they received the guide within 48 hours of first asking.",
    arms: [
      {
        key: "two_hour",
        percent: 45,
        doesWhat: "Gets a public reminder two hours after asking for the guide.",
        isControl: false,
      },
      {
        key: "six_hour",
        percent: 45,
        doesWhat: "Gets a public reminder six hours after asking for the guide.",
        isControl: false,
      },
      {
        key: "no_reminder",
        percent: 10,
        doesWhat: "Gets no reminder, so we can tell whether either timing helps.",
        isControl: true,
      },
    ],
    ownedFlagKeys: [
      "DM_RECOVERY_ENABLED",
      "DM_RECOVERY_WESTERN_ONLY",
      "DM_RECOVERY_FAILURE_RATE_PERCENT",
    ],
    blocker: "Scheduled for 21 Aug 2026 at 5:00 AM Pacific.",
  },
  {
    key: "guide-delivery-rollout",
    name: "Guide delivery rollout",
    state: "not_started",
    doesWhat:
      "Would compare the newer way of sending a guide against the older one, by serving a share of people through each.",
    affectsWho: "New guide requests. Deliveries already under way would be untouched.",
    outcome: "Whether the guide arrived complete, and whether anything needed review.",
    arms: [
      {
        key: "new_path",
        percent: null,
        doesWhat: "Served by the newer delivery path, which tracks each step separately.",
        isControl: false,
      },
      {
        key: "old_path",
        percent: null,
        doesWhat: "Served by the older path, which is what everyone gets today.",
        isControl: true,
      },
    ],
    ownedFlagKeys: ["GUIDE_DELIVERY_ENABLED", "GUIDE_DELIVERY_ROLLOUT_PERCENT"],
    blocker:
      "The rollout is at zero, so nobody is on the newer path yet. Raising it starts the comparison.",
  },
  {
    key: "cold-message-test",
    name: "Cold message test",
    state: "not_started",
    doesWhat:
      "Would find out whether an ordinary message is ever accepted by someone whose unlock message already failed every attempt.",
    affectsWho:
      "Only people whose unlock message ran out of retries. Nobody new would be contacted.",
    outcome: "Whether the message was accepted at all.",
    arms: [
      {
        key: "cold_dm",
        percent: null,
        doesWhat: "Gets one ordinary message after the unlock message gave up.",
        isControl: false,
      },
      {
        key: "left_alone",
        percent: null,
        doesWhat: "Gets nothing further, which is what happens today.",
        isControl: true,
      },
    ],
    ownedFlagKeys: ["GATE_DM_EXPERIMENT"],
    blocker: "It has never been switched on, so no message has been tried.",
  },
] as const;

const BY_KEY = new Map(EXPERIMENT_REGISTRY.map((e) => [e.key, e]));

export function experimentDefinition(key: string): ExperimentDefinition | undefined {
  return BY_KEY.get(key);
}

/**
 * The display name for an experiment key, or null.
 *
 * Served alongside every flag so the console never keeps its own key-to-name map.
 * Two copies of that map in the web pages was the first draft; renaming an
 * experiment here would have quietly left the old name on the switch that belongs
 * to it.
 */
export function experimentName(key: string | undefined): string | null {
  return key ? (BY_KEY.get(key)?.name ?? null) : null;
}
