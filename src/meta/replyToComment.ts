import { graph } from "./graphClient.js";
import { logger } from "../lib/logger.js";

export type MetaPublicReplyResult = { replyId: string | null };

export async function replyToComment(
  commentId: string,
  message: string,
): Promise<MetaPublicReplyResult> {
  const response = await graph.post<{ id?: unknown }>(`/${commentId}/replies`, { message });
  const id = response.data?.id;
  logger.debug({ commentId }, "Posted public reply");
  return { replyId: typeof id === "string" && id.length > 0 ? id : null };
}
