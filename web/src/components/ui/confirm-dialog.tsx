import { AnimatePresence, motion } from "framer-motion";
import * as React from "react";
import { Button } from "./button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive,
  onConfirm,
  onCancel,
  busy,
}: ConfirmDialogProps) {
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const cancelButtonRef = React.useRef<HTMLButtonElement>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const onCancelRef = React.useRef(onCancel);
  const busyRef = React.useRef(busy);
  const wasBusyRef = React.useRef(busy);
  const titleId = React.useId();
  const descriptionId = React.useId();

  React.useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  React.useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const dismiss = React.useCallback(() => {
    if (busyRef.current) {
      dialogRef.current?.focus();
      return;
    }
    onCancelRef.current();
  }, []);

  React.useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (cancelButtonRef.current && !cancelButtonRef.current.disabled) {
      cancelButtonRef.current.focus();
    } else {
      dialogRef.current?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    };
  }, [open, dismiss]);

  React.useEffect(() => {
    if (!open) {
      wasBusyRef.current = busy;
      return;
    }
    if (busy) {
      dialogRef.current?.focus();
    } else if (wasBusyRef.current && cancelButtonRef.current && !cancelButtonRef.current.disabled) {
      cancelButtonRef.current.focus();
    }
    wasBusyRef.current = busy;
  }, [open, busy]);

  const trapFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={dismiss}
        >
          <motion.div
            initial={{ y: 8, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 8, opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            ref={dialogRef}
            tabIndex={-1}
            onKeyDown={trapFocus}
          >
            <h3 id={titleId} className="text-base font-semibold tracking-tight">{title}</h3>
            {description && (
              <p id={descriptionId} className="mt-2 text-sm text-muted-foreground">{description}</p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button ref={cancelButtonRef} variant="ghost" onClick={dismiss} disabled={busy}>
                {cancelLabel}
              </Button>
              <Button
                variant={destructive ? "destructive" : "default"}
                onClick={onConfirm}
                disabled={busy}
              >
                {busy ? "Working…" : confirmLabel}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
