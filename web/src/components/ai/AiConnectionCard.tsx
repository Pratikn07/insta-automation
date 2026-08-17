import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, ExternalLink, Loader2, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import type { AiConnectionStatus, AiLoginStart } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { connectionView } from "./connectionView";

/**
 * Links the owner's ChatGPT subscription to Tiny SOHO via Codex device code.
 *
 * This is account linking, NOT Tiny SOHO sign-in — the Supabase session is
 * unchanged. No token ever reaches the browser: the runtime holds ChatGPT
 * credentials on its own volume, and this card only ever renders the short code
 * and verification URL. The view state machine lives in ./connectionView.ts so
 * it stays testable without app env.
 */

function QuotaLine({ status }: { status: AiConnectionStatus }) {
  // A null snapshot means unknown usage. Showing "0% used" would be a lie, so
  // the absence is stated instead.
  if (!status.rateLimits || status.rateLimits.usedPercent === null) {
    return <p className="text-sm text-muted-foreground">Usage for this plan isn't reported yet.</p>;
  }
  const { usedPercent, resetsAt } = status.rateLimits;
  return (
    <p className="text-sm text-muted-foreground">
      {Math.round(usedPercent)}% of your Codex allowance used
      {resetsAt ? ` — resets ${new Date(resetsAt * 1000).toLocaleString()}` : ""}
    </p>
  );
}

export function AiConnectionCard() {
  const queryClient = useQueryClient();
  const [login, setLogin] = useState<AiLoginStart | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const statusQ = useQuery<AiConnectionStatus>({
    queryKey: ["ai", "connection"],
    queryFn: () => api<AiConnectionStatus>("/ai/connection"),
    // Poll ONLY while a device code is outstanding: sign-in completes in the
    // browser at OpenAI, so this is the only way to notice. Idle otherwise.
    refetchInterval: (query) =>
      login && !(query.state.data as AiConnectionStatus | undefined)?.connected ? 3_000 : false,
  });

  const view = connectionView({
    isLoading: statusQ.isLoading,
    error: statusQ.error,
    status: statusQ.data,
    login: statusQ.data?.connected ? null : login,
  });

  const startLogin = useMutation({
    mutationFn: () => api<AiLoginStart>("/ai/connection", { method: "POST" }),
    onSuccess: (data) => setLogin(data),
  });

  const disconnect = useMutation({
    mutationFn: () => api<void>("/ai/disconnect", { method: "POST" }),
    onSuccess: async () => {
      setLogin(null);
      setConfirmingDisconnect(false);
      await queryClient.invalidateQueries({ queryKey: ["ai", "connection"] });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" />
          <CardTitle>ChatGPT connection</CardTitle>
        </div>
        <CardDescription>
          Links your own ChatGPT subscription so the Assistant can draft replies and answer
          questions. This is separate from your Tiny Soho sign-in, and no OpenAI API key is used.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {view.kind === "loading" && <Skeleton className="h-9 w-40" />}

        {view.kind === "unavailable" && (
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{view.reason}</span>
          </div>
        )}

        {view.kind === "disconnected" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Not connected yet.</p>
            <Button
              variant="brand"
              onClick={() => startLogin.mutate()}
              disabled={startLogin.isPending}
            >
              {startLogin.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Connect ChatGPT
            </Button>
          </div>
        )}

        {view.kind === "awaiting-code" && (
          <div className="space-y-3">
            <p className="text-sm">
              Open the sign-in page and enter this code. This card updates itself once you finish.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <code className="rounded-md border bg-muted px-3 py-2 font-mono text-lg tracking-widest">
                {view.login.userCode}
              </code>
              <a
                href={view.login.verificationUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
              >
                {view.login.verificationUrl}
                <ExternalLink className="size-3.5" />
              </a>
            </div>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Waiting for you to approve the sign-in…
            </p>
          </div>
        )}

        {view.kind === "connected" && (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Check className="size-4 text-signal" />
              ChatGPT connected
              {view.status.account?.planType ? ` — ${view.status.account.planType}` : ""}
            </p>
            {view.status.account?.email && (
              <p className="text-sm text-muted-foreground">{view.status.account.email}</p>
            )}
            <QuotaLine status={view.status} />
            {/* `requiresOpenaiAuth` is intentionally not surfaced. It is a static
                provider capability ("this provider authenticates against OpenAI")
                and reads `true` for every healthy ChatGPT login, so showing it as a
                warning told the owner to re-authorise a working connection. */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => startLogin.mutate()}
                disabled={startLogin.isPending}
              >
                {startLogin.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Reconnect ChatGPT
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingDisconnect(true)}>
                Disconnect
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmingDisconnect}
        title="Disconnect ChatGPT?"
        description="Tiny Soho will delete the stored ChatGPT sign-in from the runtime. Your keyword and guide automations are unaffected."
        confirmLabel="Disconnect"
        destructive
        busy={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
        onCancel={() => setConfirmingDisconnect(false)}
      />
    </Card>
  );
}
