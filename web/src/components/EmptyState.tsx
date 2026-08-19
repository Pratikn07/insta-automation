import { motion, useReducedMotion } from "framer-motion";
import { RefreshCw } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

/**
 * Nothing is here, and that is the truth.
 *
 * Use this only when the request succeeded and returned nothing. If it failed,
 * use <LoadFailed> — see the note there for why the difference matters more in
 * this product than in most.
 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  const still = useReducedMotion();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: still ? 0 : 0.2 }}
      className="border-t px-6 py-14 text-center"
    >
      <div className="mx-auto flex size-8 items-center justify-center text-signal">{icon}</div>
      <h3 className="mt-3 text-[15px] font-medium tracking-tight">{title}</h3>
      {description && (
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </motion.div>
  );
}

/**
 * The request failed. Say so.
 *
 * This exists because the same words were being used for both states across the
 * console: a dead API rendered as "No guides yet" on an account with 60, and
 * as "Awaiting first snapshot" against 48 unbroken days of follower geography.
 * Both cost real debugging time, and both are the product contradicting its own
 * first principle — unknown is not nothing.
 *
 * One component so the distinction cannot quietly erode again: any page that
 * fetches owns three outcomes, and this is the middle one.
 */
export function LoadFailed({
  what,
  onRetry,
}: {
  /** What could not be loaded, lower case: "your posts", "this guide". */
  what: string;
  onRetry: () => void;
}) {
  return (
    <div className="border-t px-6 py-14 text-center">
      <h3 className="text-[15px] font-medium tracking-tight">Couldn&rsquo;t load {what}</h3>
      <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
        The request did not come back. This is a connection problem, not an empty account —
        nothing has been lost.
      </p>
      <Button variant="outline" size="sm" className="mt-5" onClick={onRetry}>
        <RefreshCw className="size-3.5" />
        Try again
      </Button>
    </div>
  );
}
