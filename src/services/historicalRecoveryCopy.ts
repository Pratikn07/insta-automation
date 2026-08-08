/**
 * The public comment a historical recovery campaign posts.
 *
 * Owned here rather than taken from the keyword. A keyword's `publicReply` is
 * "Check your DMs! 💌", which is right SECONDS after someone comments and wrong
 * 43 days later to somebody whose DM never arrived: it points them at the very
 * thing that failed, and reads as a malfunction or a brush-off.
 *
 * This copy is snapshotted onto each candidate at selection, so revising it here
 * never changes an approved campaign. Bump COPY_VERSION when the wording changes,
 * or two campaigns become impossible to compare.
 *
 * House style, matched to the account's existing messages: first person, one
 * exclamation, 💛, no em dashes, and no "sorry for the inconvenience" register.
 */

export const COPY_VERSION = "recovery-v1";

/**
 * Wording differs by what we actually know, because the two claims are different.
 *
 * `gate_exhausted` means Meta told us the DM could not be delivered, so "couldn't
 * reach you" is a fact. `gate_sent_no_read` means Meta accepted it and no read
 * receipt ever arrived, which is NOT proof it failed. Absence of a receipt is not
 * evidence of absence, so that copy says "looks like" and never asserts failure.
 */
const COPY: Record<string, string> = {
  gate_exhausted: "So sorry, my DM couldn't reach you! Reply here and I'll get your guide to you 💛",
  gate_sent_no_read:
    "So sorry, looks like my DM never made it to you! Reply here and I'll send your guide right over 💛",
};

/**
 * The safer of the two, used when evidence is unrecognised.
 *
 * Defaulting to the hedged wording matters: an unknown evidence type must never
 * produce a public claim that our DM definitively failed when we cannot show it.
 */
const FALLBACK = COPY.gate_sent_no_read!;

export function recoveryCopyFor(evidence: string): string {
  return COPY[evidence] ?? FALLBACK;
}

/**
 * Guard against the failure this module exists to prevent.
 *
 * "Check your DM" is exactly what the keyword copy says, and shipping it here would
 * silently reintroduce the bug. Called by the test rather than at runtime, since a
 * throw mid-campaign would be worse than the wording.
 */
export function copyPointsAtDm(text: string): boolean {
  return /check your dm/i.test(text);
}
