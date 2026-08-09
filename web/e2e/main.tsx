import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DmThreadDrawer } from "@/components/conversations/DmThreadDrawer";
import { Assistant } from "@/pages/Assistant";
import { Conversations } from "@/pages/Conversations";
import { HistoricalRecovery } from "@/pages/HistoricalRecovery";
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

// ── Historical recovery + canonical history fixtures ─────────────────────

const HISTORICAL_AS_OF = "2026-08-08T20:00:00.000Z";
const HISTORICAL_FIRST_CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const HISTORICAL_SECOND_CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const HISTORICAL_FIRST_CANDIDATE = "33333333-3333-4333-8333-333333333333";
const HISTORICAL_UNCERTAIN_CANDIDATE = "55555555-5555-4555-8555-555555555555";

const HISTORICAL_APPROVED = new Set<string>();
const HISTORICAL_REVIEWED = new Set<string>();
const HISTORICAL_CAPS = new Map<
  string,
  { batchSize: number; hourlyCap: number; dailyCap: number }
>();

function historicalCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: HISTORICAL_FIRST_CAMPAIGN,
    phase: "unknown_read_pilot",
    state: "running",
    selectionVersion: "selection-v2",
    copyVersion: "recovery-v2",
    sourceDataCutoff: "2026-08-01T00:00:00.000Z",
    holdoutPercent: 50,
    batchSize: 1,
    hourlyCap: 3,
    dailyCap: 10,
    candidateCount: 2,
    excludedCount: 0,
    approvedBy: "owner@example.com",
    approvedAt: "2026-08-02T01:00:00.000Z",
    startedAt: "2026-08-02T01:00:00.000Z",
    pausedAt: null,
    pauseReason: null,
    endedAt: null,
    createdAt: "2026-08-02T00:00:00.000Z",
    progress: {},
    ...overrides,
  };
}

function historicalCampaignRows() {
  return [
    historicalCampaign(),
    historicalCampaign({
      id: HISTORICAL_SECOND_CAMPAIGN,
      phase: "confirmed_failure",
      state: HISTORICAL_APPROVED.has(HISTORICAL_SECOND_CAMPAIGN)
        ? "running"
        : "awaiting_approval",
      approvedBy: HISTORICAL_APPROVED.has(HISTORICAL_SECOND_CAMPAIGN)
        ? "owner@example.com"
        : null,
      approvedAt: HISTORICAL_APPROVED.has(HISTORICAL_SECOND_CAMPAIGN)
        ? "2026-08-08T20:05:00.000Z"
        : null,
      startedAt: HISTORICAL_APPROVED.has(HISTORICAL_SECOND_CAMPAIGN)
        ? "2026-08-08T20:05:00.000Z"
        : null,
      createdAt: "2026-08-01T00:00:00.000Z",
      ...(HISTORICAL_CAPS.get(HISTORICAL_SECOND_CAMPAIGN) ?? {}),
    }),
  ];
}

function historicalCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: HISTORICAL_FIRST_CANDIDATE,
    campaignId: HISTORICAL_FIRST_CAMPAIGN,
    campaignPhase: "unknown_read_pilot",
    igUserId: "ig-sarah",
    username: "sarah",
    keywordSnapshot: "SLEEP",
    commentId: "comment-sarah",
    mediaId: "media-1",
    commentAt: "2026-06-25T10:00:00.000Z",
    publicReplyText: "Here is your SLEEP guide.",
    evidence: "gate_sent_no_read",
    arm: "treatment",
    outcome: "pending",
    audienceOrigin: "us_western",
    audienceOriginConfidence: "high",
    sentAt: null,
    publicReplyId: null,
    suppressionReason: null,
    reviewedAt: null,
    laterInboundAt: null,
    laterCompletedAt: null,
    attempts: 0,
    createdAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function historicalCounts() {
  return {
    all: 3,
    pending: 2,
    sent: 0,
    suppressed: 0,
    attention: 1,
    holdout: 0,
    recovered: 0,
  };
}

function historicalUncertainCandidate() {
  return historicalCandidate({
    id: HISTORICAL_UNCERTAIN_CANDIDATE,
    igUserId: "ig-zoe",
    username: "zoe",
    commentId: "source-comment-uncertain",
    outcome: "send_uncertain",
    evidence: "transport_interrupted",
    attempts: 1,
    reviewedAt: HISTORICAL_REVIEWED.has(HISTORICAL_UNCERTAIN_CANDIDATE)
      ? "2026-08-08T20:10:00.000Z"
      : null,
  });
}

