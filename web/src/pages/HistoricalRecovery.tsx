import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Pause, Play, Check, X, ArrowUpRight } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  candidateView,
  campaignActions,
  campaignStatusView,
  recoveryRate,
  type CampaignRow,
  type CandidateRow,
  type CampaignState,
} from "@/components/historical/historicalRecoveryViewModel";

/**
 * Historical recovery — reaching back to people whose guide never arrived.
 *
 * A separate area from Conversations' Ready/Sent tabs on purpose (§40). Those answer
 * "is the automation working now"; this answers "should we contact people we already
 * failed", and one approval here posts public comments on hundreds of real posts. The
 * two must not be one screen where a habitual click means something different.
 *
 * There is no per-row send. The owner's levers are approve, pause, resume, cancel,
 * and raise the caps — decisions at a scale a person can actually reason about.
 */

const TABS = [
  { key: "pending", label: "Waiting" },
  { key: "sent", label: "Sent" },
  { key: "recovered", label: "Recovered" },
  { key: "attention", label: "Needs review" },
  { key: "suppressed", label: "Withheld" },
  { key: "holdout", label: "Control" },
] as const;

type CampaignsResponse = { sendingEnabled: boolean; campaigns: CampaignRow[] };
type CandidatesResponse = {
  counts: Record<string, number>;
  nextCursor: string | null;
  candidates: CandidateRow[];
};

const TONE_CLASS: Record<string, string> = {
  positive: "text-emerald-400",
  pending: "text-sky-400",
  warning: "text-amber-400",
  danger: "text-red-400",
  neutral: "text-muted-foreground",
};

function ageInDays(iso: string): number {
  return Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
}

