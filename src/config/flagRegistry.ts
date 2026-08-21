/**
 * What every switch in this system does, in words a person can act on.
 *
 * This lives in code rather than in the database on purpose. A description in a
 * table can be added later, or never; a description here is reviewed in the same
 * commit as the flag it explains, and `flagRegistry.test.ts` fails the build when
 * a flag is added to `env.ts` without one.
 *
 * The database stores only VALUES (`flag_override`). Everything in this file is a
 * fact about the code, so it belongs with the code.
 *
 * Three questions per flag, always the same three. The third — what changes if it
 * is off — is the one an operator actually needs and the one nobody thinks to
 * write down.
 */

export type FlagGroup = "outbound" | "experiment" | "assistive" | "infrastructure";
export type FlagKind = "boolean" | "percent";

export interface FlagDefinition {
  /** Exactly the environment variable name. */
  key: string;
  name: string;
  group: FlagGroup;
  kind: FlagKind;
  /** One or two sentences. No jargon, no field names. */
  doesWhat: string;
  affectsWho: string;
  ifOff: string;
  /**
   * May the console switch this ON, or raise it?
   *
   * False wherever turning it on begins contacting real people, and false for a
   * safety threshold where "up" means tolerating more failures. Checked in the
   * route AND in the resolver, so a row that arrived some other way still cannot
   * enable anything.
   */
  pageMayEnable: boolean;
  /**
   * May the console switch this OFF?
   *
   * True only where the flag is read per operation, so the stop actually takes
   * effect. A stop button that appears to work is worse than none.
   */
  pageMayStop: boolean;
  /**
   * The experiment this flag is part of, if any.
   *
   * Recovery V1 and V2 are sequential experiments over one pipeline. Their shared
   * live controls are assigned to the experiment currently running by
   * experimentLifecycle; V1-only historical settings remain attached to V1.
   *
   * Absent is the honest answer for a flag where a comparison is merely
   * *conceivable* but has never been declared. `experimentRegistry.ts` explains why
   * that distinction is worth holding.
   */
  experimentKey?: string;
}

