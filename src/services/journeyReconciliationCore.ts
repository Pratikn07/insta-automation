import { JOURNEY_WINDOW_MS } from "./journeyIntentService.js";

/**
 * The reconciliation decisions, as pure functions over plain data.
 *
 * Separated from the script so the partitioning and precedence rules can be
 * tested without a database. The rules decide which historical journey owns a
 * request and which become aliases, and getting them wrong would silently rewrite
 * the history of ~805 conversations.
 */

export type ReconcileCandidate = {
  id: string;
  createdAt: Date;
  /** `completed` is the strongest ownership signal (design §24). */
  completed: boolean;
  /** Second tier: the journey whose gate DM Meta confirmed accepted. */
  hasSentGate: boolean;
  completedAt: Date | null;
};

/** What reconciliation concluded about one alias. */
export type AliasState = "recovered" | "superseded";

export type ReconciledWindow = {
  /** The journey that owns automation, completion, and recovery for this window. */
  canonicalId: string;
  windowStartedAt: Date;
  lastTriggerAt: Date;
  windowExpiresAt: Date;
  completedAt: Date | null;
  /** Every other journey in the window, with why it is not the owner. */
  aliases: Array<{ id: string; state: AliasState; reason: string }>;
};

/**
 * Split one person's journeys for one keyword into intent windows.
 *
 * A window continues while consecutive journeys are less than 48 hours apart,
 * measured gap-to-gap rather than from the window's start — otherwise a person who
 * asks every day would be collapsed into one endless intent.
 *
 * Input must be sorted oldest-first; the caller does that in SQL.
 */
export function partitionIntoWindows<T extends { id: string; createdAt: Date }>(input: T[]): T[][] {
  const sorted = [...input].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const windows: T[][] = [];
  let current: T[] = [];

  for (const row of sorted) {
    if (current.length === 0) {
      current = [row];
      continue;
    }
    const previous = current[current.length - 1]!;
    const gap = row.createdAt.getTime() - previous.createdAt.getTime();
    // Strict: at exactly 48 hours a new window opens, matching the live resolver's
    // boundary so reconciled history and future behaviour agree.
    if (gap < JOURNEY_WINDOW_MS) {
      current.push(row);
    } else {
      windows.push(current);
      current = [row];
    }
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

/**
 * Choose the canonical journey for one window and classify the rest.
 *
 * Precedence (design §24):
 *   1. a completed journey — it demonstrably delivered the guide
 *   2. a journey with a confirmed accepted gate — Meta took the DM
 *   3. the earliest journey — the request that actually started this
 *
 * Aliases are labelled `recovered` when some journey in the window completed (the
 * person got what they asked for, just through a sibling) and `superseded` when
 * none did. That distinction is the whole reporting value: `recovered` rows are
 * satisfied requests wrongly counted as failures today.
 */
export function reconcileWindow(window: ReconcileCandidate[]): ReconciledWindow {
  if (window.length === 0) throw new Error("reconcileWindow: empty window");

  const sorted = [...window].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );

  const canonical =
    sorted.find((row) => row.completed) ??
    sorted.find((row) => row.hasSentGate) ??
    sorted[0]!;

  const windowCompleted = sorted.some((row) => row.completed);
  const firstTrigger = sorted[0]!.createdAt;
  const lastTrigger = sorted[sorted.length - 1]!.createdAt;

  // Earliest completion in the window, so a later trigger inside it reads as
  // already-completed rather than re-gating someone.
  const completedAt =
    sorted
      .map((row) => row.completedAt)
      .filter((at): at is Date => at !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

  return {
    canonicalId: canonical.id,
    windowStartedAt: firstTrigger,
    lastTriggerAt: lastTrigger,
    windowExpiresAt: new Date(lastTrigger.getTime() + JOURNEY_WINDOW_MS),
    completedAt,
    aliases: sorted
      .filter((row) => row.id !== canonical.id)
      .map((row) => ({
        id: row.id,
        state: windowCompleted ? ("recovered" as const) : ("superseded" as const),
        reason: windowCompleted
          ? "another journey in this window delivered the guide"
          : "not the canonical journey for this request",
      })),
  };
}

/** Why a given journey won, for the dry-run report and the stored reason. */
export function describeCanonicalChoice(window: ReconcileCandidate[]): string {
  if (window.some((row) => row.completed)) return "completed";
  if (window.some((row) => row.hasSentGate)) return "confirmed_gate";
  return "earliest";
}
