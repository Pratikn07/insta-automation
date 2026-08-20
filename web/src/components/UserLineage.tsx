import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { apiRead } from "@/lib/api";
import type { LineageEvent, UserLineageResponse } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { EventRow } from "@/pages/Conversations";
import { prettyKind } from "@/lib/eventLog";
import { IncomingBubble, OutgoingBubble } from "./ChatBubbles";
import { FollowBadge } from "./FollowBadge";

// Which lineage events represent a message the USER sent us (outgoing bubble,
// right side) vs. something the BOT sent them (incoming bubble, left side).
const USER_KINDS = new Set([
  "comment_received",
  "comment_ignored",
  "message_received",
  "message_unhandled",
]);
const BOT_KINDS = new Set([
  "public_reply_sent",
  "dm_sent",
  "sequence_completed",
  "follow_nudge_sent",
]);

function bubbleText(e: LineageEvent): string {
  if (e.text) return e.text;
  // No stored text — use a faithful label for bot-side system messages.
  switch (e.kind) {
    case "public_reply_sent":
      return "(public reply posted on the comment)";
    case "dm_sent":
      return "(gate message sent)";
    case "sequence_completed":
      return "(guide delivered)";
    case "follow_nudge_sent":
      return "(follow-aware message sent)";
    default:
      return prettyKind(e.kind);
  }
}

export function UserLineage({ igUserId }: { igUserId: string }) {
  const q = useQuery<UserLineageResponse>({
    queryKey: ["user-lineage", igUserId],
    queryFn: ({ signal }) => apiRead<UserLineageResponse>(`/users/${igUserId}/lineage`, { signal }),
  });

  if (q.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (q.error || !q.data) {
    return <p className="text-sm text-destructive">Could not load this user.</p>;
  }

  const { user, events } = q.data;
  // Events that can render as a chat bubble (have text or are a known bot action).
  const threadEvents = events.filter(
    (e) => USER_KINDS.has(e.kind) || BOT_KINDS.has(e.kind),
  );

  return (
    <div className="space-y-6">
      {/* Follow intel (only shown once we've resolved it from a DM). */}
      <FollowBadge user={user} />

      <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Reconstructed from automation logs — shows what the bot saw and sent. Manual
          replies typed in Instagram aren&apos;t included.
        </span>
      </div>

      {/* Chat thread */}
      <div>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Conversation
        </h4>
        {threadEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages recorded.</p>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg bg-muted p-3">
            {threadEvents.map((e) =>
              USER_KINDS.has(e.kind) ? (
                <OutgoingBubble key={e.id} text={bubbleText(e)} />
              ) : (
                <IncomingBubble key={e.id} text={bubbleText(e)} />
              ),
            )}
          </div>
        )}
      </div>

      {/* Full timeline */}
      <div>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Full timeline
        </h4>
        <ol className="relative space-y-3 border-l border-border pl-5">
          {events.map((e) => (
            <EventRow
              key={e.id}
              event={{ id: e.id, kind: e.kind, payload: e, createdAt: e.createdAt }}
              showKindRaw
            />
          ))}
        </ol>
      </div>
    </div>
  );
}
