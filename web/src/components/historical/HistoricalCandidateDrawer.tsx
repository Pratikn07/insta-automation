import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { campaignPhaseView } from "./historicalRecoveryViewModel";

type HistoricalCandidateDetail = {
  candidate: {
    id: string;
    campaignPhase: string;
    igUserId: string;
    commentId: string;
    mediaId: string | null;
    commentAt: string;
    keywordSnapshot: string;
    publicReplyText: string;
    evidence: string;
    audienceOrigin: string | null;
    audienceOriginMethod: string | null;
    audienceOriginConfidence: string | null;
    arm: string;
    outcome: string;
    attempts: number;
    reviewedAt: string | null;
    suppressionReason: string | null;
  };
  campaign: {
    id: string;
    state: string;
    selectionVersion: string;
    copyVersion: string;
    sourceDataCutoff: string;
  };
  intent: {
    id: string;
    keyword: { id: string; keyword: string };
    reconciledState: string;
    completedAt: string | null;
    canonicalConversation: {
      id: string;
      state: string;
      reconciliationReason: string | null;
    } | null;
    aliasConversations: Array<{
      id: string;
      state: string;
      reconciliationReason: string | null;
    }>;
    triggers: Array<{
      id: string;
      commentId: string;
      mediaId: string | null;
      receivedAt: string;
      triggerKind: string;
      disposition: string;
    }>;
  };
  mediaPermalink: string | null;
  auditEvents: Array<{
    id: string;
    kind: string;
    actor: string | null;
    action: string | null;
    reason: string | null;
    category: string | null;
    createdAt: string;
  }>;
};

function readable(value: string): string {
  return value.replace(/_/g, " ");
}

export function HistoricalCandidateDrawer({
  candidateId,
  onClose,
}: {
  candidateId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["historical-candidate", candidateId],
    queryFn: () =>
      api<HistoricalCandidateDetail>(`/historical-recovery/candidates/${candidateId}`),
    enabled: candidateId !== null,
  });

  const review = useMutation({
    mutationFn: () =>
      api<void>(`/historical-recovery/candidates/${candidateId}/mark-reviewed`, {
        method: "POST",
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["historical-candidate", candidateId] }),
        queryClient.invalidateQueries({ queryKey: ["historical-candidates"] }),
        queryClient.invalidateQueries({ queryKey: ["historical-campaigns"] }),
      ]);
      toast.success("Candidate marked reviewed");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const data = detail.data;
  const canReview =
    data !== undefined &&
    data.candidate.reviewedAt === null &&
    ["send_failed", "send_uncertain"].includes(data.candidate.outcome);

  return (
    <Drawer
      open={candidateId !== null}
      onClose={onClose}
      title="Historical recovery evidence"
      description={data ? `${data.candidate.keywordSnapshot} · ${data.candidate.igUserId}` : undefined}
    >
      {detail.isLoading || !data ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="space-y-6 text-sm">
          <section className="space-y-2">
            <h3 className="font-medium">Source and outcome</h3>
            <p className="text-muted-foreground">
              {campaignPhaseView(data.candidate.campaignPhase).description}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Source comment</dt>
              <dd>{data.candidate.commentId}</dd>
              <dt className="text-muted-foreground">Evidence</dt>
              <dd>{readable(data.candidate.evidence)}</dd>
              <dt className="text-muted-foreground">Audience origin</dt>
              <dd>{data.candidate.audienceOrigin ? readable(data.candidate.audienceOrigin) : "Not recorded"}</dd>
              <dt className="text-muted-foreground">Origin method</dt>
              <dd>{data.candidate.audienceOriginMethod ? readable(data.candidate.audienceOriginMethod) : "Not recorded"}</dd>
              <dt className="text-muted-foreground">Origin confidence</dt>
              <dd>{data.candidate.audienceOriginConfidence ? readable(data.candidate.audienceOriginConfidence) : "Not recorded"}</dd>
              <dt className="text-muted-foreground">Outcome</dt>
              <dd>{readable(data.candidate.outcome)}</dd>
              <dt className="text-muted-foreground">Attempts</dt>
              <dd>{data.candidate.attempts}</dd>
            </dl>
            {data.mediaPermalink ? (
              <a
                href={data.mediaPermalink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                View source post <ExternalLink className="size-3" />
              </a>
            ) : (
              <p className="text-xs text-muted-foreground">Source permalink unavailable</p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">Canonical intent</h3>
            <p className="text-xs text-muted-foreground">
              {data.intent.id} · {data.intent.keyword.keyword}
            </p>
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Canonical conversation</p>
              <p>{data.intent.canonicalConversation?.id ?? "No canonical owner"}</p>
            </div>
            {data.intent.aliasConversations.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground">Alias conversations</p>
                <ul className="mt-1 space-y-1">
                  {data.intent.aliasConversations.map((alias) => (
                    <li key={alias.id}>{alias.id}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">Triggers</h3>
            <ul className="space-y-2">
              {data.intent.triggers.map((trigger) => (
                <li key={trigger.id} className="rounded-md border p-3">
                  <p>{trigger.commentId}</p>
                  <p className="text-xs text-muted-foreground">
                    {readable(trigger.disposition)} · {new Date(trigger.receivedAt).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">Audit history</h3>
            {data.auditEvents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No candidate audit events recorded.</p>
            ) : (
              <ul className="space-y-2">
                {data.auditEvents.map((event) => (
                  <li key={event.id} className="rounded-md border p-3">
                    <p>{readable(event.kind)}</p>
                    <p className="text-xs text-muted-foreground">
                      {event.actor ?? event.category ?? event.reason ?? "System"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.candidate.reviewedAt ? (
            <p className="text-sm text-emerald-400">Reviewed</p>
          ) : canReview ? (
            <Button onClick={() => review.mutate()} disabled={review.isPending}>
              Mark reviewed
            </Button>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
