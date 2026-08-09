import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, recoveryApi } from "../../lib/api";
import type {
  Keyword,
  RecoveryCohort,
  RecoveryCounts,
  RecoveryMetrics,
  RecoveryReminderRow,
  RecoveryView,
  SettingsBlockedVerificationRecord,
} from "../../lib/types";
import { cn, formatAbsolute } from "../../lib/utils";
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

/** Percentages are the experiment's headline, so an absent one must read as
 *  absent rather than as zero. */
function pct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

export function DmRecoveryList({ onSelect }: { onSelect: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<RecoveryView>("ready");
  const [keywordId, setKeywordId] = useState<string>("");
  const [cohort, setCohort] = useState<"" | RecoveryCohort>("");
  const now = new Date();

  const keywordsQ = useQuery<Keyword[]>({
    queryKey: ["keywords"],
    queryFn: () => api<Keyword[]>("/keywords"),
  });

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

  const settingsVerificationsQ = useQuery<{ records: SettingsBlockedVerificationRecord[] }>({
    queryKey: ["recovery-reminders", "settings-verifications"],
    queryFn: () => recoveryApi.settingsVerifications(),
  });

  const activateVerificationM = useMutation({
    mutationFn: (id: string) => recoveryApi.activateSettingsVerification(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["recovery-reminders", "settings-verifications"],
      });
      await queryClient.invalidateQueries({ queryKey: ["recovery-reminders", "metrics"] });
    },
  });

  const rowsQ = useInfiniteQuery({
    // The view is part of the key: switching tabs must not show the previous
    // tab's rows under the new tab's badge.
    // Every filter belongs in the key: a narrowed result under the previous
    // filter's badge is the same lie as the wrong tab's rows.
    queryKey: ["recovery-reminders", "list", view, keywordId, cohort],
    initialPageParam: null as { cursor: string; asOf: string } | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ view });
      if (keywordId) params.set("keywordId", keywordId);
      if (cohort) params.set("cohort", cohort);
      if (pageParam) {
        params.set("cursor", pageParam.cursor);
        // The scheduled/ready split is an eligibleAt comparison against a
        // timestamp. Replaying page 1's keeps every page of this run on the same
        // boundary; letting it advance drops the rows that cross it.
        params.set("asOf", pageParam.asOf);
      }
      return recoveryApi.list(params.toString());
    },
    getNextPageParam: (last: { nextCursor: string | null; asOf: string }) =>
      last.nextCursor ? { cursor: last.nextCursor, asOf: last.asOf } : null,
  });

  const health = metricsQ.data?.health;
  const experiment = metricsQ.data?.experiment;
  const accuracy = metricsQ.data?.accuracy;
  const settingsEvidence = metricsQ.data?.settingsEvidence;
  const settingsVerificationRecords = Array.isArray(settingsVerificationsQ.data?.records)
    ? settingsVerificationsQ.data.records
    : [];
  const rows: RecoveryReminderRow[] = rowsQ.data?.pages.flatMap((p) => p.rows) ?? [];
  // The active view, not the grand total: a count that never changes as tabs
  // change is not describing what is on screen.
  const active = countsQ.data?.[view];

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
          const entry = countsQ.data?.[v.value];
          return (
            <button
              key={v.value}
              type="button"
              onClick={() => setView(v.value)}
              title={
                entry ? `${entry.people} people · ${entry.records} journeys` : undefined
              }
              aria-label={
                entry
                  ? `${v.label}: ${entry.people} people, ${entry.records} journeys`
                  : v.label
              }
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                view === v.value
                  ? "border-foreground/40 bg-accent/40 text-foreground"
                  : "text-muted-foreground hover:bg-accent/20",
              )}
            >
              {v.label}
              {entry ? (
                <span className="ml-1.5 tabular-nums text-muted-foreground">
                  {entry.people}/{entry.records}
                </span>
              ) : null}
            </button>
          );
        })}
        {active ? (
          // People and journeys are different numbers and the experiment is
          // measured by people, so neither is allowed to stand in for the other.
          <span className="ml-auto text-xs text-muted-foreground">
            {active.people} people · {active.records} journeys
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground">
          Keyword{" "}
          <select
            value={keywordId}
            onChange={(e) => setKeywordId(e.target.value)}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            <option value="">All keywords</option>
            {(keywordsQ.data ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.keyword}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Cohort{" "}
          <select
            value={cohort}
            onChange={(e) => setCohort(e.target.value as "" | RecoveryCohort)}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            <option value="">Both cohorts</option>
            <option value="treatment">Treatment</option>
            <option value="control">Control</option>
          </select>
        </label>
      </div>

      {experiment && accuracy ? (
        // The cohort split only pays for itself if the comparison is visible.
        <dl className="grid grid-cols-2 gap-3 rounded-lg border px-3 py-2 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Treatment 48h</dt>
            <dd className="tabular-nums">
              {pct(experiment.treatment.completionRate48h)}{" "}
              <span className="text-muted-foreground">
                ({experiment.treatment.eligiblePeople} people)
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Control 48h</dt>
            <dd className="tabular-nums">
              {pct(experiment.control.completionRate48h)}{" "}
              <span className="text-muted-foreground">
                ({experiment.control.eligiblePeople} people)
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Lift</dt>
            <dd className="tabular-nums">
              {experiment.absoluteLiftPercentagePoints === null
                ? "—"
                : `${experiment.absoluteLiftPercentagePoints.toFixed(1)} pp`}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Read-event coverage</dt>
            <dd className="tabular-nums">{pct(accuracy.readEventCoverage)}</dd>
          </div>
        </dl>
      ) : null}

      {settingsEvidence ? (
        <p className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Settings verification · </span>
          {settingsEvidence.current} current ·{" "}
          {settingsEvidence.stale + settingsEvidence.retired + settingsEvidence.missing} invalid settings evidence
        </p>
      ) : null}

      {settingsVerificationRecords.length > 0 ? (
        <section className="space-y-2 rounded-lg border px-3 py-2 text-xs">
          <h3 className="font-semibold">Settings verification registry</h3>
          <ul className="space-y-1">
            {settingsVerificationRecords.map((record) => (
              <li key={record.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{record.version}</span>
                <span className="text-muted-foreground">
                  {record.graphCode}:{record.graphSubcode} · {record.status}
                </span>
                {record.status === "inactive" ? (
                  <button
                    type="button"
                    aria-label={`Activate ${record.version}`}
                    disabled={activateVerificationM.isPending}
                    onClick={() => activateVerificationM.mutate(record.id)}
                    className="ml-auto rounded-md border px-2 py-1 hover:bg-accent/20 disabled:opacity-50"
                  >
                    Activate
                  </button>
                ) : record.status === "stale" || record.status === "retired" ? (
                  <span className="ml-auto text-rose-200">Activation blocked</span>
                ) : (
                  <span className="ml-auto text-emerald-300">Active</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
              // The post link is a sibling of the row button, not a child: an
              // anchor inside a button is invalid, and nesting it would make the
              // link swallow or trigger the row selection.
              <li key={row.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                <button
                  type="button"
                  onClick={() => onSelect(row.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left text-sm"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {row.username ? `@${row.username}` : row.igUserId}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.keyword.keyword} · {formatAbsolute(row.eligibleAt)}
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
                  {row.triggerKind === "settings_blocked" &&
                  row.settingsEvidence &&
                  row.settingsEvidence.status !== "current" ? (
                    <span className="shrink-0 rounded-full bg-rose-400/10 px-2 py-0.5 text-xs font-medium text-rose-300">
                      {row.settingsEvidence.status === "missing"
                        ? "Evidence missing"
                        : row.settingsEvidence.status === "stale"
                          ? "Evidence stale"
                          : "Evidence retired"}
                    </span>
                  ) : null}
                </button>
                {row.media.permalink ? (
                  <a
                    href={row.media.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-xs underline text-muted-foreground"
                  >
                    View post
                  </a>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    Original post unavailable
                  </span>
                )}
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
