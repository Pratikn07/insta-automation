import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

// Shared shell + empty state for the full-height Home panels. Was duplicated
// verbatim in AudienceGrowthPanel and RepeatReelsPanel, differing only in the
// accent color and icon — those come in as props now.

export function PanelShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("min-h-[600px] rounded-2xl border-white/10 bg-card/85 shadow-xl shadow-black/10", className)}>
      <CardContent className="p-5 sm:p-6">{children}</CardContent>
    </Card>
  );
}

export function EmptyPanel({
  title,
  body,
  action,
  Icon,
  accentClassName,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
  Icon: LucideIcon;
  accentClassName: string; // e.g. "bg-emerald-400/10 text-emerald-300"
}) {
  return (
    <div className="flex min-h-[540px] flex-col items-center justify-center px-6 text-center">
      <div className={cn("mb-4 flex size-12 items-center justify-center rounded-2xl", accentClassName)}>
        <Icon className="size-6" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
