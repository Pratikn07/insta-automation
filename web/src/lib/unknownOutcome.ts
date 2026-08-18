import { MutationOutcomeUnknownError } from "./mutationOutcome";

/**
 * What the owner is told when the console cannot say whether an action happened.
 *
 * The wording matters more than it looks. "Failed" would be a lie — the action may
 * well have been performed — and "try again" would invite the duplicate the whole
 * design exists to prevent. So the message states the actual situation and the UI
 * disables the action until a canonical read settles it.
 */
export const STILL_CONFIRMING_MESSAGE = "Still confirming with Instagram state";

/**
 * The same statement for actions that never touch Instagram, where naming
 * Instagram would be false precision.
 */
export const STILL_CONFIRMING_LOCAL_MESSAGE =
  "Still confirming whether that went through. Nothing has been retried.";

export function isUnknownOutcome(error: unknown): boolean {
  return error instanceof MutationOutcomeUnknownError;
}

/**
 * The message for a rejected mutation: the honest "we don't know" for an unknown
 * outcome, and the caller's own message for a definite failure.
 */
export function outcomeMessage(
  error: unknown,
  definiteMessage: string,
  unknownMessage: string = STILL_CONFIRMING_LOCAL_MESSAGE,
): string {
  return isUnknownOutcome(error) ? unknownMessage : definiteMessage;
}
