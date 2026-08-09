import { useMutationState } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Check, CircleAlert, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Live autosave indicator for the Sequence editor.
 *
 * The editor has no Save button — every change persists on blur/drop/upload.
 * This watches ALL mutations tagged with ["sequence-save", id] and reflects
 * their combined state so the user always knows whether their work is saved:
 *   - any in flight        -> "Saving…"
 *   - most recent errored   -> "Couldn't save"
 *   - otherwise             -> "All changes saved"
 *
 * Using useMutationState (not local state) means new step rows are covered
 * automatically — no prop-drilling a save callback into each one.
 */
export function SaveStatus({
  sequenceId,
  needsAttention = false,
}: {
  sequenceId: string;
  needsAttention?: boolean;
}) {
  const states = useMutationState({
    filters: { mutationKey: ["sequence-save", sequenceId] },
    select: (m) => ({ status: m.state.status, submittedAt: m.state.submittedAt }),
  });

  const saving = states.some((s) => s.status === "pending");
  // Most recently submitted settled mutation decides saved-vs-error.
  const lastSettled = states
    .filter((s) => s.status === "success" || s.status === "error")
    .sort((a, b) => b.submittedAt - a.submittedAt)[0];
  const errored = !saving && lastSettled?.status === "error";

  // Nothing has happened yet this session — stay silent rather than claim "saved".
  const hasActivity = states.length > 0;

  const state: "saving" | "attention" | "error" | "saved" | "idle" = saving
    ? "saving"
    : needsAttention
      ? "attention"
    : errored
      ? "error"
      : hasActivity
        ? "saved"
        : "idle";

  const config = {
    saving: { icon: Loader2, label: "Saving…", cls: "text-muted-foreground", spin: true },
    attention: {
      icon: CircleAlert,
      label: "Needs attention — message too long",
      cls: "text-destructive",
      spin: false,
    },
    saved: { icon: Check, label: "All changes saved", cls: "text-muted-foreground", spin: false },
    error: { icon: CircleAlert, label: "Couldn't save — retry", cls: "text-destructive", spin: false },
    idle: { icon: Check, label: "", cls: "text-muted-foreground", spin: false },
  }[state];

  const Icon = config.icon;

  return (
    <div className="flex h-5 items-center" aria-live="polite" aria-atomic="true">
      <AnimatePresence mode="wait">
        {state !== "idle" && (
          <motion.span
            key={state}
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 2 }}
            transition={{ duration: 0.15 }}
            className={cn("flex items-center gap-1.5 text-xs", config.cls)}
          >
            <Icon className={cn("size-3.5", config.spin && "animate-spin")} />
            {config.label}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
