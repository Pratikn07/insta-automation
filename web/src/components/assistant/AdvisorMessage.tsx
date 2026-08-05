import { Link } from "react-router-dom";
import { ArrowRight, Info, Lightbulb } from "lucide-react";
import type { AdvisorResponse } from "@/lib/types";
import { CONFIDENCE_LABEL } from "./advisorView";

/**
 * One advisor answer.
 *
 * Rendered in named sections rather than as prose: the owner needs to see what was
 * measured, what it means, and what to do, without reading a paragraph to find the
 * number. Confidence and data gaps are shown even when they are unflattering —
 * an answer that hides what it could not measure is worse than one that says so.
 *
 * There is deliberately no button here. This component can navigate, and nothing
 * else; every send or settings change lives behind the owner's own approval
 * elsewhere in the product.
 */
export function AdvisorMessage({ response }: { response: AdvisorResponse }) {
  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{response.answer}</p>

      <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
          <Lightbulb className="size-3.5" />
          Recommendation
        </p>
        <p className="mt-1.5 whitespace-pre-wrap text-sm">{response.recommendation}</p>
      </div>

      {response.evidence.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Why
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {response.evidence.map((item, index) => (
              <li key={`${item.label}-${index}`}>
                {item.href ? (
                  <Link
                    to={item.href}
                    className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-3 py-1 text-xs hover:bg-muted"
                  >
                    <span className="text-muted-foreground">{item.label}</span>
                    <span className="font-medium">{item.value}</span>
                  </Link>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-3 py-1 text-xs">
                    <span className="text-muted-foreground">{item.label}</span>
                    <span className="font-medium">{item.value}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Suggested next step
        </p>
        <p className="mt-1.5 text-sm">{response.nextStep}</p>
        {response.nextStepHref && (
          <Link
            to={response.nextStepHref}
            className="mt-2 inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
          >
            Open {response.nextStepHref.replace("/", "")}
            <ArrowRight className="size-3.5" />
          </Link>
        )}
      </div>

      {response.dataGaps.length > 0 && (
        <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3">
          <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Not measured
            </p>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {response.dataGaps.map((gap, index) => (
                <li key={`${gap}-${index}`}>{gap}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{CONFIDENCE_LABEL[response.confidence]}</p>
    </div>
  );
}
