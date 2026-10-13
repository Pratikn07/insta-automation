import { Link2, Lock } from "lucide-react";
import type { DeliveryMode } from "@/lib/types";

/** Gated or Link, wherever a guide is listed. A missing mode is a guide from before links. */
export function DeliveryBadge({ mode }: { mode: DeliveryMode | undefined }) {
  const isLink = mode === "link";
  const Icon = isLink ? Link2 : Lock;
  return (
    <span
      className={
        isLink
          ? "inline-flex items-center gap-1 rounded-full bg-signal-soft px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-signal"
          : "inline-flex items-center gap-1 rounded-full border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
      }
    >
      <Icon className="size-2.5" aria-hidden="true" />
      {isLink ? "Link" : "Gated"}
    </span>
  );
}
