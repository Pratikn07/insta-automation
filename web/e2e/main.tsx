import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DmThreadDrawer } from "@/components/conversations/DmThreadDrawer";
import { Assistant } from "@/pages/Assistant";
import { Conversations } from "@/pages/Conversations";
import "../src/index.css";

/**
 * Test-only harness for the Playwright journeys.
 *
 * It mounts the REAL components — no reimplementation — and replaces only
 * `window.fetch` with deterministic handlers for the exact `/api/dm-threads` and
 * `/api/ai` paths the tests touch. Anything else 404s loudly rather than silently
 * passing, so a journey cannot appear to work against a route that does not exist.
 *
 * This file is never imported by src/main.tsx and index.html does not reference
 * e2e/index.html, so none of it reaches the production bundle.
 */

const THREAD = {
  id: "thread-1",
  igUserId: "ig-user-1",
  username: "geri",
  name: "Geri",
  needsReply: true,
  latestInboundMessageId: "message-2",
  lastMessageAt: "2026-08-04T10:05:00.000Z",
  messages: [
    {
      id: "message-1",
      direction: "inbound" as const,
      text: "My 2 year old fights every bedtime. Any ideas?",
      type: "text" as const,
      source: "instagram_user",
      mediaUrl: null,
      instagramTimestamp: "2026-08-04T10:00:00.000Z",
    },
    {
      id: "message-2",
      direction: "inbound" as const,
      text: "Sorry — she also wakes at 5am!",
      type: "text" as const,
      source: "instagram_user",
      mediaUrl: null,
      instagramTimestamp: "2026-08-04T10:05:00.000Z",
    },
  ],
  draft: {
    id: "draft-1",
    kind: "reply" as const,
    status: "pending_approval" as const,
    revision: 1,
    suggestedText: "Bedtime battles at two are so common 💛 Try dimming the lights an hour before.",
    workingText: "Bedtime battles at two are so common 💛 Try dimming the lights an hour before.",
    approvedText: null,
    rationale: "Answers the question directly and offers one concrete step.",
    confidence: "high",
    warnings: [],
    errorCode: null,
    errorMessage: null,
    retryAt: null,
    inboundMessageId: "message-2",
    sourceConversationId: null,
    eligibleAt: "2026-08-04T10:06:00.000Z",
    expiresAt: null,
    promptVersion: 2,
    promptPolicyCurrent: true,
    sourceGuide: null,
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    createdAt: "2026-08-04T10:06:00.000Z",
  },
};

const FOLLOW_UP = {
  ...THREAD.draft,
  id: "follow-up-1",
  kind: "engagement_follow_up" as const,
  sourceConversationId: "conversation-1",
  inboundMessageId: "message-2",
  eligibleAt: "2026-08-05T22:00:00.000Z",
  expiresAt: "2026-08-06T09:15:00.000Z",
  suggestedText: "How did bedtime go after trying the guide?",
  workingText: "How did bedtime go after trying the guide?",
  rationale: "References the delivered guide and asks one easy question.",
  sourceGuide: {
    name: "Toddler Sleep Guide",
    description: "A gentle bedtime routine guide.",
    kind: "guide",
    keyword: "SLEEP",
  },
};

const ADVISOR_ANSWER = {
  answer:
    "Reach is fine; the drop-off is between reach and follow. Your SLEEP keyword pulls the most DMs but the follow-up goes unanswered.",
  recommendation: "Improve the SLEEP follow-up before adding any new keywords.",
  evidence: [
    { label: "Needs reply", value: "3 threads", href: "/conversations" as const },
    { label: "Top keyword", value: "SLEEP — 14 triggers", href: null },
  ],
  confidence: "high" as const,
  nextStep: "Open Conversations and clear the needs-reply queue.",
  nextStepHref: "/conversations" as const,
  dataGaps: ["Circle joins are not instrumented, so community conversion is unknown."],
};

// --- captured request state ---------------------------------------------------
// The approve journey asserts on the EXACT bytes the component sent, so the body
// is captured verbatim and published to the DOM via a subscription.

let capturedBody = "";
let sentText = "";
let approved = false;
let windowClosed = false;
let hydrationRefreshes = 0;
let staleReplyDraftCreated = false;
const listeners = new Set<() => void>();

