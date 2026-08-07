import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface IgUserLite {
  username?: string | null;
  name?: string | null;
}

/**
 * How to label an Instagram user in the UI: prefer @username, fall back to the
 * numeric id when we haven't resolved a username for them.
 */
export function displayUser(igUserId: string, user?: IgUserLite | null): string {
  if (user?.username) return `@${user.username}`;
  return igUserId;
}

/**
 * An absolute timestamp in the viewer's own locale and zone: "Aug 7, 9:41 AM".
 *
 * The one definition for the whole UI. Three byte-identical copies had accreted
 * (two named formatWhen, one formatAbsolute), which is how a timestamp ends up
 * rendered one way in a list and another in the drawer beside it.
 */
export function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Compact follower count: 2214 → "2,214", 18500 → "18.5K", 1200000 → "1.2M". */
export function formatFollowerCount(n?: number | null): string | null {
  if (n == null || n < 0) return null;
  if (n < 10_000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
}