export function HistoricalRecovery() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("pending");
  const [confirming, setConfirming] = useState<null | { action: string; campaignId: string }>(null);

  const campaigns = useQuery({
    queryKey: ["historical-campaigns"],
    queryFn: () => api<CampaignsResponse>("/historical-recovery/campaigns"),
  });

  const active = campaigns.data?.campaigns[0];

  const candidates = useQuery({
    queryKey: ["historical-candidates", active?.id, tab],
    queryFn: () =>
      api<CandidatesResponse>(
        `/historical-recovery/candidates?view=${tab}${active ? `&campaignId=${active.id}` : ""}`,
      ),
    enabled: Boolean(active),
  });

  const act = useMutation({
    mutationFn: async ({ action, campaignId }: { action: string; campaignId: string }) => {
      // The server requires a reason for pause and cancel, and an approver for
      // approve — an unattributable approval is not an audit trail for an action
      // that posts publicly under the account's name.
      const body =
        action === "approve"
          ? { approvedBy: "owner" }
          : action === "pause" || action === "cancel"
            ? { reason: "Stopped from the dashboard" }
            : {};
      return api<{ state: string }>(`/historical-recovery/campaigns/${campaignId}/${action}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (_data, variables) => {
      toast.success(`Campaign ${variables.action}d`);
      void queryClient.invalidateQueries({ queryKey: ["historical-campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["historical-candidates"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (campaigns.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!active) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Historical recovery</h1>
        <Card className="mt-6 p-6">
          <p className="text-sm text-muted-foreground">
            No campaign yet. A campaign is prepared from the command line, reviewed here, and only
            then approved — nothing is ever contacted automatically.
          </p>
          <code className="mt-4 block rounded bg-secondary p-3 text-xs">
            npx tsx scripts/select-historical-recovery.ts
          </code>
        </Card>
      </div>
    );
  }

  const status = campaignStatusView(active, campaigns.data!.sendingEnabled);
  const actions = campaignActions(active.state as CampaignState);
  const rate = recoveryRate({ ...active.progress, recovered: candidates.data?.counts.recovered ?? 0 });
  const attention = candidates.data?.counts.attention ?? 0;

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Historical recovery</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          People who asked for a guide weeks ago and never received it.
        </p>
      </header>

      {/* Anything needing a human decision comes before the controls: an uncertain
          send may already be live on Instagram, and burying it under an Approve
          button would be exactly the wrong order. */}
      {attention > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div>
              <p className="text-sm font-medium">
                {attention} {attention === 1 ? "reminder needs" : "reminders need"} your review
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                These were interrupted or rejected mid-send. They are never retried automatically,
                because a retry could post a second public comment.
              </p>
              <button
                className="mt-2 text-sm text-amber-400 underline-offset-4 hover:underline"
                onClick={() => setTab("attention")}
              >
                Review them
              </button>
            </div>
          </div>
        </Card>
      )}

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className={`text-sm font-medium ${TONE_CLASS[status.tone]}`}>{status.label}</p>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">{status.description}</p>
            {active.approvedBy && (
              <p className="mt-2 text-xs text-muted-foreground">
                Approved by {active.approvedBy}
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {actions.canApprove && (
              <Button
                onClick={() => setConfirming({ action: "approve", campaignId: active.id })}
                disabled={act.isPending}
              >
                <Check className="mr-1.5 h-4 w-4" />
                Approve {active.candidateCount} people
              </Button>
            )}
            {actions.canPause && (
              <Button
                variant="secondary"
                onClick={() => act.mutate({ action: "pause", campaignId: active.id })}
                disabled={act.isPending}
              >
                <Pause className="mr-1.5 h-4 w-4" />
                Pause
              </Button>
            )}
            {actions.canResume && (
              <Button
                onClick={() => act.mutate({ action: "resume", campaignId: active.id })}
                disabled={act.isPending}
              >
                <Play className="mr-1.5 h-4 w-4" />
                Resume
              </Button>
            )}
            {actions.canCancel && (
              <Button
                variant="ghost"
                onClick={() => setConfirming({ action: "cancel", campaignId: active.id })}
                disabled={act.isPending}
              >
                <X className="mr-1.5 h-4 w-4" />
                Cancel
              </Button>
            )}
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Selected</dt>
            <dd className="mt-0.5 text-lg tabular-nums">{active.candidateCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Sent</dt>
            <dd className="mt-0.5 text-lg tabular-nums">{active.progress.sent ?? 0}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Held back as control</dt>
            <dd className="mt-0.5 text-lg tabular-nums">{active.holdoutPercent}%</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Recovered</dt>
            {/* Null, not 0%, before anything is sent: a 0% would read as failure
                when the truth is "no evidence yet". */}
            <dd className="mt-0.5 text-lg tabular-nums">
              {rate === null ? (
                <span className="text-sm text-muted-foreground">No sends yet</span>
              ) : (
                `${Math.round(rate * 100)}%`
              )}
            </dd>
          </div>
        </dl>
      </Card>

      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(({ key, label }) => {
          const count = candidates.data?.counts[key];
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === key
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
              {count !== undefined && (
                <span className="ml-1.5 tabular-nums text-muted-foreground">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {candidates.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : candidates.data?.candidates.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Nothing in this view.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {candidates.data?.candidates.map((row) => {
            const view = candidateView(row);
            return (
              <li key={row.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {row.username ? `@${row.username}` : row.igUserId}
                    <span className="ml-2 text-muted-foreground">{row.keywordSnapshot}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Asked {ageInDays(row.commentAt)} days ago
                  </p>
                </div>
                <div className="min-w-0 max-w-md flex-1">
                  <p className={`text-sm ${TONE_CLASS[view.tone]}`}>{view.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{view.description}</p>
                </div>
                {row.publicReplyId && (
                  <a
                    href={`https://www.instagram.com/p/${row.publicReplyId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    View <ArrowUpRight className="inline h-3 w-3" />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Approve and cancel both need confirmation: one starts posting public
          comments on hundreds of posts, the other abandons work that cannot be
          un-abandoned without re-selecting. */}
      <ConfirmDialog
        open={confirming !== null}
        onCancel={() => setConfirming(null)}
        busy={act.isPending}
        destructive={confirming?.action === "cancel"}
        title={
          confirming?.action === "approve"
            ? `Start contacting ${active.candidateCount} people?`
            : "Cancel this campaign?"
        }
        description={
          confirming?.action === "approve"
            ? `Each person gets one public comment on the reel they originally commented on. Sending is paced at ${active.hourlyCap} an hour, and you can pause at any time. ${active.holdoutPercent}% are held back as a control so you can tell whether it worked.`
            : "Reminders already posted stay posted — those comments are live on Instagram. Everything unsent is abandoned."
        }
        confirmLabel={confirming?.action === "approve" ? "Approve and start" : "Cancel campaign"}
        onConfirm={() => {
          if (confirming) act.mutate(confirming);
          setConfirming(null);
        }}
      />
    </div>
  );
}
