import { MessageSquare } from "lucide-react";
import { AiConnectionCard } from "@/components/ai/AiConnectionCard";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Milestone 1 of the Codex integration: connect the owner's ChatGPT account.
 *
 * The chat area is intentionally inert here. The advisor thread and its three
 * read-only data tools arrive in a later phase, and shipping a live-looking chat
 * box before then would promise something that does not answer.
 */
export function Assistant() {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Assistant</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your ChatGPT subscription so Tiny Soho can suggest DM replies for you to approve,
          and answer questions about your own data. It never sends a message on its own.
        </p>
      </div>

      <AiConnectionCard />

      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
          <MessageSquare className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium">Chat is coming next</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Once the connection is live, this is where you'll ask about your funnel, guides and
            conversations — with the evidence behind every answer.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
