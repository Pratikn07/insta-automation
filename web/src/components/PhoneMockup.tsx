import { motion, AnimatePresence } from "framer-motion";
import { FileText } from "lucide-react";
import type { ResourceMessage } from "@/lib/types";

interface PhoneMockupProps {
  gateMessage?: string;
  doneEcho?: boolean;
  steps: ResourceMessage[];
  accountName?: string;
}

export function PhoneMockup({
  gateMessage,
  doneEcho = true,
  steps,
  accountName = "tinysoho",
}: PhoneMockupProps) {
  return (
    <div className="mx-auto w-full max-w-[320px]">
      <div className="rounded-[2.5rem] border-[10px] border-neutral-800 bg-neutral-900 shadow-2xl">
        <div className="flex items-center justify-between rounded-t-[2rem] bg-neutral-950 px-5 pt-3 pb-2">
          <div className="text-[10px] font-medium text-neutral-300">9:41</div>
          <div className="flex items-center gap-1 text-neutral-400">
            <span className="size-1 rounded-full bg-neutral-400" />
            <span className="size-1 rounded-full bg-neutral-400" />
            <span className="size-1 rounded-full bg-neutral-400" />
          </div>
        </div>
        <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-4 py-2.5">
          <div className="flex size-8 items-center justify-center rounded-full bg-brand-gradient text-[10px] font-semibold text-white">
            {accountName.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div className="text-[12px] font-semibold text-neutral-100">{accountName}</div>
            <div className="text-[10px] text-neutral-500">Active now</div>
          </div>
        </div>
        <div className="flex max-h-[480px] min-h-[420px] flex-col gap-2 overflow-y-auto bg-neutral-950 px-3 py-4">
          {gateMessage && <IncomingBubble text={gateMessage} />}
          {gateMessage && doneEcho && <OutgoingBubble text="DONE" />}
          <AnimatePresence initial={false}>
            {steps.length === 0 && !gateMessage ? (
              <div className="my-auto px-2 text-center text-[11px] text-neutral-500">
                Add steps to see how the DM thread will look.
              </div>
            ) : (
              steps.map((step, i) => (
                <motion.div
                  key={step.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, delay: i * 0.03 }}
                >
                  <StepBubble step={step} />
                </motion.div>
              ))
            )}
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-2 rounded-b-[2rem] border-t border-neutral-800 bg-neutral-950 px-3 py-2">
          <div className="flex-1 rounded-full bg-neutral-800 px-3 py-1.5 text-[11px] text-neutral-500">
            Message…
          </div>
        </div>
      </div>
    </div>
  );
}

function IncomingBubble({ text }: { text: string }) {
  return (
    <div className="flex max-w-[80%] flex-col">
      <div className="rounded-2xl rounded-bl-sm bg-neutral-800 px-3 py-2 text-[12px] leading-snug text-neutral-100 whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

function OutgoingBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto flex max-w-[80%] flex-col">
      <div className="rounded-2xl rounded-br-sm bg-blue-600 px-3 py-2 text-[12px] leading-snug text-white">
        {text}
      </div>
    </div>
  );
}

function StepBubble({ step }: { step: ResourceMessage }) {
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

  return (
    <IncomingBubble text={step.body ?? "(empty step)"} />
  );
}
