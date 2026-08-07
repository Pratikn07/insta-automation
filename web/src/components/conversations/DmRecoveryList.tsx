import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { recoveryApi } from "../../lib/api";
import type {
  RecoveryCounts,
  RecoveryMetrics,
  RecoveryReminderRow,
  RecoveryView,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import { recoveryStatusView, type RecoveryTone } from "./dmRecoveryViewModel";

/**
 * Shown while the circuit is open. Deliberately reassuring: an open circuit
 * means nothing is being sent, not that anything was lost — pending reminders
 * keep their place and are re-evaluated once the cause is cleared.
 */
export const CIRCUIT_PAUSED_MESSAGE =
  "Public recovery is paused. Pending reminders are safe and will be re-evaluated after the issue is resolved.";

const VIEWS: { value: RecoveryView; label: string }[] = [
  { value: "scheduled", label: "Scheduled" },
  { value: "ready", label: "Ready" },
  { value: "sent", label: "Sent" },
  { value: "suppressed", label: "Suppressed" },
  { value: "control", label: "Control" },
  { value: "attention", label: "Attention" },
  { value: "all", label: "All" },
];

const TONE_CLASS: Record<RecoveryTone, string> = {
  neutral: "text-muted-foreground bg-muted/40",
  positive: "text-emerald-400 bg-emerald-400/10",
  pending: "text-amber-400 bg-amber-400/10",
  warning: "text-sky-400 bg-sky-400/10",
  danger: "text-rose-400 bg-rose-400/10",
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function DmRecoveryList({ onSelect }: { onSelect: (id: string) => void }) {
  const [view, setView] = useState<RecoveryView>("ready");
  const now = new Date();

  const countsQ = useQuery<RecoveryCounts>({
    queryKey: ["recovery-reminders", "counts"],
    queryFn: () => recoveryApi.counts(),
  });

  // Health rides along with metrics rather than its own endpoint, so the banner
  // and the experiment readout can never disagree about the circuit.
  const metricsQ = useQuery<RecoveryMetrics>({
    queryKey: ["recovery-reminders", "metrics"],
    queryFn: () => recoveryApi.metrics(),
  });

  const rowsQ = useInfiniteQuery({
    // The view is part of the key: switching tabs must not show the previous
    // tab's rows under the new tab's badge.
    queryKey: ["recovery-reminders", "list", view],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ view });
      if (pageParam) params.set("cursor", pageParam);
      return recoveryApi.list(params.toString());
    },
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor,
  });

  const health = metricsQ.data?.health;
  const rows: RecoveryReminderRow[] = rowsQ.data?.pages.flatMap((p) => p.rows) ?? [];
  const total = countsQ.data?.all;

  return (
    <div className="space-y-4">
      {health?.circuitOpen ? (
        <div
          role="status"
          className="rounded-lg border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-xs text-sky-100"
        >
          <p>{CIRCUIT_PAUSED_MESSAGE}</p>
          <p className="mt-1 text-sky-200/80">
            Reason: <span className="font-medium">{health.reason ?? "unknown"}</span> · {health.dueCount} waiting
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map((v) => {
          const count = countsQ.data?.[v.value]?.records;
          return (
            <button
              key={v.value}
              type="button"
              onClick={() => setView(v.value)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                view === v.value
                  ? "border-foreground/40 bg-accent/40 text-foreground"
                  : "text-muted-foreground hover:bg-accent/20",
              )}
            >
              {v.label}
              {count !== undefined ? (
                <span className="ml-1.5 tabular-nums text-muted-foreground">{count}</span>
              ) : null}
            </button>
          );
        })}
        {total ? (
          // People and journeys are different numbers and the experiment is
          // measured by people, so neither is allowed to stand in for the other.
          <span className="ml-auto text-xs text-muted-foreground">
            {total.people} people · {total.records} journeys
          </span>
        ) : null}
      </div>

      {rowsQ.isPending ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/40" />
          ))}
        </div>
      ) : rowsQ.isError ? (
        <div className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-4 text-sm">
          <p className="text-rose-100">Couldn’t load recovery reminders.</p>
          <button
            type="button"
            onClick={() => rowsQ.refetch()}
            className="mt-2 rounded-md border px-2 py-1 text-xs hover:bg-accent/20"
          >
            Try again
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          No recovery reminders in this view.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const state = recoveryStatusView(row, now);
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => onSelect(row.id)}
                  className="flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm hover:bg-accent/20"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {row.username ? `@${row.username}` : row.igUserId}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.keyword.keyword} · {formatWhen(row.eligibleAt)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                      TONE_CLASS[state.tone],
                    )}
                  >
                    {state.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {rowsQ.hasNextPage ? (
        <button
          type="button"
          onClick={() => rowsQ.fetchNextPage()}
          disabled={rowsQ.isFetchingNextPage}
          className="w-full rounded-md border px-3 py-2 text-xs hover:bg-accent/20 disabled:opacity-50"
        >
          {rowsQ.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}
