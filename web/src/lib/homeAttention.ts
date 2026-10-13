import { largestMeasuredFunnelLoss } from "./todaysRead";
import type { GuideFollowResult, Stats } from "./types";

const nf = new Intl.NumberFormat("en-US");

export type AttentionKind =
  | "upcoming_needs_attention"
  | "uncertain_gate_sends"
  | "failed_gates"
  | "funnel_loss"
  | "conversations_awaiting";

export interface AttentionItem {
  kind: AttentionKind;
  title: string;
  detail: string;
  tag: "Now" | "Today" | "Watch";
  to: string;
  action: string;
}

export type HomeSource = "stats" | "funnel";

export type SourceState<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "success"; data: T };

export type HomeAttentionState =
  | { status: "checking" }
  | { status: "ready_with_attention"; items: AttentionItem[] }
  | { status: "ready_clear"; items: [] }
  | { status: "incomplete"; failedSources: HomeSource[]; items: AttentionItem[] };

export interface HomeSources {
  stats: SourceState<Stats>;
  funnel: SourceState<GuideFollowResult>;
}

export function deriveAttentionItems(
  stats: Stats | undefined,
  funnel: GuideFollowResult | undefined,
): AttentionItem[] {
  const items: AttentionItem[] = [];

  // First, which makes it Home's "Best next move" whenever it exists.
  //
  // Every other item here is automation running badly. This one is automation not
  // running: the post is live, its keyword never attached, and everybody who
  // comments gets nothing until she changes one word. It is also the only item on
  // this list she can finish in ten seconds.
  if (stats?.upcomingNeedsAttention) {
    const many = stats.upcomingNeedsAttention > 1;
    items.push({
      kind: "upcoming_needs_attention",
      title: many
        ? `${nf.format(stats.upcomingNeedsAttention)} keywords didn't attach to your new posts`
        : "A keyword didn't attach to your new post",
      detail: many
        ? "Those posts published, but their captions didn't match the words you set up, so nothing is being sent to anyone commenting on them."
        : "The post published, but its caption didn't match the word you set up, so nothing is being sent to anyone commenting on it.",
      tag: "Now",
      to: "/content",
      action: "Fix",
    });
  }

  if (stats?.gateQueueSendUncertain) {
    items.push({
      kind: "uncertain_gate_sends",
      title: `Check ${nf.format(stats.gateQueueSendUncertain)} uncertain gate sends`,
      detail:
        "The DM may already have landed, so these are never retried automatically. Each one is a person who may never have received their gate.",
      tag: "Now",
      to: "/activity",
      action: "Open",
    });
  }

  if (stats?.gateQueueExhausted) {
    items.push({
      kind: "failed_gates",
      title: `${nf.format(stats.gateQueueExhausted)} gate deliveries gave up`,
      detail: "Retries ran out inside the 7-day window. These people asked and never got a reply.",
      tag: "Now",
      to: "/activity",
      action: "Review",
    });
  }

  if (funnel) {
    const loss = largestMeasuredFunnelLoss(funnel);
    if (loss) {
      items.push({
        kind: "funnel_loss",
        title: `Inspect the ${loss.fromLabel.toLowerCase()} → ${loss.toLabel.toLowerCase()} loss`,
        detail: `${nf.format(loss.lost)} of ${nf.format(loss.denominator)} conversations stop here — the largest measured loss in the journey. What causes it is not yet measured.`,
        tag: "Today",
        to: "/funnels",
        action: "Inspect",
      });
    }
  }

  if (stats?.conversationsAwaiting) {
    items.push({
      kind: "conversations_awaiting",
      title: `${nf.format(stats.conversationsAwaiting)} conversations awaiting a reply`,
      detail: "Waiting on the follower's side. Worth a look if the number keeps climbing.",
      tag: "Watch",
      to: "/conversations",
      action: "Open",
    });
  }

  return items;
}

export function deriveHomeAttentionState(sources: HomeSources): HomeAttentionState {
  const entries = [
    ["stats", sources.stats],
    ["funnel", sources.funnel],
  ] as const;
  const failedSources = entries
    .filter(([, source]) => source.status === "error")
    .map(([name]) => name);

  const stats = sources.stats.status === "success" ? sources.stats.data : undefined;
  const funnel = sources.funnel.status === "success" ? sources.funnel.data : undefined;
  const items = deriveAttentionItems(stats, funnel);

  if (failedSources.length > 0) {
    return { status: "incomplete", failedSources, items };
  }
  if (entries.some(([, source]) => source.status === "loading")) {
    return { status: "checking" };
  }
  if (items.length > 0) {
    return { status: "ready_with_attention", items };
  }
  return { status: "ready_clear", items: [] };
}
