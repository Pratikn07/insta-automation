/**
 * The public comment a historical recovery campaign posts.
 *
 * Two rules govern every word here, and both were broken by the first version.
 *
 * 1. THE ACTION MUST WORK. `commentHandler` ignores any comment whose text contains
 *    no active keyword, so "Reply here and I'll send it over" is a dead end: a person
 *    who follows it literally gets nothing, forever. The action has to be
 *    `DM @tinysoho "{KEYWORD}"`, because messageHandler DOES match keywords and will
 *    deliver the guide. The instruction and the implementation must be the same thing.
 *
 * 2. NEVER CLAIM MORE THAN THE EVIDENCE. `gate_exhausted` means Meta told us delivery
 *    failed, so "I couldn't send your guide" is a fact. `gate_sent_no_read` means Meta
 *    ACCEPTED the DM and no read receipt arrived, which is not the same as failure.
 *    Absence of a receipt is not evidence of absence, so that copy says the guide was
 *    sent and asks them to look, rather than asserting it never arrived.
 *
 * Copy is rendered at selection and frozen onto the candidate, so editing this file
 * never changes an approved campaign. Bump COPY_VERSION when wording changes, or two
 * campaigns cannot be compared.
 */

/** Bumped from recovery-v1, whose action did not exist and whose Phase 2 wording
 *  asserted a delivery failure it could not show. */
export const COPY_VERSION = "recovery-v2";

/** Where the person is told to send the keyword. */
export const RECOVERY_HANDLE = "@tinysoho";

export type RecoveryEvidence = "gate_exhausted" | "gate_sent_no_read";

/**
 * Normalise the keyword for display.
 *
 * The design requires the configured keyword shown in uppercase (QA-18). Locale-safe
 * `toUpperCase` on a trimmed value, and the result is what gets stored, so a later
 * keyword rename cannot change what an approved campaign says.
 */
export function normalizeKeywordForCopy(keyword: string): string {
  const trimmed = keyword.trim();
  if (trimmed.length === 0) {
    throw new Error("historical recovery copy requires a non-empty keyword");
  }
  return trimmed.toUpperCase();
}

/**
 * Render the approved copy for one candidate.
 *
 * Templates are the design's §33 recommendations verbatim except for punctuation the
 * owner asked to avoid. Both name the keyword, so the instruction is executable.
 */
export function recoveryCopyFor(evidence: string, keyword: string): string {
  const kw = normalizeKeywordForCopy(keyword);

  // Only for the cohort where Meta confirmed the DM could not be delivered.
  if (evidence === "gate_exhausted") {
    return `I couldn't send your guide by DM 💛 Please DM ${RECOVERY_HANDLE} "${kw}" and I'll send it there.`;
  }

  // Everything else, including an unrecognised evidence type. Says what we can show:
  // the guide was sent, and here is how to get it if they cannot find it. Makes no
  // claim about delivery failing.
  return `I sent your guide 💛 Check your DMs and message requests. If you don't see it, DM ${RECOVERY_HANDLE} "${kw}".`;
}

/**
 * Guards for the two ways this copy can be wrong. Used by tests rather than at
 * runtime, since throwing mid-campaign would be worse than the wording.
 */

/** "Reply here" and similar have no handler. Only a DM with the keyword works. */
export function copyHasWorkingAction(text: string): boolean {
  if (/repl(y|ies) here/i.test(text)) return false;
  return text.includes(`DM ${RECOVERY_HANDLE}`);
}

/** Does the text assert our DM failed? Only permitted with gate_exhausted evidence. */
export function copyClaimsDeliveryFailed(text: string): boolean {
  return /(couldn't send|could not send|never (made it|arrived|reached)|didn't (send|arrive|reach)|failed to (send|deliver))/i.test(
    text,
  );
}
