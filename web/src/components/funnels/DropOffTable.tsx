import { cn } from "@/lib/utils";
import type { DropOffRow } from "@/lib/types";

// The actionable half. A funnel that only reports percentages tells you a step
// is bad and stops; this names the people sitting in it, with the evidence
// needed to decide what to do about each one.
//
// Recovery status and read state are the two columns that matter: a suppressed
// reminder with reason "audience_out_of_market" is working as designed, while a
// sent reminder that was never confirmed read is the same deliverability
// problem the whole page is about.

const STATE_LABEL: Record<string, string> = {
  awaiting_done: "awaiting reply",
  expired: "expired",
  completed: "completed",
};

function formatEntered(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) +
    ", " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function recoveryLabel(row: DropOffRow): string {
  if (!row.recoveryStatus) return "no reminder";
  if (row.recoveryStatus === "suppressed" && row.suppressionReason) {
    return `suppressed · ${row.suppressionReason.replace(/_/g, " ")}`;
  }
  return row.recoveryStatus.replace(/_/g, " ");
}

export function DropOffTable({ rows }: { rows: DropOffRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed bg-card/30 px-4 py-8 text-center text-sm text-muted-foreground">
        Nobody in this bucket for the selected window.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[720px] border-collapse text-[13px]">
        <thead>
          <tr>
            {["Account", "Keyword", "Entered", "State", "Recovery", "Arm", "Read"].map((h) => (
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
            <tr key={row.conversationId} className="border-b last:border-b-0">
              <td className="px-3.5 py-3 font-mono text-[12.5px]">
                {row.username ?? <span className="text-muted-foreground">unresolved</span>}
              </td>
              <td className="px-3.5 py-3 font-mono text-[11.5px] text-muted-foreground">
                {row.keyword}
              </td>
              <td className="whitespace-nowrap px-3.5 py-3 tabular-nums text-muted-foreground">
                {formatEntered(row.enteredAt)}
              </td>
              <td className="px-3.5 py-3">{STATE_LABEL[row.state] ?? row.state}</td>
              <td className="px-3.5 py-3">
                <Pill>{recoveryLabel(row)}</Pill>
              </td>
              <td className="px-3.5 py-3 text-muted-foreground">{row.recoveryArm ?? "—"}</td>
              <td className="px-3.5 py-3">
                {row.seenAt ? (
                  <Pill>confirmed</Pill>
                ) : (
                  <Pill tone="unknown">not confirmed</Pill>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "unknown";
}) {
  return (
    <span
      className={cn(
        "inline-block whitespace-nowrap rounded-sm border px-2.5 py-0.5 text-[11px] font-medium",
        tone === "unknown"
          ? "border-urgent/40 bg-urgent/5 text-caution"
          : "text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
