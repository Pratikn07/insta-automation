import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  MessageCircle,
  RotateCw,
  Tag,
  User,
} from "lucide-react";
import { useState } from "react";
import { DmRecoveryList } from "../components/conversations/DmRecoveryList";
import { DmRecoveryDrawer } from "../components/conversations/DmRecoveryDrawer";
import { journeyRowMarkers } from "../components/conversations/journeyRowMarkers";
import { api } from "@/lib/api";
import type {
  Conversation,
  ConversationCounts,
  ConversationState,
  DmThreadRow,
  AiCapabilities,
  Paginated,
  ResourceMessage,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { UserLineage } from "@/components/UserLineage";
import { IncomingBubble, OutgoingBubble, StepBubble } from "@/components/ChatBubbles";
import { DmThreadList } from "@/components/conversations/DmThreadList";
import { DmThreadDrawer } from "@/components/conversations/DmThreadDrawer";
import { cn, displayUser, formatAbsolute } from "@/lib/utils";
import { prettyKind } from "@/lib/eventLog";

type StateFilter = ConversationState | "all";
type HistoryMode = "canonical" | "raw";

// Two lenses on the same page. The DM views show the REAL message thread with its
// approval surface; the journey views are the existing keyword→gate→guide funnel,
// unchanged. Kept side by side rather than replaced, because a journey row and a
// DM thread answer different questions.
type Lens = "needs_reply" | "dms" | "recovery" | "journeys";

// Plain-English tab labels. "DONE" is internal jargon (the word the user types) —
// a marketer tracks outcomes: who's waiting, who got it, and who we never got a
// confirmed reply from — which is not the same as who chose not to answer.
const FILTERS: { value: StateFilter; label: string; countKey?: keyof ConversationCounts }[] = [
  { value: "all", label: "All" },
  { value: "awaiting_done", label: "Waiting", countKey: "awaiting_done" },
  { value: "completed", label: "Delivered", countKey: "completed" },
  // Not "No reply": a journey can end here because the gate DM never landed,
  // which is not the same as the person choosing not to answer.
  { value: "expired", label: "No confirmed reply", countKey: "expired" },
];

const stateMeta: Record<ConversationState, { label: string; tone: string; Icon: typeof Clock }> = {
  awaiting_done: { label: "Waiting for reply", tone: "text-amber-400 bg-amber-400/10", Icon: Clock },
  completed: { label: "Delivered", tone: "text-emerald-400 bg-emerald-400/10", Icon: CheckCircle2 },
  expired: {
    label: "No confirmed reply",
    tone: "text-muted-foreground bg-muted/40",
    Icon: AlertCircle,
  },
};

// The "we couldn't reach them yet — auto-retrying" row style. Deliberately calm
// (sky, not red): for almost everyone this self-heals and needs no action, so it
// reads as a status, not an alarm. Distinct from the amber "their turn" badge.
const RETRYING_META = {
  label: "Couldn’t message — retrying",
  tone: "text-sky-400 bg-sky-400/10",
  Icon: RotateCw,
};

// What badge does this row get? Within "Waiting", a still-bouncing gate means the
// DM never landed — so it is NOT the user's turn. Surface that instead of the
// generic amber "Waiting for reply".
function rowBadge(c: Conversation): { label: string; tone: string; Icon: typeof Clock } {
  if (c.state === "awaiting_done" && c.delivery === "retrying") return RETRYING_META;
  return stateMeta[c.state];
}

export function Conversations() {
  const [lens, setLens] = useState<Lens>("needs_reply");
  const [filter, setFilter] = useState<StateFilter>("all");
  const [historyMode, setHistoryMode] = useState<HistoryMode>("canonical");
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [lineageUser, setLineageUser] = useState<string | null>(null);
  const [selectedRecoveryId, setSelectedRecoveryId] = useState<string | null>(null);

  const dmScope = lens === "needs_reply" ? "needs_reply" : "all";
  const dmThreadsQ = useQuery<Paginated<DmThreadRow>>({
    queryKey: ["dm-threads", dmScope],
    queryFn: () => api<Paginated<DmThreadRow>>(`/dm-threads?scope=${dmScope}`),
    enabled: lens === "needs_reply" || lens === "dms",
  });

  const capabilitiesQ = useQuery<AiCapabilities>({
    queryKey: ["ai-capabilities"],
    queryFn: () => api<AiCapabilities>("/ai/capabilities"),
    enabled: lens !== "journeys",
  });

  const conversationsQ = useInfiniteQuery({
    queryKey: ["conversations", historyMode, filter],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set("mode", historyMode);
      if (filter !== "all") params.set("state", filter);
      if (pageParam) params.set("cursor", pageParam);
      return api<Paginated<Conversation>>(`/conversations?${params.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Only the journeys lens renders these rows. Without this the page fetched
    // journey pages — and paged through them — while showing Needs reply or DM
    // recovery.
    enabled: lens === "journeys",
  });

  // Tab counts so the page reads like a dashboard ("Waiting 416 · Delivered 351").
  const countsQ = useQuery<ConversationCounts>({
    queryKey: ["conversation-counts", historyMode],
    queryFn: () => api<ConversationCounts>(`/conversations/counts?mode=${historyMode}`),
  });
  const counts = countsQ.data;

  const items = conversationsQ.data?.pages.flatMap((p) => p.items) ?? [];
  const isLoading = conversationsQ.isLoading;

  // In the Waiting views, float the "couldn't reach — retrying" rows to the top so
  // the handful that aren't really the user's turn don't hide among hundreds of
  // genuine waits. Stable: keeps server recency order within each group.
  const showRetryingFirst = filter === "awaiting_done" || filter === "all";
  const orderedItems = showRetryingFirst
    ? [...items].sort(
        (a, b) => Number(isRetrying(b)) - Number(isRetrying(a)),
      )
    : items;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Conversations</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every comment that triggered a keyword. Click a row to see the full event log.
        </p>
      </div>

      {lens === "journeys" && (
        <div className="flex items-center gap-2" aria-label="Journey history mode">
          <span className="text-xs text-muted-foreground">History</span>
          {(
            [
              { value: "canonical", label: "Canonical" },
              { value: "raw", label: "Raw history" },
            ] as const
          ).map((mode) => (
            <button
              key={mode.value}
              type="button"
              onClick={() => setHistoryMode(mode.value)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium",
                historyMode === mode.value
                  ? "border-foreground/40 bg-accent/40 text-foreground"
                  : "text-muted-foreground hover:bg-accent/20",
              )}
            >
              {mode.label}
            </button>
          ))}
        </div>
      )}

      {/* Primary lens: real DMs first, since those are the ones a person is
          waiting on. The journey filters stay exactly as they were, under their
          own label, so nothing about the existing workflow moves. */}
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            { value: "needs_reply", label: "Needs reply" },
            { value: "dms", label: "DMs" },
            { value: "recovery", label: "DM recovery" },
          ] as const
        ).map((l) => (
          <button
            key={l.value}
            onClick={() => setLens(l.value)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              lens === l.value
                ? "border-foreground/40 bg-accent/40 text-foreground"
                : "text-muted-foreground hover:bg-accent/20",
            )}
            type="button"
          >
            {l.label}
          </button>
        ))}
        <span className="ml-2 text-xs text-muted-foreground">Automation journeys</span>
        {FILTERS.map((f) => {
          const count = f.countKey ? counts?.[f.countKey] : undefined;
          return (
            <button
              key={f.value}
              onClick={() => {
                setLens("journeys");
                setFilter(f.value);
              }}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                lens === "journeys" && filter === f.value
                  ? "border-foreground/40 bg-accent/40 text-foreground"
                  : "text-muted-foreground hover:bg-accent/20",
              )}
              type="button"
            >
              {f.label}
              {count != null && (
                <span className="ml-1.5 tabular-nums text-muted-foreground">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Calm heads-up when some gates haven't landed. Most auto-heal, so this is
          informational, not an alarm — and it only shows when relevant. */}
      {counts != null && counts.retrying > 0 && (filter === "awaiting_done" || filter === "all") && (
        <div className="flex items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-300">
          <RotateCw className="mt-0.5 size-3.5 shrink-0" />
          <span>
            We couldn’t message{" "}
            <span className="font-medium">
              {counts.retrying} {counts.retrying === 1 ? "person" : "people"}
            </span>{" "}
            automatically yet — we’re retrying on our own. No action needed.
          </span>
        </div>
      )}

      {lens === "recovery" ? (
        <div className="mt-4">
          <DmRecoveryList onSelect={setSelectedRecoveryId} />
        </div>
      ) : lens !== "journeys" ? (
        <DmThreadList
          rows={dmThreadsQ.data?.items ?? []}
          isLoading={dmThreadsQ.isLoading}
          onSelect={(row) => setSelectedThreadId(row.id)}
        />
      ) : isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<MessageCircle className="size-5" />}
          title="No conversations yet"
          description="When someone comments a keyword on one of your reels, it shows up here."
        />
      ) : (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {orderedItems.map((c, i) => (
              <motion.li
                key={c.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, delay: Math.min(i * 0.015, 0.3) }}
              >
                <ConversationRow c={c} onClick={() => setSelected(c)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {conversationsQ.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="ghost"
            onClick={() => conversationsQ.fetchNextPage()}
            disabled={conversationsQ.isFetchingNextPage}
          >
            {conversationsQ.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title="Conversation"
        description={
          selected
            ? `${displayUser(selected.igUserId, selected)} · ${formatRelative(selected.createdAt)}`
            : undefined
        }
      >
        {selected && (
          <ConversationDetail
            conversationId={selected.id}
            onOpenUser={(id) => setLineageUser(id)}
          />
        )}
      </Drawer>

      <Drawer
        open={selectedRecoveryId !== null}
        onClose={() => setSelectedRecoveryId(null)}
        title="DM recovery reminder"
      >
        {selectedRecoveryId && (
          <DmRecoveryDrawer
            id={selectedRecoveryId}
            onClose={() => setSelectedRecoveryId(null)}
            onOpenUser={(id) => setLineageUser(id)}
          />
        )}
      </Drawer>

      <Drawer
        open={lineageUser !== null}
        onClose={() => setLineageUser(null)}
        title="User journey"
      >
        {lineageUser && <UserLineage igUserId={lineageUser} />}
      </Drawer>

      {/* sendEnabled is decided server-side by AI_SEND_ENABLED; the route answers
          403 ai_send_disabled regardless, so this only governs the button state. */}
      <DmThreadDrawer
        threadId={selectedThreadId}
        sendEnabled={capabilitiesQ.data?.sendEnabled === true}
        onClose={() => setSelectedThreadId(null)}
      />
    </div>
  );
}

function isRetrying(c: Conversation): boolean {
  return c.state === "awaiting_done" && c.delivery === "retrying";
}

function ConversationRow({ c, onClick }: { c: Conversation; onClick: () => void }) {
  const meta = rowBadge(c);
  const markers = journeyRowMarkers(c);
  return (
    <Card className="group transition-colors hover:bg-accent/40">
      <CardContent className="p-0">
        <button
          type="button"
          onClick={onClick}
          className="flex w-full items-center gap-4 p-4 text-left"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <User className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">
                {c.username ? `@${c.username}` : c.igUserId}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <Tag className="size-3" />
                {c.keyword.keyword}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatRelative(c.createdAt)}
              {c.completedAt && ` · completed ${formatRelative(c.completedAt)}`}
            </p>
            {c.historyRole === "alias" && (
              <p className="mt-0.5 text-[11px] text-amber-300">
                Alias history · canonical owner {c.canonicalOwner?.id ?? "unknown"}
              </p>
            )}
            {/* An old journey has no receipts because none were ever collected.
                Without this the older half of the table reads as failures. */}
            {markers.note && (
              <p className="mt-0.5 text-[11px] text-muted-foreground/80">{markers.note}</p>
            )}
          </div>
          {markers.recovery && (
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                markers.recovery.pending
                  ? "bg-sky-400/10 text-sky-400"
                  : "bg-muted/40 text-muted-foreground",
              )}
            >
              {markers.recovery.label}
            </span>
          )}
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium",
              meta.tone,
            )}
          >
            <meta.Icon className="size-3" />
            {meta.label}
          </span>
        </button>
      </CardContent>
    </Card>
  );
}

export interface EventLogItem {
  id: string;
  kind: string;
  payload: unknown;
  createdAt: string;
}

interface GateRetry {
  status: string;
  attempts: number;
  nextAttemptAt: string;
  commentAt: string;
  lastError: string | null;
}

interface ConversationDetailResponse {
  conversation: Conversation & {
    keyword: {
      id: string;
      keyword: string;
      publicReply: string;
      gateMessage: string;
      resource: { id: string; name: string; messages: ResourceMessage[] };
    };
  };
  events: EventLogItem[];
  entry: "comment" | "dm";
  inboundText: string | null;
  gate: GateRetry | null;
}

// ---- Journey model -----------------------------------------------------------
//
// Every conversation walks a fixed funnel. We reconstruct each step's status from
// the event log and render the ACTUAL message (theirs or ours) as a chat bubble.
// "comment" entry has a public-reply step; "dm" entry (user DM'd the keyword
// first) skips it. A step is done/failed/pending; pending steps show no bubble.

type StepStatus = "done" | "failed" | "pending";

interface JourneyStep {
  n: number;
  label: string;
  status: StepStatus;
  at?: string;
  // The message to show under the step, if any.
  bubble?: { side: "user" | "bot"; text: string } | null;
  steps?: ResourceMessage[]; // for the freebie delivery step
  note?: string; // e.g. "couldn't send — retrying"
}

function hasKind(events: EventLogItem[], kind: string): EventLogItem | undefined {
  return events.find((e) => e.kind === kind);
}

function buildJourney(data: ConversationDetailResponse): JourneyStep[] {
  const { conversation, events, entry, inboundText } = data;
  const kw = conversation.keyword;
  const freebie = kw.resource.name;

  const matched = hasKind(events, "keyword_matched");
  const publicSent = hasKind(events, "public_reply_sent");
  const publicFailed = hasKind(events, "public_reply_failed");
  const dmSent = hasKind(events, "dm_sent");
  const dmFailed = hasKind(events, "dm_failed");
  const doneRcv = hasKind(events, "done_received");
  const seqDone = hasKind(events, "sequence_completed");
  const seqFailed = hasKind(events, "sequence_failed");

  const steps: JourneyStep[] = [];
  let n = 1;

  // 1. They reached out — via comment or via DM.
  steps.push({
    n: n++,
    label:
      entry === "comment"
        ? `Commented “${kw.keyword}” on your reel`
        : `Messaged you “${kw.keyword}”`,
    status: matched ? "done" : "pending",
    at: matched?.createdAt,
    bubble: inboundText ? { side: "user", text: inboundText } : null,
  });

  // 2. Public reply on the comment (comment entry only).
  if (entry === "comment") {
    steps.push({
      n: n++,
      label: "You replied on the comment",
      status: publicSent ? "done" : publicFailed ? "failed" : "pending",
      at: (publicSent ?? publicFailed)?.createdAt,
      bubble: { side: "bot", text: kw.publicReply },
      note: publicFailed ? "couldn’t post the public reply" : undefined,
    });
  }

  // 3. The gate DM with the freebie instructions.
  steps.push({
    n: n++,
    label: "We DM’d them the instructions",
    status: dmSent ? "done" : dmFailed ? "failed" : "pending",
    at: (dmSent ?? dmFailed)?.createdAt,
    bubble: { side: "bot", text: kw.gateMessage },
    note: dmFailed && !dmSent ? "couldn’t send — see above" : undefined,
  });

  // 4. They reply DONE.
  steps.push({
    n: n++,
    label: "They reply DONE",
    status: doneRcv ? "done" : "pending",
    at: doneRcv?.createdAt,
    bubble: doneRcv ? { side: "user", text: "DONE" } : null,
  });

  // 5. We deliver the freebie.
  steps.push({
    n,
    label: `We send the ${freebie}`,
    status: seqDone ? "done" : seqFailed ? "failed" : "pending",
    at: (seqDone ?? seqFailed)?.createdAt,
    steps: seqDone ? kw.resource.messages : undefined,
    note: seqFailed ? "delivery failed" : undefined,
  });

  return steps;
}

// One plain-English sentence describing the whole situation at a glance.
function summaryLine(data: ConversationDetailResponse): { text: string; tone: StepStatus } {
  const { conversation, gate } = data;
  const who = conversation.username ? `@${conversation.username}` : "this person";
  const freebie = conversation.keyword.resource.name;

  if (conversation.state === "completed") {
    return { text: `${who} replied DONE and got the ${freebie}. 🎉`, tone: "done" };
  }
  if (conversation.state === "expired") {
    return {
      text: `No reply was confirmed from ${who}, so the ${freebie} wasn’t sent.`,
      tone: "pending",
    };
  }
  // awaiting_done
  if (gate && (gate.status === "pending" || gate.status === "exhausted")) {
    if (gate.status === "exhausted") {
      return {
        text: `We couldn’t reach ${who} within Instagram’s 7-day window, so the DM didn’t go through.`,
        tone: "failed",
      };
    }
    return { text: `We couldn’t DM ${who} yet — retrying automatically. No action needed.`, tone: "failed" };
  }
  return { text: `Waiting for ${who} to reply DONE so we can send the ${freebie}.`, tone: "pending" };
}

function ConversationDetail({
  conversationId,
  onOpenUser,
}: {
  conversationId: string;
  onOpenUser: (igUserId: string) => void;
}) {
  const [showTech, setShowTech] = useState(false);
  const detailQ = useQuery<ConversationDetailResponse>({
    queryKey: ["conversation-detail", conversationId],
    queryFn: () => api<ConversationDetailResponse>(`/conversations/${conversationId}/events`),
  });

  if (detailQ.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (detailQ.error || !detailQ.data) {
    return <p className="text-sm text-destructive">Could not load conversation.</p>;
  }

  const data = detailQ.data;
  const { conversation, events, gate } = data;
  const journey = buildJourney(data);
  const summary = summaryLine(data);

  return (
    <div className="space-y-5">
      {/* Header: who + at-a-glance summary */}
      <div className="rounded-md border bg-card/40 p-4">
        <button
          type="button"
          onClick={() => onOpenUser(conversation.igUserId)}
          className="min-w-0 truncate text-left hover:underline"
          title="View this user's full journey"
        >
          {conversation.username ? (
            <span className="text-sm font-medium">@{conversation.username}</span>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">{conversation.igUserId}</span>
          )}
        </button>
        <p
          className={cn(
            "mt-2 text-sm",
            summary.tone === "done" && "text-emerald-400",
            summary.tone === "failed" && "text-amber-400",
            summary.tone === "pending" && "text-foreground",
          )}
        >
          {summary.text}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Keyword <span className="font-mono">{conversation.keyword.keyword}</span> · started{" "}
          {formatAbsolute(conversation.createdAt)}
        </p>
      </div>

      {/* Retry reassurance card — only when a gate DM is queued/failed */}
      {gate && (gate.status === "pending" || gate.status === "exhausted") && (
        <GateRetryCard gate={gate} />
      )}

      {/* The journey */}
      <div>
        <h4 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          What happened
        </h4>
        <ol className="space-y-4">
          {journey.map((step) => (
            <JourneyRow key={step.n} step={step} />
          ))}
        </ol>
      </div>

      {/* Technical details — collapsed by default, for support */}
      <div className="border-t pt-3">
        <button
          type="button"
          onClick={() => setShowTech((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", showTech && "rotate-180")} />
          Technical details (for support)
        </button>
        {showTech && (
          <div className="mt-3">
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events recorded yet.</p>
            ) : (
              <ol className="relative space-y-3 border-l border-border pl-5">
                {events.map((e) => (
                  <EventRow key={e.id} event={e} showKindRaw />
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const STATUS_DOT: Record<StepStatus, string> = {
  done: "bg-emerald-500 text-white",
  failed: "bg-amber-500 text-white",
  pending: "border border-border bg-muted text-muted-foreground",
};

function JourneyRow({ step }: { step: JourneyStep }) {
  const dim = step.status === "pending";
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
          STATUS_DOT[step.status],
        )}
      >
        {step.status === "done" ? (
          <Check className="size-3" />
        ) : step.status === "failed" ? (
          <AlertTriangle className="size-3" />
        ) : (
          step.n
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("text-sm font-medium", dim && "text-muted-foreground")}>
            {step.label}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {step.status === "pending" ? "—" : step.at ? formatAbsolute(step.at) : ""}
          </span>
        </div>
        {step.note && (
          <p className="mt-0.5 text-xs text-amber-400">{step.note}</p>
        )}

        {/* Bubble(s) under the step */}
        {step.bubble && (
          <div className="mt-2 flex">
            {step.bubble.side === "user" ? (
              <OutgoingBubble text={step.bubble.text} />
            ) : (
              <div className={cn(step.status === "failed" && "opacity-50")}>
                <IncomingBubble text={step.bubble.text} />
              </div>
            )}
          </div>
        )}
        {step.steps && step.steps.length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {step.steps.map((s) => (
              <StepBubble key={s.id} step={s} />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function GateRetryCard({ gate }: { gate: GateRetry }) {
  const exhausted = gate.status === "exhausted";
  const windowCloses = new Date(
    new Date(gate.commentAt).getTime() + 7 * 24 * 60 * 60 * 1000,
  );
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex items-start gap-2">
        <RotateCw className={cn("mt-0.5 size-4 shrink-0 text-amber-400", !exhausted && "animate-none")} />
        <div className="text-sm">
          {exhausted ? (
            <p className="text-amber-300">
              Instagram only allows auto-DMs for 7 days after a comment, and that window has
              closed — so this DM couldn’t be delivered.
            </p>
          ) : (
            <>
              <p className="font-medium text-amber-300">
                We couldn’t DM them automatically — but we’re retrying.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Instagram temporarily limited how many auto-DMs this account can send, so this one
                was held back. We’ll keep retrying as the limit frees up — no action needed from you.
              </p>
              <p className="mt-2 text-xs text-amber-300/90">
                Attempt {gate.attempts + 1} · next try {formatRelativeFuture(gate.nextAttemptAt)} ·
                retrying until {formatAbsolute(windowCloses.toISOString())}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const FAILURE_KINDS = new Set([
  "dm_failed",
  "public_reply_failed",
  "sequence_failed",
  "error",
]);

/**
 * A single event in a timeline. Failure events render in destructive styling and
 * surface the numeric Instagram subcode inline. Provider messages are excluded
 * because they can echo request text or account/token details.
 */
export function EventRow({
  event,
  showKindRaw,
  userLabel,
  userId,
  onUserClick,
}: {
  event: EventLogItem;
  showKindRaw?: boolean;
  userLabel?: string | null;
  userId?: string | null;
  onUserClick?: (igUserId: string) => void;
}) {
  const isFailure = FAILURE_KINDS.has(event.kind);
  const detail = failureDetail(event.payload);

  return (
    <li className="relative">
      <span
        className={cn(
          "absolute -left-[26px] top-1 size-2.5 rounded-full",
          isFailure ? "bg-destructive" : "bg-brand-gradient",
        )}
      />
      <div className={cn("text-sm font-medium", isFailure && "text-destructive")}>
        {prettyKind(event.kind)}
        {userLabel &&
          (userId && onUserClick ? (
            <button
              type="button"
              onClick={() => onUserClick(userId)}
              className="ml-2 text-xs font-normal text-muted-foreground hover:underline"
            >
              {userLabel}
            </button>
          ) : (
            <span className="ml-2 text-xs font-normal text-muted-foreground">{userLabel}</span>
          ))}
        {showKindRaw && (
          <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">
            {event.kind}
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground">{formatAbsolute(event.createdAt)}</div>
      {detail && (
        <div className="mt-1 rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          <span className="font-mono">subcode {detail.subcode}</span>
        </div>
      )}
    </li>
  );
}

function failureDetail(payload: unknown): { subcode: number } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const subcode =
    typeof p.graphSubcode === "number"
      ? p.graphSubcode
      : typeof p.subcode === "number"
        ? p.subcode
        : null;
  return subcode === null ? null : { subcode };
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Like formatRelative but phrased forward ("in 5m"); clamps past times to "shortly".
function formatRelativeFuture(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "shortly";
  const min = Math.round(diff / 60000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const days = Math.round(hr / 24);
  return `in ${days}d`;
}
