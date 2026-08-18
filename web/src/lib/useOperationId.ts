import { useState } from "react";
import { createOperationId } from "./mutationOutcome";

/**
 * One stable UUID for one owner intent.
 *
 * The ID has to outlive the request, which is why it cannot be minted inside
 * `mutationFn`: if the first attempt's outcome is unknown, the second attempt must
 * carry the *same* key so the server recognises a replay instead of creating a
 * second row. Minting per call would turn every retry into a new create — exactly
 * the duplicate the key exists to prevent.
 *
 * `renew` is called only after a confirmed success, when the next attempt is
 * genuinely a different intent.
 */
export function useOperationId(): { operationId: string; renew: () => void } {
  const [operationId, setOperationId] = useState(createOperationId);
  return { operationId, renew: () => setOperationId(createOperationId()) };
}
