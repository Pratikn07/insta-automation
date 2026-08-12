import { useState } from "react";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Pause, Play, Check, X, Gauge } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  candidateView,
  campaignActions,
  campaignPhaseView,
  campaignStatusView,
  audienceSegmentLabel,
  recoveryRate,
  type CampaignRow,
  type CandidateRow,
  type CampaignState,
} from "@/components/historical/historicalRecoveryViewModel";
import {
  HistoricalStageForm,
  type HistoricalStageCaps,
} from "@/components/historical/HistoricalStageForm";
import { HistoricalCandidateDrawer } from "@/components/historical/HistoricalCandidateDrawer";

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
  asOf: string;
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
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [stageOpen, setStageOpen] = useState(false);
  const [confirming, setConfirming] = useState<
    | null
    | { action: "approve" | "cancel"; campaignId: string }
    | { action: "pause_group"; rolloutGroupId: string }
  >(null);

  const campaigns = useQuery({
    queryKey: ["historical-campaigns"],
    queryFn: () => api<CampaignsResponse>("/historical-recovery/campaigns"),
  });

  const campaignRows = campaigns.data?.campaigns ?? [];
  const active =
    campaignRows.find((campaign) => campaign.id === selectedCampaignId) ?? campaignRows[0];

  const candidates = useInfiniteQuery({
    queryKey: ["historical-candidates", active?.id, tab],
    initialPageParam: undefined as { cursor: string; asOf: string } | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ view: tab, campaignId: active!.id });
      if (pageParam) {
        params.set("cursor", pageParam.cursor);
        params.set("asOf", pageParam.asOf);
      }
      return api<CandidatesResponse>(
        `/historical-recovery/candidates?${params.toString()}`,
      );
    },
    getNextPageParam: (last) =>
      last.nextCursor ? { cursor: last.nextCursor, asOf: last.asOf } : undefined,
    enabled: Boolean(active),
  });

  const candidateRows = Array.from(
    new Map(
      (candidates.data?.pages.flatMap((page) => page.candidates) ?? []).map((row) => [row.id, row]),
    ).values(),
  );
  const candidateCounts = candidates.data?.pages.at(-1)?.counts;

  const act = useMutation({
    mutationFn: async ({ action, campaignId }: { action: string; campaignId: string }) => {
      // The server requires a reason for pause and cancel, and an approver for
      // approve — an unattributable approval is not an audit trail for an action
      // that posts publicly under the account's name.
      const body =
        action === "pause" || action === "cancel"
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

  const stage = useMutation({
    mutationFn: ({ campaignId, caps }: { campaignId: string; caps: HistoricalStageCaps }) =>
      api<{ state: string }>(`/historical-recovery/campaigns/${campaignId}/stage`, {
        method: "POST",
        body: JSON.stringify(caps),
      }),
    onSuccess: () => {
      setStageOpen(false);
      toast.success("Campaign stage advanced");
      void queryClient.invalidateQueries({ queryKey: ["historical-campaigns"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const pauseGroup = useMutation({
    mutationFn: (rolloutGroupId: string) =>
      api<{ rolloutGroupId: string }>(`/historical-recovery/rollout-groups/${rolloutGroupId}/pause`, {
        method: "POST",
        body: JSON.stringify({ reason: "Stopped from the dashboard" }),
      }),
    onSuccess: () => {
      toast.success("Expanded campaigns paused");
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
  const phase = campaignPhaseView(active.phase);
  const actions = campaignActions(active.state as CampaignState);
  const rate = recoveryRate({ ...active.progress, recovered: candidateCounts?.recovered ?? 0 });
  const attention = candidateCounts?.attention ?? 0;
  const hasRunningGroupSibling = active.rolloutGroupId !== null && campaignRows.some(
    (campaign) =>
      campaign.id !== active.id
      && campaign.rolloutGroupId === active.rolloutGroupId
      && campaign.state === "running",
  );

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Historical recovery</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {phase.description}
        </p>
        <div className="mt-4 max-w-xl space-y-1.5">
          <label htmlFor="historical-campaign" className="text-xs font-medium text-muted-foreground">
            Campaign
          </label>
          <select
            id="historical-campaign"
            value={active.id}
            onChange={(event) => {
              setSelectedCampaignId(event.target.value);
              setStageOpen(false);
            }}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {campaignRows.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaignPhaseView(campaign.phase).title} · {campaign.createdAt.slice(0, 10)}
              </option>
            ))}
          </select>
        </div>
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
            {hasRunningGroupSibling && active.rolloutGroupId && (
              <Button
                variant="destructive"
                onClick={() => setConfirming({ action: "pause_group", rolloutGroupId: active.rolloutGroupId! })}
                disabled={pauseGroup.isPending}
              >
                <Pause className="mr-1.5 h-4 w-4" />
                Pause all expanded campaigns
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
            {actions.canAdvanceStage && (
              <Button
                variant="outline"
                onClick={() => setStageOpen(true)}
                disabled={stage.isPending}
              >
                <Gauge className="mr-1.5 h-4 w-4" />
                Advance stage
              </Button>
            )}
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Selected</dt>
            <dd className="mt-0.5 text-lg tabular-nums">{active.candidateCount}</dd>
          </div>
          {active.audienceSegment && (
            <div>
              <dt className="text-xs text-muted-foreground">Audience at selection</dt>
              <dd className="mt-0.5 text-sm">{audienceSegmentLabel(active.audienceSegment)}</dd>
            </div>
          )}
          {active.rolloutGroupId && active.rolloutGroupHourlyCap !== null && (
            <>
              <div>
                <dt className="text-xs text-muted-foreground">Campaign capacity</dt>
                <dd className="mt-0.5 text-sm tabular-nums">{active.hourlyCap} per hour</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Shared group capacity used</dt>
                <dd className="mt-0.5 text-sm tabular-nums">
                  {active.rolloutGroupSentLastHour} / {active.rolloutGroupHourlyCap} in the past hour
                </dd>
              </div>
            </>
          )}
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

        {stageOpen && (
          <HistoricalStageForm
            key={active.id}
            campaign={active}
            busy={stage.isPending}
            onCancel={() => setStageOpen(false)}
            onSubmit={(caps) => stage.mutate({ campaignId: active.id, caps })}
          />
        )}
      </Card>

      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(({ key, label }) => {
          const count = candidateCounts?.[key];
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
      ) : candidateRows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Nothing in this view.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {candidateRows.map((row) => {
            const view = candidateView(row);
            return (
              <li key={row.id}>
                <button
                  type="button"
                  aria-label={`Open ${row.username ? `@${row.username}` : row.igUserId} ${row.keywordSnapshot}`}
                  onClick={() => setSelectedCandidateId(row.id)}
                  className="flex w-full flex-wrap items-start gap-x-4 gap-y-1 py-3 text-left hover:bg-accent/20"
                >
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
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {candidates.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            onClick={() => candidates.fetchNextPage()}
            disabled={candidates.isFetchingNextPage}
          >
            {candidates.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}

      <HistoricalCandidateDrawer
        candidateId={selectedCandidateId}
        onClose={() => setSelectedCandidateId(null)}
      />

      {/* Approve and cancel both need confirmation: one starts posting public
          comments on hundreds of posts, the other abandons work that cannot be
          un-abandoned without re-selecting. */}
      <ConfirmDialog
        open={confirming !== null}
        onCancel={() => setConfirming(null)}
        busy={act.isPending || pauseGroup.isPending}
        destructive={confirming?.action === "cancel" || confirming?.action === "pause_group"}
        title={
          confirming?.action === "approve"
            ? `Start contacting ${active.candidateCount} people?`
            : confirming?.action === "pause_group"
              ? "Pause all expanded campaigns?"
              : "Cancel this campaign?"
        }
        description={
          confirming?.action === "approve"
            ? `Each person gets one public comment on the reel they originally commented on. Sending is paced at ${active.hourlyCap} an hour, and you can pause at any time. ${active.holdoutPercent}% are held back as a control so you can tell whether it worked.`
            : confirming?.action === "pause_group"
              ? "This immediately pauses every running campaign in this expanded rollout. Reminders already posted stay posted."
              : "Reminders already posted stay posted — those comments are live on Instagram. Everything unsent is abandoned."
        }
        confirmLabel={
          confirming?.action === "approve"
            ? "Approve and start"
            : confirming?.action === "pause_group"
              ? "Pause all campaigns"
              : "Cancel campaign"
        }
        onConfirm={() => {
          if (confirming?.action === "pause_group") {
            pauseGroup.mutate(confirming.rolloutGroupId);
          } else if (confirming) {
            act.mutate(confirming);
          }
          setConfirming(null);
        }}
      />
    </div>
  );
}
