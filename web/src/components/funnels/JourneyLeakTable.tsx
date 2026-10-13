import type { GuideJourneyLeakRow, QuietBucket, WallBucket } from "@/lib/types";
import { QUIET_BUCKET_LABELS, WALL_BUCKET_LABELS } from "./journeyLabels";

// The people behind one leak, newest first: the freshest are the ones still worth acting
// on. One row per person, however many reels they commented on.

function formatAsked(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) +
    ", " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  );
}

function bucketLabel(bucket: QuietBucket | WallBucket, leak: "quiet" | "wall"): string {
  return leak === "quiet"
    ? QUIET_BUCKET_LABELS[bucket as QuietBucket]
    : WALL_BUCKET_LABELS[bucket as WallBucket];
}

export function JourneyLeakTable({
  rows,
  leak,
}: {
  rows: GuideJourneyLeakRow[];
  leak: "quiet" | "wall";
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed bg-card/30 px-4 py-6 text-center text-sm text-muted-foreground">
        Nobody in this leak for the selected window.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[620px] border-collapse text-[13px]">
        <thead>
          <tr>
            {["Account", "Last keyword", "Cards", "Last asked", "Why"].map((h) => (
              <th
                key={h}
                className="whitespace-nowrap border-b bg-card/60 px-3.5 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-[0.1em] text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.igUserId} className="border-b last:border-b-0">
              <td className="px-3.5 py-3 font-mono text-[12.5px]">
                {row.username ?? <span className="text-muted-foreground">unresolved</span>}
              </td>
              <td className="px-3.5 py-3 font-mono text-[11.5px] text-muted-foreground">
                {row.lastKeyword ?? "—"}
              </td>
              <td className="px-3.5 py-3 tabular-nums">{row.cards}</td>
              <td className="whitespace-nowrap px-3.5 py-3 tabular-nums text-muted-foreground">
                {formatAsked(row.lastAskedAt)}
              </td>
              <td className="px-3.5 py-3 text-muted-foreground">{bucketLabel(row.bucket, leak)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