function historicalCandidateDetail() {
  const candidate = historicalUncertainCandidate();
  return {
    candidate,
    campaign: {
      id: HISTORICAL_FIRST_CAMPAIGN,
      state: "running",
      selectionVersion: "selection-v2",
      copyVersion: "recovery-v2",
      sourceDataCutoff: "2026-08-01T00:00:00.000Z",
    },
    intent: {
      id: "intent-1",
      keyword: { id: "keyword-1", keyword: "SLEEP" },
      reconciledState: "canonical",
      completedAt: null,
      canonicalConversation: {
        id: "canonical-conversation-1",
        state: "expired",
        reconciliationReason: null,
      },
      aliasConversations: [
        {
          id: "alias-conversation-1",
          state: "expired",
          reconciliationReason: "duplicate_inside_window",
        },
      ],
      triggers: [
        {
          id: "trigger-1",
          commentId: "trigger-comment-1",
          mediaId: "media-1",
          receivedAt: "2026-06-25T10:00:00.000Z",
          triggerKind: "comment",
          disposition: "canonical",
        },
      ],
    },
    mediaPermalink: "https://www.instagram.com/reel/exact-stored-source/",
    auditEvents: [
      {
        id: "audit-selected",
        kind: "historical_candidate_selected",
        actor: "system",
        action: null,
        reason: null,
        category: null,
        createdAt: "2026-08-02T00:00:00.000Z",
      },
    ],
  };
}

function canonicalConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "canonical-conversation-1",
    igUserId: "ig-history",
    keywordId: "keyword-1",
    state: "awaiting_done",
    delivery: "delivered",
    createdAt: "2026-08-08T19:00:00.000Z",
    completedAt: null,
    keyword: { id: "keyword-1", keyword: "SLEEP" },
    username: "history-user",
    name: "History User",
    historyRole: "canonical",
    canonicalOwner: { id: "canonical-conversation-1" },
    aliasCount: 1,
    reconciliationReason: null,
    ...overrides,
  };
}

function installFetchStub(): void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const requestUrl = new URL(url, window.location.origin);
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
      if (recoveryScenario() === "canonical-conversations") {
        const mode = requestUrl.searchParams.get("mode") ?? "canonical";
        return json({
          items:
            mode === "raw"
              ? [
                  canonicalConversation({
                    id: "alias-conversation-1",
                    historyRole: "alias",
                    canonicalOwner: { id: "canonical-conversation-1" },
                    aliasCount: 0,
                    reconciliationReason: "duplicate_inside_window",
                  }),
                ]
              : [canonicalConversation()],
          nextCursor: null,
        });
      }
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

    // ── Historical recovery dashboard ───────────────────────────────────
    if (path === "/historical-recovery/campaigns" && method === "GET") {
      return json({ sendingEnabled: true, campaigns: historicalCampaignRows() });
    }

    if (path === "/historical-recovery/candidates" && method === "GET") {
      const view = requestUrl.searchParams.get("view") ?? "pending";
      const cursor = requestUrl.searchParams.get("cursor");
      if (view === "attention") {
        return json({
          counts: historicalCounts(),
          nextCursor: null,
          asOf: HISTORICAL_AS_OF,
          candidates: [historicalUncertainCandidate()],
        });
      }
      if (cursor) {
        if (
          cursor !== HISTORICAL_FIRST_CANDIDATE ||
          requestUrl.searchParams.get("asOf") !== HISTORICAL_AS_OF
        ) {
          return json({ error: "historical_snapshot_mismatch" }, 400);
        }
        return json({
          counts: historicalCounts(),
          nextCursor: null,
          asOf: HISTORICAL_AS_OF,
          candidates: [
            historicalCandidate(),
            historicalCandidate({
              id: "44444444-4444-4444-8444-444444444444",
              igUserId: "ig-maria",
              username: "maria",
              commentId: "comment-maria",
            }),
          ],
        });
      }
      return json({
        counts: historicalCounts(),
        nextCursor: HISTORICAL_FIRST_CANDIDATE,
        asOf: HISTORICAL_AS_OF,
        candidates: [historicalCandidate()],
      });
    }

    if (
      path === `/historical-recovery/candidates/${HISTORICAL_UNCERTAIN_CANDIDATE}/mark-reviewed` &&
      method === "POST"
    ) {
      HISTORICAL_REVIEWED.add(HISTORICAL_UNCERTAIN_CANDIDATE);
      return new Response(null, { status: 204 });
    }

    if (
      path === `/historical-recovery/candidates/${HISTORICAL_UNCERTAIN_CANDIDATE}` &&
      method === "GET"
    ) {
      return json(historicalCandidateDetail());
    }

    if (
      path === `/historical-recovery/campaigns/${HISTORICAL_SECOND_CAMPAIGN}/approve` &&
      method === "POST"
    ) {
      HISTORICAL_APPROVED.add(HISTORICAL_SECOND_CAMPAIGN);
      return json({ state: "running" });
    }

    if (
      path === `/historical-recovery/campaigns/${HISTORICAL_SECOND_CAMPAIGN}/stage` &&
      method === "POST"
    ) {
      const caps = JSON.parse(String(init?.body ?? "{}")) as {
        batchSize: number;
        hourlyCap: number;
        dailyCap: number;
      };
      HISTORICAL_CAPS.set(HISTORICAL_SECOND_CAMPAIGN, caps);
      return json({ state: "running" });
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

    if (path === "/recovery-reminders/settings-verifications" && method === "GET") {
      return json({ records: [] });
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
  if (scenario === "historical-dashboard") {
    return (
      <div className="p-4">
        <HistoricalRecovery />
      </div>
    );
  }
  if (scenario === "canonical-conversations") {
    return (
      <div className="p-4">
        <Conversations />
      </div>
    );
  }
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
