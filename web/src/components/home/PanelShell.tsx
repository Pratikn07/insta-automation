import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared shell + empty state for the Home panels. The accent colour and icon
// come in as props, so several panels once shared it verbatim; FollowerFlowPanel
// is the only remaining consumer since the Home declutter.
//
// Maison removed the card. What was a filled, rounded, shadowed panel is now a
// hairline and space: the chart sits directly on the page ground, which is what
// lets the ivory read as paper rather than as a container full of widgets.

export function PanelShell({
  children,
  className,
  tall = false,
}: {
  children: React.ReactNode;
  className?: string;
  // Empty/error states still want a generous box; the populated chart panel is
  // much shorter than the old all-in-one panel and a 600px floor left a gap.
  //
  // 360px, not 520: a floor that tall pushed the country table off the first
  // screen whenever the chart was empty, which is exactly when a reader most
  // wants the rest of the page.
  tall?: boolean;
}) {
  return (
    <section className={cn("border-t pt-5", tall && "min-h-[360px]", className)}>
      {children}
    </section>
  );
}

export function EmptyPanel({
  title,
  body,
  action,
  Icon,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
  Icon: LucideIcon;
  /** Retained for callers; Maison tints the mark with the house accent instead. */
  accentClassName?: string;
}) {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center px-6 text-center">
      <Icon className="size-5 text-gold-text" aria-hidden />
      <h2 className="font-display mt-3 text-xl">{title}</h2>
      <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