function capture(body: string): void {
  capturedBody = body;
  for (const listener of listeners) listener();
}

function publish(body: string): void {
  capture(body);
  try {
    sentText = String((JSON.parse(body) as { workingText?: unknown }).workingText ?? "");
  } catch {
    sentText = "";
  }
  approved = true;
}

function useCapturedBody(): string {
  const [value, setValue] = useState(capturedBody);
  useEffect(() => {
    const listener = () => setValue(capturedBody);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  return value;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}


// ── DM recovery fixtures ──────────────────────────────────────────────────
//
// Fixed ISO timestamps so labels ("late", "ready") are deterministic rather
// than relative to when the suite happens to run. POSTs mutate this state, so a
// cancellation genuinely changes the next GET instead of being asserted only at
// the network boundary.

const RECOVERY_CANCELLED = new Set<string>();
const RECOVERY_REVIEWED = new Set<string>();

function recoveryRow(over: Record<string, unknown> = {}) {
  return {
    id: "recovery-1",
    conversationId: "convo-1",
    igUserId: "ig-user-1",
    username: "sarah",
    name: "Sarah",
    keyword: { id: "kw-1", keyword: "SLEEP" },
    media: { id: "media-1", permalink: "https://instagram.com/p/sleep", caption: "Sleep reel" },
    triggerKind: "no_confirmed_read",
    status: "waiting",
    cohort: "treatment",
    acceptedAt: "2026-08-06T00:00:00.000Z",
    eligibleAt: "2026-08-06T10:00:00.000Z",
    seenAt: null,
    engagedAt: null,
    firstEngagementKind: null,
    suppressionReason: null,
    sentAt: null,
    attempts: 0,
    lastAttemptAt: null,
    lastErrorCategory: null,
    reviewedAt: null,
    createdAt: "2026-08-05T23:00:00.000Z",
    ...over,
  };
}

const RECOVERY_ROWS: Record<string, Record<string, unknown>[]> = {
  "recovery-ready": [recoveryRow()],
  "recovery-seen": [
    recoveryRow({ status: "suppressed", suppressionReason: "seen", seenAt: "2026-08-06T09:00:00.000Z" }),
  ],
  "recovery-replied": [
    recoveryRow({
      status: "suppressed",
      suppressionReason: "inbound_reply",
      engagedAt: "2026-08-06T09:30:00.000Z",
      firstEngagementKind: "inbound_reply",
    }),
  ],
  "recovery-sent-late": [
    recoveryRow({ status: "sent", sentAt: "2026-08-07T05:00:00.000Z" }),
  ],
  "recovery-control": [recoveryRow({ status: "control", cohort: "control" })],
  "recovery-settings": [
    recoveryRow({ triggerKind: "settings_blocked", cohort: "not_applicable" }),
  ],
  "recovery-tracking": [recoveryRow({ status: "tracking_unavailable" })],
  "recovery-uncertain": [
    recoveryRow({ status: "send_uncertain", lastErrorCategory: "graph_transport", attempts: 1 }),
  ],
  "recovery-cooldown": [
    recoveryRow({ status: "sent", sentAt: "2026-08-06T10:00:20.000Z" }),
    recoveryRow({
      id: "recovery-2",
      status: "suppressed",
      suppressionReason: "person_cooldown",
      keyword: { id: "kw-2", keyword: "PROTEIN" },
    }),
  ],
  "recovery-circuit": [recoveryRow()],
};

function recoveryScenario(): string {
  return new URLSearchParams(window.location.search).get("scenario") ?? "";
}

function currentRecoveryRows(): Record<string, unknown>[] {
  const rows = RECOVERY_ROWS[recoveryScenario()] ?? RECOVERY_ROWS["recovery-ready"]!;
  return rows.map((row) =>
    RECOVERY_CANCELLED.has(row.id as string)
      ? { ...row, status: "cancelled", suppressionReason: "owner_cancelled" }
      : RECOVERY_REVIEWED.has(row.id as string)
        ? { ...row, reviewedAt: "2026-08-07T06:00:00.000Z" }
        : row,
  );
}

function recoveryCounts() {
  const rows = currentRecoveryRows();
  const people = new Set(rows.map((r) => r.igUserId)).size;
  const of = (pred: (r: Record<string, unknown>) => boolean) => {
    const m = rows.filter(pred);
    return { records: m.length, people: new Set(m.map((r) => r.igUserId)).size };
  };
  return {
    all: { records: rows.length, people },
    scheduled: of((r) => r.status === "waiting" && r.eligibleAt! > "2026-08-07"),
    ready: of((r) => r.status === "waiting"),
    sent: of((r) => r.status === "sent"),
    suppressed: of((r) => r.status === "suppressed"),
    control: of((r) => r.status === "control"),
    attention: of((r) =>
      ["send_failed", "send_uncertain", "tracking_unavailable"].includes(r.status as string),
    ),
  };
}

function installFetchStub(): void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    // api() builds `${VITE_API_URL}/api${path}`, so strip the origin AND the /api
    // prefix to get back to the route path the components asked for.
    const path = (url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? "").replace(
      /^\/api(?:\/api)*/,
      "",
    );

    // Supabase auth: the api helper asks for a session before every call.
    if (path.includes("/auth/v1/")) {
      return json({
        access_token: "e2e-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: "e2e-refresh",
        user: { id: "e2e-user", email: "owner@example.com" },
      });
    }

    if (path === "/dm-threads/thread-1" && method === "GET") {
      const scenario = new URLSearchParams(window.location.search).get("scenario");
      if (scenario === "follow-up-scheduled") {
        return json({ ...THREAD, draft: { ...FOLLOW_UP, status: "queued" as const } });
      }
      if (scenario === "follow-up-ready") {
        return json({ ...THREAD, draft: FOLLOW_UP });
      }
      if (scenario === "follow-up-hydration") {
        return json({
          ...THREAD,
          draft: {
            ...FOLLOW_UP,
            status: hydrationRefreshes === 0 ? ("generating" as const) : ("pending_approval" as const),
            workingText:
              hydrationRefreshes < 2
                ? "How did bedtime go after trying the guide?"
                : "Server replacement that must not overwrite typing",
          },
        });
      }
      if (scenario === "follow-up-outdated-policy") {
        return json({ ...THREAD, draft: { ...FOLLOW_UP, promptPolicyCurrent: false } });
      }
      if (scenario === "follow-up-expiry") {
        return json({
          ...THREAD,
          draft: {
            ...FOLLOW_UP,
            status: "pending_approval" as const,
            expiresAt: "2026-08-05T22:00:30.000Z",
          },
        });
      }
      if (scenario === "follow-up-window-race") {
        return json({
          ...THREAD,
          draft: {
            ...FOLLOW_UP,
            status: windowClosed ? ("expired" as const) : ("pending_approval" as const),
            expiresAt: "2026-08-05T22:01:00.000Z",
          },
        });
      }
      if (scenario === "follow-up-error-scope") {
        return json({
          ...THREAD,
          draft: windowClosed
            ? {
                ...FOLLOW_UP,
                id: "follow-up-2",
                revision: 2,
                workingText: "Replacement follow-up text",
                suggestedText: "Replacement follow-up text",
              }
            : FOLLOW_UP,
        });
      }
      if (scenario === "follow-up-cancelled") {
        return json({
          ...THREAD,
          latestInboundMessageId: "message-3",
          draft: { ...FOLLOW_UP, status: "superseded" as const },
          messages: [
            ...THREAD.messages,
            {
              id: "message-3",
              direction: "inbound" as const,
              text: "Actually, can I ask something else?",
              type: "text" as const,
              source: "instagram_user",
              mediaUrl: null,
              instagramTimestamp: "2026-08-05T21:59:00.000Z",
            },
          ],
        });
      }
      if (scenario === "stale-reply") {
        const currentDraft = staleReplyDraftCreated
          ? {
              ...THREAD.draft,
              id: "draft-2",
              revision: 2,
              inboundMessageId: "message-3",
              suggestedText: "Reply to the newest inbound",
              workingText: "Reply to the newest inbound",
            }
          : THREAD.draft;
        return json({
          ...THREAD,
          latestInboundMessageId: "message-3",
          draft: currentDraft,
          messages: [
            ...THREAD.messages,
            {
              id: "message-3",
              direction: "inbound" as const,
              text: "One more detail before you answer…",
              type: "text" as const,
              source: "instagram_user",
              mediaUrl: null,
              instagramTimestamp: "2026-08-05T21:59:00.000Z",
            },
          ],
        });
      }
      if (!approved) return json(THREAD);
      // What the API really does after a successful approve: records an outbound
      // message and clears needsReply. `sent` is not a live status, so the
      // approval card unmounts and the reply shows in the transcript instead.
      return json({
        ...THREAD,
        needsReply: false,
        draft: { ...THREAD.draft, status: "sent", approvedText: sentText },
        messages: [
          ...THREAD.messages,
          {
            id: "message-3",
            direction: "outbound" as const,
            text: sentText,
            type: "text" as const,
            source: "ai_approved",
            mediaUrl: null,
            instagramTimestamp: "2026-08-04T10:07:00.000Z",
          },
        ],
      });
    }

    if (path === "/dm-threads" && method === "GET") {
      return json({ items: [THREAD], nextCursor: null });
    }

    if (path === "/conversations" && method === "GET") {
      return json({ items: [], nextCursor: null });
    }

    if (path === "/conversations/counts" && method === "GET") {
      return json({
        awaiting_done: 0,
        completed: 0,
        expired: 0,
        retrying: 0,
        waitingOnReply: 1,
      });
    }


    // ── DM recovery ──────────────────────────────────────────────────────
    if (path === "/recovery-reminders" && method === "GET") {
      const view = new URL(url, window.location.origin).searchParams.get("view") ?? "all";
      const rows = currentRecoveryRows().filter((r) => {
        if (view === "all") return true;
        if (view === "ready") return r.status === "waiting";
        if (view === "attention") {
          return ["send_failed", "send_uncertain", "tracking_unavailable"].includes(
            r.status as string,
          );
        }
        return r.status === view;
      });
      return json({ rows, nextCursor: null });
    }

    if (path === "/recovery-reminders/counts" && method === "GET") {
      return json(recoveryCounts());
    }

    if (path === "/recovery-reminders/metrics" && method === "GET") {
      const open = recoveryScenario() === "recovery-circuit";
      return json({
        health: {
          circuitOpen: open,
          reason: open ? "auth_or_permission" : null,
          openedAt: open ? "2026-08-07T04:00:00.000Z" : null,
          dueCount: currentRecoveryRows().length,
          sentLastHour: 0,
          recentOutcomeCount: 0,
          recentFailureRate: null,
          acceptedSignalSample: 0,
          positiveSignalSample: 0,
        },
      });
    }

    if (path.startsWith("/recovery-reminders/") && method === "GET") {
      const id = path.split("/")[2]!;
      const row = currentRecoveryRows().find((r) => r.id === id) ?? currentRecoveryRows()[0]!;
      const timeline = [
        { kind: "created", at: row.createdAt, detail: null },
        { kind: "accepted", at: row.acceptedAt, detail: null },
        { kind: "eligible", at: row.eligibleAt, detail: null },
        ...(row.seenAt ? [{ kind: "seen", at: row.seenAt, detail: null }] : []),
        ...(row.engagedAt
          ? [{ kind: "engaged", at: row.engagedAt, detail: row.firstEngagementKind }]
          : []),
        ...(row.sentAt ? [{ kind: "sent", at: row.sentAt, detail: null }] : []),
      ].filter((e) => e.at);
      return json({
        ...row,
        commentId: "comment-1",
        keywordSnapshot: "SLEEP",
        templateVersion: "v1",
        publicReplyId: row.sentAt ? "public-reply-1" : null,
        trackingAvailable: row.status !== "tracking_unavailable",
        comment: { text: "sleep", receivedAt: row.createdAt },
        timeline,
      });
    }

    if (path.endsWith("/cancel") && method === "POST") {
      RECOVERY_CANCELLED.add(path.split("/")[2]!);
      capture(JSON.stringify({ method, path }));
      return new Response(null, { status: 204 });
    }

    if (path.endsWith("/mark-reviewed") && method === "POST") {
      RECOVERY_REVIEWED.add(path.split("/")[2]!);
      capture(JSON.stringify({ method, path }));
      return new Response(null, { status: 204 });
    }

    if (path === "/ai/capabilities" && method === "GET") {
      const scenario = new URLSearchParams(window.location.search).get("scenario");
      return json({
        draftsEnabled: true,
        followUpsEnabled: true,
        sendEnabled: scenario === "capabilities-enabled",
      });
    }

    if (path === "/ai/dm-threads/thread-1/drafts" && method === "POST") {
      staleReplyDraftCreated = true;
      capture(
        JSON.stringify({
          method,
          path,
          body: typeof init?.body === "string" ? init.body : null,
        }),
      );
      return json({ draftId: "draft-2", status: "queued" }, 202);
    }

    if (path === "/ai/dm-threads/thread-1/drafts/draft-1/approve" && method === "POST") {
      publish(typeof init?.body === "string" ? init.body : "");
      return json({ status: "sent" });
    }

    if (path === "/ai/dm-threads/thread-1/drafts/follow-up-1/approve" && method === "POST") {
      const scenario = new URLSearchParams(window.location.search).get("scenario");
      if (scenario === "follow-up-window-race" || scenario === "follow-up-error-scope") {
        windowClosed = true;
        return json({ error: "follow_up_window_closed" }, 409);
      }
      publish(typeof init?.body === "string" ? init.body : "");
      return json({ status: "sent" });
    }

    if (path === "/ai/dm-threads/thread-1/drafts/follow-up-1" && method === "PATCH") {
      return new Response(null, { status: 204 });
    }

    if (path === "/ai/connection" && method === "GET") {
      return json({
        connected: true,
        requiresOpenaiAuth: false,
        account: { email: "owner@example.com", planType: "plus" },
        rateLimits: { usedPercent: 12, resetsAt: null },
      });
    }

    if (path === "/ai/advisor/history" && method === "GET") {
      return json({ items: [] });
    }

    if (path === "/ai/advisor/messages" && method === "POST") {
      return json(ADVISOR_ANSWER);
    }

    // Deliberately loud: an unhandled path must fail the test, not pass quietly.
    return json({ error: `e2e_unhandled:${method} ${path}` }, 404);
  };
}

