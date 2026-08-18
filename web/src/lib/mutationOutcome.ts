/**
 * The vocabulary for a mutation whose result nobody knows.
 *
 * A read that fails can simply be repeated. A mutation cannot: repeating it is
 * only safe if you know the first attempt did not happen, and the moment `fetch`
 * is called you no longer know that. A timeout, a dropped connection, or a 502
 * from a proxy all leave the same question open — did the server do it?
 *
 * So failures are split by *phase* rather than by cause. Before dispatch, the
 * request provably never left the browser and is safe to repeat. After dispatch,
 * the honest answer is `unknown`, and an unknown outcome is never retried
 * automatically. It is reconciled: read the canonical state and find out.
 */

/** The request never left the browser. Safe to repeat unchanged. */
export class MutationNotDispatchedError extends Error {
  readonly code = "mutation_not_dispatched";
  readonly path: string;
  constructor(path: string) {
    super(`The request to ${path} was never sent.`);
    this.name = "MutationNotDispatchedError";
    this.path = path;
  }
}

/**
 * The request was sent and its result is not known.
 *
 * Deliberately carries only the path and the operation ID. A mutation body can
 * be an approved reply to a real person or a signed upload URL, and an error
 * object ends up in logs, toasts, and error reporting — so the body, headers, and
 * provider response never come along.
 */
export class MutationOutcomeUnknownError extends Error {
  readonly code = "mutation_outcome_unknown";
  readonly path: string;
  readonly operationId: string | undefined;
  constructor(path: string, operationId: string | undefined) {
    super(`The result of ${path} is unknown. Check the current state before retrying.`);
    this.name = "MutationOutcomeUnknownError";
    this.path = path;
    this.operationId = operationId;
  }
}

/**
 * What a canonical read found out after an unknown outcome.
 *
 * `absent` is a positive finding — the canonical read succeeded and the thing is
 * not there — which is the only basis for repeating the operation. A failed read
 * is `still_unknown`, never `absent`; "I could not look" and "it is not there"
 * are different answers and conflating them is how a duplicate gets sent.
 */
export type ReconciliationResult<T> =
  | { status: "confirmed"; value: T }
  | { status: "absent" }
  | { status: "still_unknown" };

/**
 * The stable identity of one owner intent.
 *
 * Created when the owner begins the attempt, not inside `mutationFn`, so that a
 * retry after an unknown outcome carries the *same* key and the server can
 * recognise it as a replay rather than a second request.
 */
export function createOperationId(): string {
  return crypto.randomUUID();
}
