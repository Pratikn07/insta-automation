import { useMutationState } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Check, CircleAlert, Loader2, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Save-state indicator for the Sequence editor.
 *
 * Authored text is saved explicitly, while structural changes still persist
 * immediately. This combines local draft state with all mutations tagged with
 * ["sequence-save", id]:
 *   - any in flight        -> "Saving…"
 *   - validation problem   -> "Needs attention"
 *   - failed save          -> "Couldn't save"
 *   - dirty authored text  -> "Unsaved changes"
 *   - otherwise            -> "All changes saved"
 *
 * Using useMutationState (not local state) means new step rows are covered
 * automatically — no prop-drilling a save callback into each one.
 */
export function SaveStatus({
  sequenceId,
  dirty = false,
  needsAttention = false,
  saveFailed = false,
}: {
  sequenceId: string;
  dirty?: boolean;
  needsAttention?: boolean;
  saveFailed?: boolean;
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
  const errored = !saving && (saveFailed || lastSettled?.status === "error");

  const state: "saving" | "attention" | "error" | "dirty" | "saved" = saving
    ? "saving"
    : needsAttention
      ? "attention"
      : errored
        ? "error"
        : dirty
          ? "dirty"
          : "saved";

  const config = {
    saving: { icon: Loader2, label: "Saving…", cls: "text-muted-foreground", spin: true },
    attention: {
      icon: CircleAlert,
      label: "Needs attention — message too long",
      cls: "text-destructive",
      spin: false,
    },
    dirty: { icon: Pencil, label: "Unsaved changes", cls: "text-amber-600", spin: false },
    saved: { icon: Check, label: "All changes saved", cls: "text-muted-foreground", spin: false },
    error: { icon: CircleAlert, label: "Couldn't save — retry", cls: "text-destructive", spin: false },
  }[state];

  const Icon = config.icon;

  return (
    <div className="flex h-5 items-center" aria-live="polite" aria-atomic="true">
      <AnimatePresence mode="wait">
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
      </AnimatePresence>
    </div>
  );
}
