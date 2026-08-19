/**
 * How long an experiment's window has left, in words.
 *
 * Shared by the list and the detail page so one reads "3 days left" and the other
 * cannot read "2 days left" from the same timestamp.
 *
 * Deliberately never negative. A closed window that counts backwards looks like it
 * is still running, and this particular window closing is the moment reminders stop
 * without announcing it.
 */
const DAY_MS = 86_400_000;

export function windowRemaining(endsAt: string | null): string | null {
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "already closed";

  // Floor, not ceil. Rounding up called two hours remaining "1 day left", which is
  // the wrong direction to be wrong about a window that stops sending when it shuts.
  const days = Math.floor(ms / DAY_MS);
  if (days === 0) return "less than a day left";
  return days === 1 ? "1 day left" : `${days} days left`;
}

/** Whole people, with thousands separators. Never a rate. */
export function people(count: number): string {
  return count.toLocaleString("en-US");
}
