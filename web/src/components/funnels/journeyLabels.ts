import type { QuietBucket, WallBucket } from "@/lib/types";

// One wording for each leak bucket, shared by the breakdown and the "see who" table, so a
// person listed under a reason reads exactly like the reason they were counted under.

export const QUIET_BUCKET_LABELS: Record<QuietBucket, string> = {
  still_has_time: "Still has time (card sent in the last 24 hours)",
  wrote_not_yes: "Wrote to us, but not as a yes",
  opened_ignored: "Opened the card and ignored it",
  no_sign_opened: "No sign they opened it",
  cannot_tell: "Can't tell (card sent before read tracking began, Oct 5)",
};

export const WALL_BUCKET_LABELS: Record<WallBucket, string> = {
  still_has_time: "Still has time",
  said_followed: "Said they followed, Instagram says no",
  never_came_back: "Never came back",
};

/** Bucket order is the order a person is judged in: first match wins. */
export const QUIET_BUCKET_ORDER: QuietBucket[] = [
  "still_has_time",
  "wrote_not_yes",
  "opened_ignored",
  "no_sign_opened",
  "cannot_tell",
];
export const WALL_BUCKET_ORDER: WallBucket[] = ["still_has_time", "said_followed", "never_came_back"];
