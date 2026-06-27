import { FileText } from "lucide-react";
import type { ResourceMessage } from "@/lib/types";

// Shared Instagram-style chat bubbles, used by both the PhoneMockup preview and
// the per-user lineage thread. Incoming = from the business account (bot);
// Outgoing = from the user.

export function IncomingBubble({ text }: { text: string }) {
  return (
    <div className="flex max-w-[80%] flex-col">
      <div className="rounded-2xl rounded-bl-sm bg-neutral-800 px-3 py-2 text-[12px] leading-snug text-neutral-100 whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

export function OutgoingBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto flex max-w-[80%] flex-col">
      <div className="rounded-2xl rounded-br-sm bg-blue-600 px-3 py-2 text-[12px] leading-snug text-white">
        {text}
      </div>
    </div>
  );
}

export function StepBubble({ step }: { step: ResourceMessage }) {
  if (step.type === "text") {
    return <IncomingBubble text={step.body ?? ""} />;
  }

  if (step.type === "image" && step.mediaUrl) {
    return (
      <div className="flex max-w-[80%] flex-col gap-1">
        <img
          src={step.mediaUrl}
          alt=""
          className="rounded-2xl rounded-bl-sm border border-neutral-800 object-cover"
        />
        {step.body && (
          <div className="rounded-2xl rounded-bl-sm bg-neutral-800 px-3 py-2 text-[12px] leading-snug text-neutral-100 whitespace-pre-wrap">
            {step.body}
          </div>
        )}
      </div>
    );
  }

  if (step.type === "pdf") {
    return (
      <div className="flex max-w-[80%] flex-col gap-1">
        <a
          href={step.mediaUrl ?? "#"}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-neutral-800 px-3 py-2 text-[12px] text-neutral-100"
        >
          <FileText className="size-4 shrink-0 text-neutral-400" />
          <span className="truncate">{step.mediaUrl?.split("/").pop() ?? "document.pdf"}</span>
        </a>
        {step.body && (
          <div className="rounded-2xl rounded-bl-sm bg-neutral-800 px-3 py-2 text-[12px] leading-snug text-neutral-100 whitespace-pre-wrap">
            {step.body}
          </div>
        )}
      </div>
    );
  }

  return <IncomingBubble text={step.body ?? "(empty step)"} />;
}
