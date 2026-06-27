import { motion, AnimatePresence } from "framer-motion";
import type { ResourceMessage } from "@/lib/types";
import { IncomingBubble, OutgoingBubble, StepBubble } from "./ChatBubbles";

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
