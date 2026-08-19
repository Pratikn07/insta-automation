import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Lock } from "lucide-react";
import { apiMutation, apiRead } from "@/lib/api";
import { outcomeMessage } from "@/lib/unknownOutcome";
import type { FlagGroup, FlagView, FlagsResponse } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Grouped by blast radius, loudest first.
 *
 * These sixteen are not peers. Reply drafts cannot reach anyone; recovery
 * reminders post public comments on real reels. A list sorted by name puts those
 * two side by side and implies they carry the same weight — and the top group is
 * the one you open during an incident, so it belongs at the top.
 */
const GROUPS: { key: FlagGroup; heading: string }[] = [
  { key: "outbound", heading: "Reaches real people" },
  { key: "experiment", heading: "Measuring something" },
  { key: "assistive", heading: "Nothing leaves the app" },
  { key: "infrastructure", heading: "Not a product choice" },
];

type FlagChange = { key: string; valueBool?: boolean; valuePercent?: number };

export function Flags() {
  const queryClient = useQueryClient();

  const query = useQuery<FlagsResponse>({
    queryKey: ["flags"],
    queryFn: ({ signal }) => apiRead<FlagsResponse>("/flags", { signal }),
  });

  const change = useMutation({
    mutationFn: ({ key, ...value }: FlagChange) =>
      apiMutation<FlagView>(`/flags/${key}`, {
        method: "PATCH",
        body: JSON.stringify(value),
      }),
    // Settled, not success: after an unknown outcome the list is still the only
    // thing that can say what is in force. The response never decides.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["flags"] }),
  });

  const all = query.data?.flags ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Things we&apos;re testing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every switch in the system, what it does, and what changes if you turn it off.
        </p>
      </div>

      {change.error && (
        <p role="alert" className="rounded-md bg-urgent-soft px-3 py-2 text-[13px] text-urgent">
          {outcomeMessage(
            change.error,
            change.error instanceof Error
              ? change.error.message
              : "That change did not save.",
          )}
        </p>
      )}

      {query.isLoading ? (
        <div className="space-y-2 border-t pt-3">
          <Skeleton className="h-16 rounded-md" />
          <Skeleton className="h-16 rounded-md" />
        </div>
      ) : query.isError ? (
        <p className="border-t py-4 text-[13px] text-muted-foreground">
          Couldn&apos;t load your switches — the API did not answer. This is a connection
          problem, not an empty list.{" "}
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="underline underline-offset-2 [@media(pointer:coarse)]:min-h-11"
          >
            Try again
          </button>
        </p>
      ) : (
        GROUPS.map(({ key, heading }) => {
          const rows = all.filter((entry) => entry.group === key);
          if (rows.length === 0) return null;
          return (
            <section key={key}>
              <h2 className="label-caps border-b border-line pb-1.5">{heading}</h2>
              <ul>
                {rows.map((entry) => (
                  <FlagRow
                    key={entry.key}
                    flag={entry}
                    busy={change.isPending && change.variables?.key === entry.key}
                    onChange={(value) => change.mutate({ key: entry.key, ...value })}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

function FlagRow({
  flag,
  busy,
  onChange,
}: {
  flag: FlagView;
  busy: boolean;
  onChange: (value: { valueBool?: boolean; valuePercent?: number }) => void;
}) {
  const live =
    flag.kind === "boolean" ? flag.valueBool === true : (flag.valuePercent ?? 0) > 0;

  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b py-4">
      <div className="min-w-[18rem] flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{flag.name}</span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium",
              live ? "bg-signal-soft text-signal" : "bg-muted text-muted-foreground",
            )}
          >
            {flag.kind === "percent"
              ? `${flag.valuePercent ?? 0}%`
              : live
                ? "Live"
                : "Off"}
          </span>
        </div>

        <p className="mt-1.5 max-w-[70ch] text-[13px] text-muted-foreground">
          {flag.doesWhat}
        </p>
        <p className="mt-1 max-w-[70ch] text-[13px] text-muted-foreground">
          <span className="text-foreground">Who it affects:</span> {flag.affectsWho}
        </p>
        <p className="mt-1 max-w-[70ch] text-[13px] text-muted-foreground">
          <span className="text-foreground">If you turn it off:</span> {flag.ifOff}
        </p>

        {flag.driftsFromEnv && (
          <p className="mt-2 inline-flex items-start gap-1.5 rounded-md bg-caution-soft px-2.5 py-1.5 text-[12.5px] text-caution">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
            Saved here, but a restart would change this back to the deployed value.
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {flag.kind === "percent" && flag.pageMayEnable ? (
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            defaultValue={flag.valuePercent ?? 0}
            disabled={busy}
            aria-label={flag.name}
            onMouseUp={(event) =>
              onChange({ valuePercent: Number((event.target as HTMLInputElement).value) })
            }
            onKeyUp={(event) =>
              onChange({ valuePercent: Number((event.target as HTMLInputElement).value) })
            }
          />
        ) : flag.pageMayEnable && flag.pageMayStop ? (
          <Switch
            checked={flag.valueBool === true}
            disabled={busy}
            aria-label={flag.name}
            onCheckedChange={(checked) => onChange({ valueBool: checked })}
          />
        ) : flag.pageMayStop && live ? (
          // Off in one click; on is a deploy. So the worst this page can do, if it
          // is wrong, is make the system quieter.
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={`Stop ${flag.name}`}
            onClick={() => onChange({ valueBool: false })}
          >
            {busy ? "Stopping…" : "Stop now"}
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Lock className="size-3.5" aria-hidden />
            changed in Railway
          </span>
        )}
      </div>
    </li>
  );
}
