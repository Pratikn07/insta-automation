import type { DropOffSummary } from "@/lib/types";

// Did they ignore the DM, or never see it? Opposite problems, opposite fixes.
//
// The third segment is the whole reason this component is careful. 1,107 of the
// non-repliers were never tracked for read receipts, so nothing can be
// concluded about them. Giving that segment a hue would let the chart claim
// "1,663 people ignored you" — a finding the data does not support. It gets a
// neutral, and the legend says "unknown, not unseen" in as many words.
//
// The number that DOES carry weight is confirmedSeenOfTracked: of the 620 we
// can actually judge, 90% were never confirmed read.

const SEGMENTS = [
  {
    key: "confirmedSeen" as const,
    label: "confirmed read",
    gloss: "they saw it",
    color: "var(--color-funnel-soft)",
  },
  {
    key: "trackedNeverConfirmed" as const,
    label: "tracked, never confirmed",
    gloss: "likely unseen",
    color: "var(--color-funnel-mark)",
  },
  {
    key: "noReadData" as const,
    label: "no read data",
    gloss: "unknown, not unseen",
    color: "var(--color-funnel-unknown)",
  },
];

export function EvidenceBar({ evidence }: { evidence: DropOffSummary["readEvidence"] }) {
  const total =
    evidence.confirmedSeen + evidence.trackedNeverConfirmed + evidence.noReadData;

  if (total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No conversations in this bucket to read evidence from.
      </p>
    );
  }

  return (
    <div>
      <div
        className="mb-4 flex h-8 gap-0.5 overflow-hidden rounded-sm"
        role="img"
        aria-label={SEGMENTS.map((s) => `${evidence[s.key].toLocaleString()} ${s.label}`).join(", ")}
      >
        {SEGMENTS.map((s) => {
          const value = evidence[s.key];
          if (value === 0) return null;
          return (
            <div
              key={s.key}
              className="min-w-[3px]"
              style={{ width: `${(value / total) * 100}%`, background: s.color }}
            />
          );
        })}
      </div>

      <ul className="flex list-none flex-wrap gap-x-7 gap-y-2 p-0">
        {SEGMENTS.map((s) => (
          <li key={s.key} className="flex items-baseline gap-2.5 text-[13px]">
            <span
              aria-hidden
              className="size-2.5 shrink-0 translate-y-px rounded-[2px]"
              style={{ background: s.color }}
            />
            <span>
              <span className="font-semibold tabular-nums">
                {evidence[s.key].toLocaleString()}
              </span>{" "}
              {s.label}{" "}
              <span className="text-xs text-muted-foreground">— {s.gloss}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