export function DmApprovalScenario() {
  const [open, setOpen] = useState(true);
  const body = useCapturedBody();
  const queryClient = useQueryClient();
  const scenario = new URLSearchParams(window.location.search).get("scenario");
  return (
    <div>
      <DmThreadDrawer
        threadId={open ? "thread-1" : null}
        sendEnabled
        onClose={() => setOpen(false)}
      />
      {scenario === "follow-up-hydration" && (
        <button
          type="button"
          className="fixed bottom-2 left-2 z-[60]"
          onClick={() => {
            hydrationRefreshes += 1;
            void queryClient.invalidateQueries({ queryKey: ["dm-thread", "thread-1"] });
          }}
        >
          Refresh test draft
        </button>
      )}
      <pre data-testid="captured-request-body">{body}</pre>
    </div>
  );
}

export function CapabilitiesScenario() {
  return (
    <div className="p-4">
      <Conversations />
      <pre data-testid="captured-request-body">{useCapturedBody()}</pre>
    </div>
  );
}

export function Harness() {
  const scenario = new URLSearchParams(window.location.search).get("scenario");
  if (scenario === "dm-approval") return <DmApprovalScenario />;
  if (scenario === "capabilities" || scenario === "capabilities-enabled") {
    return <CapabilitiesScenario />;
  }
  if (scenario === "stale-reply") return <DmApprovalScenario />;
  if (scenario?.startsWith("follow-up-")) return <DmApprovalScenario />;
  if (scenario?.startsWith("recovery-")) {
    return (
      <div className="p-4">
        <Conversations />
      </div>
    );
  }
  if (scenario === "advisor") {
    return (
      <div className="p-4">
        <Assistant />
      </div>
    );
  }
  return <p>Unknown scenario: {scenario ?? "(none)"}</p>;
}

installFetchStub();

// retry: false so an unhandled 404 surfaces immediately instead of after backoff.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
);
