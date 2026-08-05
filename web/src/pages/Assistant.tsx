import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, MessageSquare, Send } from "lucide-react";
import { api } from "@/lib/api";
import type { AdvisorHistoryItem, AdvisorResponse, AiConnectionStatus } from "@/lib/types";
import { AiConnectionCard } from "@/components/ai/AiConnectionCard";
import { AdvisorMessage } from "@/components/assistant/AdvisorMessage";
import {
  MAX_QUESTION_LENGTH,
  askErrorMessage,
  assistantView,
  composerState,
  mergeTurns,
  retryAtOf,
} from "@/components/assistant/advisorView";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

/**
 * The owner's read-only business advisor.
 *
 * One persistent thread on the runtime, so context carries between questions. This
 * page can ask and it can navigate — there is no send, approve or settings control
 * anywhere in it. Approving an AI-drafted DM lives in Conversations, behind the
 * owner's own explicit approval.
 *
 * The advisor rollout flag is server-side. Rather than mirroring it in the browser,
 * the history request tells us: a 403 `ai_advisor_disabled` is the disabled state.
 */

interface PendingTurn {
  clientMessageId: string;
  question: string;
}

interface CompletedTurn extends PendingTurn {
  response: AdvisorResponse;
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const body = (error as { body?: { error?: unknown } }).body;
    if (body && typeof body.error === "string") return body.error;
  }
  return null;
}

export function Assistant() {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingTurn | null>(null);
  // Turns answered in this session. The runtime's persistent thread is the record
  // of truth, but an answer must never disappear because a history refetch was
  // slow or failed — the owner has already spent the quota on it.
  const [answered, setAnswered] = useState<CompletedTurn[]>([]);
  const [askError, setAskError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const statusQ = useQuery<AiConnectionStatus>({
    queryKey: ["ai", "connection"],
    queryFn: () => api<AiConnectionStatus>("/ai/connection"),
  });

  const historyQ = useQuery<{ items: AdvisorHistoryItem[] }>({
    queryKey: ["ai", "advisor", "history"],
    queryFn: () => api<{ items: AdvisorHistoryItem[] }>("/ai/advisor/history"),
    enabled: statusQ.data?.connected === true,
    retry: false,
  });

  // The server owns the flag. A 403 here IS the disabled state.
  const advisorEnabled = errorCodeOf(historyQ.error) !== "ai_advisor_disabled";

  const view = assistantView({
    isLoading: statusQ.isLoading,
    error: statusQ.error,
    status: statusQ.data,
    advisorEnabled,
  });

  const ask = useMutation<AdvisorResponse, unknown, PendingTurn>({
    mutationFn: (turn) =>
      api<AdvisorResponse>("/ai/advisor/messages", {
        method: "POST",
        body: JSON.stringify({ message: turn.question, clientMessageId: turn.clientMessageId }),
      }),
    onSuccess: async (response, turn) => {
      setAnswered((previous) => [...previous, { ...turn, response }]);
      setPending(null);
      setText("");
      // Refresh history too, so a reload shows the same conversation from the
      // runtime's thread rather than only this session's turns.
      await queryClient.invalidateQueries({ queryKey: ["ai", "advisor", "history"] });
    },
    onError: (error) => {
      // The question stays in the composer: asking the owner to retype something
      // they already wrote is the wrong response to a rate limit.
      setAskError(askErrorMessage(error, retryAtOf(error)));
      setPending(null);
    },
  });

  const composer = composerState({
    text,
    pending: ask.isPending,
    ready: view.kind === "ready",
  });

  const items = mergeTurns(historyQ.data?.items ?? [], answered);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items.length, pending]);

  function submit(): void {
    if (!composer.canSubmit) return;
    setAskError(null);
    const turn = { clientMessageId: crypto.randomUUID(), question: text.trim() };
    setPending(turn);
    ask.mutate(turn);
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Assistant</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask about your own funnel, guides and conversations. Every answer comes with the evidence
          behind it. It never sends a message.
        </p>
      </div>

      <AiConnectionCard />

      {view.kind === "loading" && <Skeleton className="h-40 w-full" />}

      {view.kind === "unavailable" && (
        <Card>
          <CardContent className="flex items-start gap-2 py-6 text-sm text-muted-foreground">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{view.reason}</span>
          </CardContent>
        </Card>
      )}

      {view.kind === "disconnected" && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <MessageSquare className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium">Connect ChatGPT to start asking</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Use the card above to link your subscription. Your keyword and guide automations run
              either way.
            </p>
          </CardContent>
        </Card>
      )}

      {view.kind === "needs-reauth" && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <AlertCircle className="size-5 text-amber-600" />
            <p className="text-sm font-medium">Reconnect ChatGPT to continue</p>
            <p className="max-w-md text-sm text-muted-foreground">
              The stored sign-in needs re-authorising. Use Reconnect above.
            </p>
          </CardContent>
        </Card>
      )}

      {view.kind === "disabled" && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <MessageSquare className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium">Assistant is not enabled yet</p>
            <p className="max-w-md text-sm text-muted-foreground">
              ChatGPT is connected. The Assistant turns on once its data tools have been verified on
              this environment.
            </p>
          </CardContent>
        </Card>
      )}

      {view.kind === "ready" && (
        <div className="space-y-4">
          {historyQ.isLoading && <Skeleton className="h-24 w-full" />}

          {!historyQ.isLoading && items.length === 0 && !pending && (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
                <MessageSquare className="size-5 text-muted-foreground" />
                <p className="text-sm font-medium">Ask your first question</p>
                <p className="max-w-md text-sm text-muted-foreground">
                  Try “What should I focus on this week?” or “Which guide is converting worst?”
                </p>
              </CardContent>
            </Card>
          )}

          <div className="space-y-4">
            {items.map((item, index) =>
              item.role === "user" ? (
                <div
                  key={`${item.clientMessageId ?? "user"}-${index}`}
                  className="ml-auto max-w-[85%] rounded-lg bg-primary px-4 py-2.5 text-sm text-primary-foreground"
                >
                  {item.text}
                </div>
              ) : item.response ? (
                <AdvisorMessage
                  key={`${item.clientMessageId ?? "assistant"}-${index}`}
                  response={item.response}
                />
              ) : null,
            )}

            {pending && (
              <>
                <div className="ml-auto max-w-[85%] rounded-lg bg-primary px-4 py-2.5 text-sm text-primary-foreground">
                  {pending.question}
                </div>
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Reading your data…
                </p>
              </>
            )}
          </div>

          <div ref={endRef} />

          {askError && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{askError}</span>
            </div>
          )}

          <div className="space-y-2">
            <Textarea
              aria-label="Ask Tiny SOHO"
              placeholder="What should I focus on this week?"
              value={text}
              rows={3}
              maxLength={MAX_QUESTION_LENGTH}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter is a newline, matching every chat the
                // owner already uses.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {text.length}/{MAX_QUESTION_LENGTH}
              </span>
              <Button variant="brand" onClick={submit} disabled={!composer.canSubmit}>
                {ask.isPending ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Send className="mr-2 size-4" />
                )}
                Ask
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
