import { MessageSquareReply } from "lucide-react";
import type { FunnelReport } from "@/lib/types";
import { KpiTile } from "./KpiTile";
import { KpiMeter } from "./KpiMeter";

const nf = new Intl.NumberFormat("en-US");

export interface AutomationKpiRowProps {
  funnel: FunnelReport | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

export function AutomationKpiRow({ funnel, isLoading, isError, onRetry }: AutomationKpiRowProps) {
  const evidence = !isLoading && !isError ? funnel : undefined;
  const rate = evidence?.headline.rate;
  const fraction = rate && rate.pct !== null && rate.denominator > 0
    ? rate.numerator / rate.denominator
    : null;

  return (
    <div className="bg-muted p-5 sm:p-6">
      <KpiTile
        label={evidence?.headline.label ?? "Reply rate"}
        value={rate ? rate.pct !== null ? `${rate.pct}%` : `${nf.format(rate.numerator)} of ${nf.format(rate.denominator)}` : "—"}
        context={isLoading ? null : rate
          ? `${nf.format(rate.numerator)} of ${nf.format(rate.denominator)} answered the unlock DM`
          : "Reply rate is temporarily unavailable"}
        note={rate ? `${nf.format(rate.denominator - rate.numerator)} never replied · see Funnels` : null}
        visual={fraction === null || !rate ? undefined : (
          <KpiMeter fraction={fraction} fillClassName="bg-funnel-mark"
            title={`${nf.format(rate.numerator)} of ${nf.format(rate.denominator)} answered the unlock DM`} />
        )}
        Icon={MessageSquareReply}
        tone="violet"
        isLoading={isLoading && !isError}
      />
      {isError && (
        <button type="button" onClick={onRetry}
          className="label-caps mt-3 border-b border-current pb-0.5 text-signal [@media(pointer:coarse)]:min-h-11">
          Retry reply rate
        </button>
      )}
    </div>
  );
}
