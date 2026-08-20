import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Lock } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { apiMutation, apiRead } from "@/lib/api";
import { outcomeMessage } from "@/lib/unknownOutcome";
import type { FlagView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

/**
 * One switch: what it does, what is in force, and the only control over it.
 *
 * Fetched by key rather than filtered out of the cached list, so a bookmarked URL
 * works before the list has ever been opened.
 *
 * The control lives here and not on the list on purpose. Off is one click and on
 * needs a deploy; that asymmetry only means something if stopping is a deliberate
 * act, and a stop button in a list you are scanning is not one.
 */
export function SwitchDetail() {
  const { key = "" } = useParams();
  const queryClient = useQueryClient();

  const query = useQuery<FlagView>({
    queryKey: ["flags", key],
    queryFn: ({ signal }) => apiRead<FlagView>(`/flags/${key}`, { signal }),
  });

  const change = useMutation({
    mutationFn: (value: { valueBool?: boolean; valuePercent?: number }) =>
      apiMutation<FlagView>(`/flags/${key}`, {
        method: "PATCH",
        body: JSON.stringify(value),
      }),
    // Settled, not success: after an unknown outcome the read is still the only
    // thing that can say what is in force. The response never decides.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["flags"] });
    },
  });

  const flag = query.data;

  return (
    <div className="space-y-5">
      <Link
        to="/switches"
        className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Switches
      </Link>

      {query.isLoading ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : query.isError || !flag ? (
        <p className="text-[13px] text-muted-foreground">
          Couldn&apos;t load this switch — the API did not answer. This is a connection
          problem, not a missing switch.
        </p>
      ) : (
        <>
          <div>
            <h1 className="text-2xl font-medium tracking-tight">{flag.name}</h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{flag.key}</p>
          </div>

          {change.error && (
            <p role="alert" className="rounded-md bg-urgent-soft px-3 py-2 text-[13px] text-urgent">
              {outcomeMessage(
                change.error,
                change.error instanceof Error ? change.error.message : "That did not save.",
              )}
            </p>
          )}

          {/* The three questions, always the same three. The third is the one an
              operator actually needs and the one nobody thinks to write down. */}
          <div className="space-y-3 rounded-lg bg-signal-soft px-4 py-3.5">
            <p className="text-[14.5px] leading-relaxed">{flag.doesWhat}</p>
            <p className="text-[13.5px] leading-relaxed">
              <span className="font-medium">Who it affects:</span> {flag.affectsWho}
            </p>
            <p className="text-[13.5px] leading-relaxed">
              <span className="font-medium">If you turn it off:</span> {flag.ifOff}
            </p>
          </div>

          <dl className="grid grid-cols-[170px_1fr] gap-y-2 text-[13.5px]">
            <dt className="text-muted-foreground">In force now</dt>
            <dd>
              {flag.kind === "percent"
                ? `${flag.valuePercent ?? 0}%`
                : flag.valueBool
                  ? "On"
                  : "Off"}
              {flag.source === "override" ? " · saved here" : " · from the deployed value"}
            </dd>
            {flag.experimentKey && flag.experimentName && (
              <>
                <dt className="text-muted-foreground">Part of</dt>
                <dd>
                  <Link
                    to={`/experiments/${flag.experimentKey}`}
                    className="text-signal underline underline-offset-2"
                  >
                    {flag.experimentName}
                  </Link>
                </dd>
              </>
            )}
          </dl>

          {flag.driftsFromEnv && (
            <p className="inline-flex items-start gap-1.5 rounded-md bg-caution-soft px-3 py-2 text-[13px] text-caution">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
              Saved here, but a restart would change this back to the deployed value.
            </p>
          )}

          <div className="border-t pt-4">
            {flag.kind === "percent" && flag.pageMayEnable ? (
              <label className="flex items-center gap-3 text-[13px]">
                <span className="text-muted-foreground">Rollout</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  defaultValue={flag.valuePercent ?? 0}
                  disabled={change.isPending}
                  aria-label={flag.name}
                  className="w-48 accent-signal"
                  onMouseUp={(event) =>
                    change.mutate({
                      valuePercent: Number((event.target as HTMLInputElement).value),
                    })
                  }
                />
              </label>
            ) : flag.pageMayEnable && flag.pageMayStop ? (
              <label className="flex items-center gap-3 text-[13px]">
                <Switch
                  checked={flag.valueBool === true}
                  disabled={change.isPending}
                  aria-label={flag.name}
                  onCheckedChange={(checked) => change.mutate({ valueBool: checked })}
                />
                <span className="text-muted-foreground">{flag.valueBool ? "On" : "Off"}</span>
              </label>
            ) : flag.pageMayStop && flag.valueBool ? (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  disabled={change.isPending}
                  aria-label={`Stop ${flag.name}`}
                  onClick={() => change.mutate({ valueBool: false })}
                >
                  {change.isPending ? "Stopping…" : "Stop now"}
                </Button>
                <p className="text-[12.5px] text-muted-foreground">
                  Turning this back on needs a deploy, on purpose.
                </p>
              </div>
            ) : (
              <p className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <Lock className="size-3.5" aria-hidden />
                changed in Railway
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
