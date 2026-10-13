import type { GuardedRate, LinkClickResult } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";

function pct(rate: GuardedRate): string {
  return rate.pct === null ? "—" : `${rate.pct}%`;
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-md bg-card/40 p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-medium tabular-nums">{value}</dd>
      <dd className="mt-0.5 text-xs text-muted-foreground">{sub}</dd>
    </div>
  );
}

function rateSub(rate: GuardedRate, noun: string): string {
  return rate.belowMinSample ? "Too few to say" : `${rate.numerator} of ${rate.denominator} ${noun}`;
}

/** Link guides only. A separate panel so a failure here can't take the gated funnel down. */
export function LinkClickPanel({
  data,
  isLoading,
  isError,
}: {
  data: LinkClickResult | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  const sent = data?.stages.find((stage) => stage.key === "linkSent")?.count ?? 0;

  return (
    <section className="space-y-4 border-t border-t-line pt-8">
      <div>
        <p className="label-caps">Link guides · Comment → link click</p>
        <h2 className="mt-1 text-lg font-medium">Who opened the page</h2>
      </div>

      {isError ? (
        <p className="text-sm text-muted-foreground">
          Couldn't load link clicks. The rest of this page is unaffected.
        </p>
      ) : isLoading || !data ? (
        <Skeleton className="h-32 w-full rounded-lg" />
      ) : data.cohortSize === 0 ? (
        <p className="text-sm text-muted-foreground">No link guide has been asked for in this window.</p>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-3">
            <Stat label="Links sent" value={String(sent)} sub={`${data.cohortSize} asked`} />
            <Stat label={data.headline.label} value={pct(data.headline.rate)} sub={rateSub(data.headline.rate, "links")} />
            <Stat
              label="Following ~3 days after tapping"
              value={pct(data.followedAnyway)}
              sub={rateSub(data.followedAnyway, "rechecked")}
            />
          </dl>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-2 font-medium">Post</th>
                <th className="py-2 text-right font-medium">Asked</th>
                <th className="py-2 text-right font-medium">Sent</th>
                <th className="py-2 text-right font-medium">Opened</th>
                <th className="py-2 text-right font-medium">Click rate</th>
              </tr>
            </thead>
            <tbody>
              {data.byReel.map((reel) => (
                <tr key={reel.mediaId ?? "unknown"} className="border-t border-t-line">
                  <td className="py-2 font-mono text-xs">{reel.mediaId ?? "Unknown post"}</td>
                  <td className="py-2 text-right tabular-nums">{reel.entered}</td>
                  <td className="py-2 text-right tabular-nums">{reel.linkSent}</td>
                  <td className="py-2 text-right tabular-nums">{reel.clicked}</td>
                  <td className="py-2 text-right tabular-nums">{pct(reel.clickRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
