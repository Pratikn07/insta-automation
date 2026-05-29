import { graph } from "./graphClient.js";
import { logger } from "../lib/logger.js";

export async function replyToComment(commentId: string, message: string): Promise<void> {
  await graph.post(`/${commentId}/replies`, { message });
  logger.debug({ commentId }, "Posted public reply");
}
