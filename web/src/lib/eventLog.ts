const KIND_LABELS: Record<string, string> = {
  webhook_received: "Webhook received",
  comment_received: "Comment received",
  comment_ignored: "Comment ignored (no keyword)",
  keyword_matched: "Keyword matched",
  public_reply_sent: "Public reply posted",
  public_reply_failed: "Public reply failed",
  dm_sent: "Gate DM sent",
  dm_failed: "Gate DM failed",
  message_received: "User sent a DM",
  message_unhandled: "DM ignored (not DONE)",
  done_received: "User replied DONE",
  sequence_completed: "Guide delivered",
  sequence_failed: "Guide failed",
  error: "Error",
};

export function prettyKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}
