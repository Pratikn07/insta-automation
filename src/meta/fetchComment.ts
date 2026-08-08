import { graph } from "./graphClient.js";

export type FetchedComment = {
  id: string;
  hidden: boolean;
  timestamp: string | null;
};

/**
 * Read a comment's current state, to check it is still there before replying to it.
 *
 * Historical recovery replies to comments selected days earlier, and they do go
 * away: of three sampled 44-day-old comments, one had already been deleted. A
 * missing comment must suppress the send rather than fail it noisily.
 *
 * Two distinct outcomes the caller has to tell apart:
 *   - deleted / unresolvable → the Graph API 400s, and this THROWS
 *   - present but hidden     → resolves with `hidden: true`
 *
 * The second is the more dangerous one: replying to a hidden comment succeeds, so
 * it would be recorded as a send and counted in the experiment while nobody ever
 * saw it. Callers must check `hidden`, not merely that the call returned.
 *
 * Throws rather than returning null so a network failure is distinguishable from a
 * confirmed deletion — the caller decides which is safe to treat as "gone".
 */
export async function fetchComment(commentId: string): Promise<FetchedComment> {
  const response = await graph.get<{ id?: unknown; hidden?: unknown; timestamp?: unknown }>(
    `/${commentId}`,
    { params: { fields: "id,hidden,timestamp" } },
  );

  const data = response.data ?? {};
  return {
    id: typeof data.id === "string" ? data.id : commentId,
    // Default to NOT hidden only when Meta omits the field entirely. Treating an
    // absent field as hidden would suppress every send on an API change.
    hidden: data.hidden === true,
    timestamp: typeof data.timestamp === "string" ? data.timestamp : null,
  };
}