export const FLAG_REGISTRY: readonly FlagDefinition[] = [
  // ── Outbound: these reach real people ────────────────────────────────────
  {
    key: "DM_RECOVERY_ENABLED",
    name: "Recovery reminders",
    group: "outbound",
    kind: "boolean",
    doesWhat:
      "When someone asks for a guide but never opens our message, leaves a public comment on the reel telling them to check their message requests.",
    affectsWho:
      "People who commented a keyword and were sent a guide, but have not opened it. Around 190 a week.",
    ifOff:
      "No public reminders are posted. People who miss the message simply never get the guide.",
    pageMayEnable: false,
    pageMayStop: true,
    experimentKey: "recovery-reminder-timing-v2",
  },
  {
    key: "GUIDE_DELIVERY_ENABLED",
    name: "Guide delivery",
    group: "outbound",
    kind: "boolean",
    doesWhat: "Sends the guide itself, step by step, once someone has followed and replied.",
    affectsWho: "Everyone who completes the unlock steps.",
    ifOff:
      "New guides stop being sent through this path, and anything already queued stops on the next check.",
    pageMayEnable: false,
    pageMayStop: true,
    experimentKey: "guide-delivery-rollout",
  },
  {
    key: "GUIDE_DELIVERY_ROLLOUT_PERCENT",
    // Not "Guide delivery rollout" — that is the name of the experiment this
    // belongs to, and the switch row then read "Guide delivery rollout · part of
    // Guide delivery rollout". This switch is the dial; the experiment is the
    // comparison the dial starts.
    name: "Share on the new path",
    group: "outbound",
    kind: "percent",
    doesWhat:
      "How many people are served by the newer delivery path rather than the older one.",
    affectsWho: "New guide requests only. Deliveries already under way are unaffected.",
    ifOff: "At zero, everyone is served by the older path.",
    pageMayEnable: true,
    pageMayStop: true,
    experimentKey: "guide-delivery-rollout",
  },
  {
    key: "AI_SEND_ENABLED",
    name: "AI sending",
    group: "outbound",
    kind: "boolean",
    doesWhat: "Lets an approved reply written by the assistant actually be sent to the person.",
    affectsWho: "Anyone in a conversation where you approve a written reply.",
    ifOff: "Approving a reply is refused. Drafts can still be written and read.",
    pageMayEnable: false,
    pageMayStop: true,
  },
  {
    key: "UPCOMING_AUTOMATIONS_ENABLED",
    name: "Set up in advance",
    group: "outbound",
    kind: "boolean",
    doesWhat:
      "Attaches a keyword to a post Instagram has not published yet, by watching for a post whose caption contains that word.",
    affectsWho: "Posts you schedule inside Instagram. Nothing happens until one publishes.",
    ifOff:
      "Prepared setups stop attaching themselves, and a word one of them reserved gets no reply at all — not even from an older post.",
    pageMayEnable: true,
    pageMayStop: true,
  },
  {
    key: "DM_RECOVERY_HISTORICAL_ENABLED",
    name: "Historical recovery campaigns",
    group: "outbound",
    kind: "boolean",
    doesWhat:
      "Runs an approved campaign that reaches back to people from before reminders existed and posts the same public comment.",
    affectsWho:
      "Only people inside a campaign you have approved. With no approved campaign, nothing happens.",
    ifOff: "Approved campaigns stop sending. Nothing already sent is affected.",
    pageMayEnable: true,
    pageMayStop: true,
  },
  {
    key: "DM_RECOVERY_FAILURE_RATE_PERCENT",
    name: "Stop-sending threshold",
    group: "outbound",
    kind: "percent",
    doesWhat:
      "How badly recent reminders must be failing before the system stops sending them by itself. At fifty, it stops once half of a recent sample failed.",
    affectsWho: "All reminder sending, once the threshold is crossed.",
    ifOff:
      "There is no off. Lowering it makes the system give up sooner; raising it makes it keep trying through more failures.",
    // Deliberately display-only. A slider here could RAISE the tolerance for
    // failure, which would make the system louder rather than quieter — the one
    // direction this console is not allowed to move anything.
    pageMayEnable: false,
    pageMayStop: false,
    experimentKey: "recovery-reminder-timing-v2",
  },

  // ── Experiments: measuring something ─────────────────────────────────────
  {
    key: "GATE_DM_EXPERIMENT",
    // Not "Cold message test" — that is the experiment. This is the switch that
    // starts it.
    name: "Try a cold message",
    group: "experiment",
    kind: "boolean",
    doesWhat:
      "Tries an ordinary message to people whose unlock message already failed every attempt, to find out whether a cold message is ever accepted.",
    affectsWho: "Only people whose unlock message already ran out of retries. Nobody new.",
    ifOff: "Those conversations are left alone.",
    pageMayEnable: true,
    pageMayStop: true,
    experimentKey: "cold-message-test",
  },
  {
    key: "DM_RECOVERY_HOLDOUT_PERCENT",
    name: "Legacy reminder holdout",
    group: "experiment",
    kind: "percent",
    doesWhat:
      "Set the no-reminder share in the original 10-hour experiment. The 2 vs 6 hour experiment uses its fixed 45/45/10 assignment instead.",
    affectsWho: "Only assignments made by the original 10-hour experiment.",
    ifOff:
      "At zero, everyone eligible gets a reminder and there is no way left to prove the reminder is what worked.",
    pageMayEnable: false,
    pageMayStop: false,
    experimentKey: "recovery-reminder-timing",
  },
  {
    key: "DM_RECOVERY_POST_EXPERIMENT_ENABLED",
    name: "Legacy post-test reminders",
    group: "experiment",
    kind: "boolean",
    doesWhat:
      "Controlled what the original 10-hour experiment did after its window closed. V2 always stops new assignments at its end.",
    affectsWho: "Only the original 10-hour experiment's post-window behavior.",
    ifOff:
      "Once the window closes, reminders stop and wait for a decision. Nothing announces it, which is why this one is worth watching.",
    pageMayEnable: false,
    pageMayStop: false,
    experimentKey: "recovery-reminder-timing",
  },
  {
    key: "DM_RECOVERY_WESTERN_ONLY",
    name: "Western audience only",
    group: "experiment",
    kind: "boolean",
    doesWhat:
      "Withholds the public reminder when someone looks likely to be outside the audience this account sells to.",
    affectsWho:
      "People whose name suggests an origin outside that audience. It withheld 265 reminders in the last eleven days.",
    ifOff: "Reminders are posted regardless of where the person appears to be from.",
    pageMayEnable: true,
    pageMayStop: true,
    experimentKey: "recovery-reminder-timing-v2",
  },
  {
    key: "DM_RECOVERY_ORIGIN_LLM_ENABLED",
    name: "Better origin guess",
    group: "experiment",
    kind: "boolean",
    doesWhat:
      "Improves the guess about where someone is from by asking a model, instead of matching name fragments against a list.",
    affectsWho:
      "The guess stored against each person. Measured on fifty real cases: the list caught three, the model caught twenty-two, with no false positives.",
    ifOff: "The name-fragment list is used instead, and catches far fewer.",
    pageMayEnable: true,
    pageMayStop: true,
  },

  // ── Assistive: nothing leaves the app ────────────────────────────────────
  {
    key: "AI_DRAFTS_ENABLED",
    name: "Reply drafts",
    group: "assistive",
    kind: "boolean",
    doesWhat:
      "Writes a suggested reply for each conversation waiting on you, so you can send it with one tap instead of typing from scratch.",
    affectsWho: "Only you. A draft sits in Conversations until you approve it.",
    ifOff: "Suggestions stop appearing. You can still reply by hand.",
    pageMayEnable: true,
    pageMayStop: true,
  },
  {
    key: "AI_FOLLOW_UPS_ENABLED",
    name: "Follow-up drafts",
    group: "assistive",
    kind: "boolean",
    doesWhat:
      "Drafts a nudge for conversations that went quiet after the guide was sent. Sending one still needs assistant sending switched on separately.",
    affectsWho: "Only you, until you approve one.",
    ifOff: "No follow-up drafts are written. Nothing already scheduled is sent.",
    pageMayEnable: true,
    pageMayStop: true,
  },
  {
    key: "AI_ADVISOR_ENABLED",
    name: "Assistant",
    group: "assistive",
    kind: "boolean",
    doesWhat: "Lets you ask questions about your own numbers and get an answer in words.",
    affectsWho: "Only you. It reads your own figures and sends nothing to anyone.",
    ifOff: "The Assistant page stops answering. Every other number still works.",
    pageMayEnable: true,
    pageMayStop: true,
  },

  // ── Infrastructure: not a product choice ─────────────────────────────────
  {
    key: "WORKERS_ENABLED",
    name: "Background jobs",
    group: "infrastructure",
    kind: "boolean",
    doesWhat:
      "Runs everything that happens without you: sending queued messages, refreshing the Instagram connection, taking daily follower readings.",
    affectsWho:
      "All automation. The console still works with this off; the system just does nothing on its own.",
    ifOff:
      "Nothing is sent, no readings are taken, and the Instagram connection stops renewing itself.",
    // Read once when the server starts, to decide whether to start anything at
    // all. A change here could not take effect without a restart, so offering
    // either control would be a lie.
    pageMayEnable: false,
    pageMayStop: false,
  },
] as const;

const BY_KEY = new Map(FLAG_REGISTRY.map((definition) => [definition.key, definition]));

export function flagDefinition(key: string): FlagDefinition | undefined {
  return BY_KEY.get(key);
}
