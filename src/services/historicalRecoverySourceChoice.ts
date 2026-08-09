import type { SourceCommentState } from "./historicalRecoveryRecheck.js";

export type ApprovedHistoricalSource = {
  position: number;
  commentId: string;
};

export type ApprovedHistoricalSourceResolution =
  | { kind: "selected"; commentId: string; position: number }
  | { kind: "blocked"; reason: "auth" | "unknown" | "source_set_exhausted" };

/**
 * Resolve only within the owner-reviewed ordered source set.
 *
 * Definitive absence may advance to the next approved comment. A read that did not
 * establish absence stops immediately; uncertainty is never permission to redirect a
 * public reply. The caller supplies the provider read so this policy remains pure.
 */
export async function resolveApprovedHistoricalSource(
  sources: ApprovedHistoricalSource[],
  read: (commentId: string) => Promise<SourceCommentState>,
): Promise<ApprovedHistoricalSourceResolution> {
  for (const source of [...sources].sort((left, right) => left.position - right.position)) {
    const state = await read(source.commentId);
    if (state === "visible") {
      return { kind: "selected", commentId: source.commentId, position: source.position };
    }
    if (state === "auth" || state === "unknown") {
      return { kind: "blocked", reason: state };
    }
    // `missing` and `hidden` are definitive for this source and may advance only to
    // the next source already present in the reviewed set.
  }
  return { kind: "blocked", reason: "source_set_exhausted" };
}
