import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DmThreadDrawer } from "@/components/conversations/DmThreadDrawer";
import { Assistant } from "@/pages/Assistant";
import { Content } from "@/pages/Content";
import { Switches } from "@/pages/Switches";
import { SwitchDetail } from "@/pages/SwitchDetail";
import { Experiments } from "@/pages/Experiments";
import { ExperimentDetail } from "@/pages/ExperimentDetail";
import { Conversations } from "@/pages/Conversations";
import { DmRecovery } from "@/pages/DmRecovery";
import { HistoricalRecovery } from "@/pages/HistoricalRecovery";
import { Home } from "@/pages/Home";
import { Funnels } from "@/pages/Funnels";
import { Insights } from "@/pages/Insights";
import { SequenceEditor } from "@/pages/SequenceEditor";
import { Sequences } from "@/pages/Sequences";
import "../src/index.css";

/**
 * Test-only harness for the Playwright journeys.
 *
 * It mounts the REAL components — no reimplementation — and replaces only
 * `window.fetch` with deterministic handlers for the exact `/api` paths the
 * tests touch. Anything else 404s loudly rather than silently
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
const RECOVERY_NOW_MS = Date.parse("2026-08-07T06:00:00.000Z");

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
  "recovery-scheduled": [
    recoveryRow({ eligibleAt: "2026-08-08T10:00:00.000Z" }),
  ],
  "recovery-sending": [
    recoveryRow({ status: "sending", lastAttemptAt: "2026-08-07T05:59:58.000Z", attempts: 1 }),
  ],
  "recovery-failed": [
    recoveryRow({ status: "send_failed", lastErrorCategory: "graph_rejected", attempts: 1 }),
  ],
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

/** The scenario name, for stubs shared by more than one surface. */
function activeScenario(): string {
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
    scheduled: of(
      (r) => r.status === "waiting" && Date.parse(String(r.eligibleAt)) > RECOVERY_NOW_MS,
    ),
    ready: of(
      (r) => r.status === "waiting" && Date.parse(String(r.eligibleAt)) <= RECOVERY_NOW_MS,
    ),
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

/**
 * Home fixtures. Deterministic, and deliberately synthetic: no real follower
 * counts and no real usernames reach a committed screenshot.
 *
 * The last window is provisional so the dashed outline is visible, and the series
 * are large enough that every region contributes a legible band.
 */
const HOME_FLOW_DAYS = [
  { day: "2026-08-08", us: 21, southAsian: 6, anglosphere: 5, other: 3 },
  { day: "2026-08-09", us: 18, southAsian: 8, anglosphere: 4, other: 2 },
  { day: "2026-08-10", us: 25, southAsian: 5, anglosphere: 6, other: 4 },
  { day: "2026-08-11", us: 22, southAsian: 7, anglosphere: 3, other: 3 },
  { day: "2026-08-12", us: 27, southAsian: 4, anglosphere: 7, other: 2 },
  { day: "2026-08-13", us: 19, southAsian: 9, anglosphere: 4, other: 5 },
  { day: "2026-08-14", us: 24, southAsian: 6, anglosphere: 5, other: 3 },
  { day: "2026-08-15", us: 30, southAsian: 5, anglosphere: 6, other: 2 },
  { day: "2026-08-16", us: 26, southAsian: 7, anglosphere: 4, other: 4 },
  { day: "2026-08-17", us: 12, southAsian: 3, anglosphere: 2, other: 1 },
];

const HOME_FLOW_POINTS = HOME_FLOW_DAYS.map((point, index) => {
  const total = point.us + point.southAsian + point.anglosphere + point.other;
  return {
    ...point,
    capturedAt: `${point.day}T23:00:00.000Z`,
    total,
    unattributed: 0,
    reportedTotalDelta: total,
    spanDays: 1,
    stale: false,
    // The newest window is still filling — the case the dashed outline exists for.
    provisional: index === HOME_FLOW_DAYS.length - 1,
    basis: "diff" as const,
  };
});

const HOME_STOCK = {
  capturedAt: "2026-08-17T23:10:00.000Z",
  totalCounted: 4308,
  followersTotal: 4578,
  us: 1489,
  southAsian: 1278,
  anglosphere: 817,
  other: 724,
  countriesReported: 45,
};

const HOME_STATS = {
  activeKeywords: 9,
  totalKeywords: 12,
  dmsSentToday: 34,
  conversationsAwaiting: 74,
  completedToday: 21,
  lastError: null,
  gateQueuePending: 0,
  gateQueueExhausted: 0,
  gateQueueSendUncertain: 0,
  // One unattached keyword, so Home's "Best next move" renders the item that
  // outranks every other kind. Zero here would hide the surface being captured.
  upcomingNeedsAttention: 1,
  tokenHealth: null,
}

// ── Content ───────────────────────────────────────────────────────────────
// Content was the one migrated surface the Maison QA never captured. These
// fixtures exist so the upcoming-setup rows and their status chips can be looked
// at on real paper, which is the failure mode a unit test cannot see.

const CONTENT_MEDIA = [
  {
    id: "media-1",
    kind: "reel" as const,
    caption: "Cardboard box play ideas for rainy afternoons. Comment CARDBOARD",
    thumbnailUrl: null,
    permalink: "https://www.instagram.com/reel/cardboard/",
    timestamp: "2026-08-18T09:12:00+0000",
  },
  {
    id: "media-2",
    kind: "reel" as const,
    caption: "The three-minute wind-down that finally worked. Comment SLEEPY",
    thumbnailUrl: null,
    permalink: "https://www.instagram.com/reel/sleep/",
    timestamp: "2026-08-17T16:40:00+0000",
  },
  {
    id: "media-3",
    kind: "carousel" as const,
    caption: "Five high-chair meals with no cooking",
    thumbnailUrl: null,
    permalink: "https://www.instagram.com/p/highchair/",
    timestamp: "2026-08-15T11:05:00+0000",
  },
]

const CONTENT_KEYWORDS = [
  {
    id: "keyword-1",
    keyword: "CARDBOARD",
    mediaId: "media-1",
    mediaCaption: CONTENT_MEDIA[0]!.caption,
    mediaPermalink: CONTENT_MEDIA[0]!.permalink,
    mediaPostedAt: "2026-08-18T09:12:00.000Z",
    resourceId: "resource-2",
    publicReply: "Sent! Check your DMs.",
    gateMessage: "Follow and reply DONE and it's yours.",
    active: true,
    createdAt: "2026-08-18T09:13:00.000Z",
    updatedAt: "2026-08-18T09:13:00.000Z",
    resource: { id: "resource-2", name: "Cardboard Play Guide", _count: { messages: 4 } },
  },
]

function upcomingSetup(
  overrides: Record<string, unknown> & { id: string; triggerWord: string },
) {
  return {
    resourceId: "resource-2",
    publicReply: "Sent! Check your DMs.",
    gateMessage: "Follow and reply DONE and it's yours.",
    active: true,
    status: "waiting",
    matchedMediaId: null,
    keywordId: null,
    errorCode: null,
    createdBy: "owner@example.com",
    lastAttemptAt: null,
    retriedAt: null,
    boundAt: null,
    cancelledAt: null,
    createdAt: "2026-08-16T18:00:00.000Z",
    updatedAt: "2026-08-16T18:00:00.000Z",
    resource: { id: "resource-2", name: "Sleep Reset Guide", _count: { messages: 4 } },
    ...overrides,
  }
}

// All three chips at once: the failure, the wait, and the receipt. The SLEEP row
// is the real case — she wrote "Comment SLEEPY" and reserved SLEEP, so nothing
// attached and every commenter on a live reel is getting silence.
const CONTENT_UPCOMING = [
  upcomingSetup({
    id: "upcoming-1",
    triggerWord: "SLEEP",
    status: "needs_attention",
    matchedMediaId: "media-2",
    errorCode: "caption_instruction_mismatch",
    lastAttemptAt: "2026-08-17T16:41:00.000Z",
  }),
  upcomingSetup({
    id: "upcoming-2",
    triggerWord: "PLAY",
    resource: { id: "resource-1", name: "Toddler Activity Guide", _count: { messages: 3 } },
  }),
  upcomingSetup({
    id: "upcoming-3",
    triggerWord: "CARDBOARD",
    status: "bound",
    matchedMediaId: "media-1",
    keywordId: "keyword-1",
    boundAt: "2026-08-18T04:00:00.000Z",
    resource: { id: "resource-2", name: "Cardboard Play Guide", _count: { messages: 4 } },
  }),
]

// ── Switches ──────────────────────────────────────────────────────────────
// One row per group and per capability. The list artifact proves the rewrite —
// five one-line rows where sixteen paragraphs used to be — and the detail
// artifacts show the four controls: a switch, a lone Stop now, a slider, and a
// flag the console may not touch. The safety model is only visible when a stop
// appears with no matching start beside it.
const FLAG_ROWS = [
  {
    key: "DM_RECOVERY_ENABLED",
    name: "Recovery reminders",
    group: "outbound",
    kind: "boolean",
    doesWhat:
      "When someone asks for a guide but never opens our message, leaves a public comment on the reel telling them to check their message requests.",
    affectsWho:
      "People who commented a keyword and were sent a guide, but have not opened it. Around 190 a week.",
    ifOff:
      "No public reminders are posted. People who miss the message simply never get the guide.",
    pageMayEnable: false,
    pageMayStop: true,
    valueBool: true,
    valuePercent: null,
    source: "environment",
    driftsFromEnv: false,
    updatedBy: null,
    updatedAt: null,
    experimentKey: "recovery-reminder-timing",
    experimentName: "Recovery reminder timing",
  },
  {
    key: "GUIDE_DELIVERY_ROLLOUT_PERCENT",
    name: "Share on the new path",
    group: "outbound",
    kind: "percent",
    doesWhat:
      "How many people are served by the newer delivery path rather than the older one.",
    affectsWho: "New guide requests only. Deliveries already under way are unaffected.",
    ifOff: "At zero, everyone is served by the older path.",
    pageMayEnable: true,
    pageMayStop: true,
    valueBool: null,
    valuePercent: 45,
    source: "override",
    driftsFromEnv: true,
    updatedBy: "owner@example.com",
    updatedAt: "2026-08-18T04:00:00.000Z",
    experimentKey: "guide-delivery-rollout",
    experimentName: "Guide delivery rollout",
  },
  {
    key: "DM_RECOVERY_WESTERN_ONLY",
    name: "Western audience only",
    group: "experiment",
    kind: "boolean",
    doesWhat:
      "Withholds the public reminder when someone looks likely to be outside the audience this account sells to.",
    affectsWho:
      "People whose name suggests an origin outside that audience. It withheld 265 reminders in the last eleven days.",
    ifOff: "Reminders are posted regardless of where the person appears to be from.",
    pageMayEnable: true,
    pageMayStop: true,
    valueBool: true,
    valuePercent: null,
    source: "environment",
    driftsFromEnv: false,
    updatedBy: null,
    updatedAt: null,
    experimentKey: "recovery-reminder-timing",
    experimentName: "Recovery reminder timing",
  },
  {
    key: "AI_DRAFTS_ENABLED",
    name: "Reply drafts",
    group: "assistive",
    kind: "boolean",
    doesWhat:
      "Writes a suggested reply for each conversation waiting on you, so you can send it with one tap instead of typing from scratch.",
    affectsWho: "Only you. A draft sits in Conversations until you approve it.",
    ifOff: "Suggestions stop appearing. You can still reply by hand.",
    pageMayEnable: true,
    pageMayStop: true,
    valueBool: true,
    valuePercent: null,
    source: "environment",
    driftsFromEnv: false,
    updatedBy: null,
    updatedAt: null,
  },
  {
    key: "WORKERS_ENABLED",
    name: "Background jobs",
    group: "infrastructure",
    kind: "boolean",
    doesWhat:
      "Runs everything that happens without you: sending queued messages, refreshing the Instagram connection, taking daily follower readings.",
    affectsWho:
      "All automation. The console still works with this off; the system just does nothing on its own.",
    ifOff:
      "Nothing is sent, no readings are taken, and the Instagram connection stops renewing itself.",
    pageMayEnable: false,
    pageMayStop: false,
    valueBool: true,
    valuePercent: null,
    source: "environment",
    driftsFromEnv: false,
    updatedBy: null,
    updatedAt: null,
  },
]

// ── Experiments ───────────────────────────────────────────────────────────
// One running and two not started, which is the real state. The not-started rows
// are the reason the artifact is worth taking: they must read as a decision
// ("never switched on") and never as a row of zeroes.
const RECOVERY_SUMMARY = {
  kind: "running" as const,
  arms: [
    { key: "treatment", label: "Got a reminder", people: 594 },
    { key: "control", label: "Got nothing", people: 395 },
  ],
  // Counts taken from production so the artifact shows the real spread, including
  // the buckets an earlier version dropped: waiting, failed, unconfirmed.
  notCounted: [
    { reason: "They opened it themselves", people: 531 },
    { reason: "They replied, so they saw it", people: 441 },
    { reason: "Outside your audience", people: 269 },
    { reason: "Reminded too recently", people: 56 },
    { reason: "Waiting to be posted", people: 54 },
    { reason: "The reminder could not be posted", people: 12 },
    { reason: "We could not track it", people: 4 },
  ],
  endsAt: "2026-08-21T21:45:00.000Z",
  whenItEnds:
    "When the window closes, reminders stop and wait for your decision. Nothing announces it.",
};

const ROLLOUT_SUMMARY = {
  kind: "not_started" as const,
  wouldCompare:
    "Served by the newer delivery path, which tracks each step separately. versus Served by the older path, which is what everyone gets today.",
  blocker:
    "The rollout is at zero, so nobody is on the newer path yet. Raising it starts the comparison.",
};

const COLD_SUMMARY = {
  kind: "not_started" as const,
  wouldCompare:
    "Gets one ordinary message after the unlock message gave up. versus Gets nothing further, which is what happens today.",
  blocker: "It has never been switched on, so no message has been tried.",
};

const EXPERIMENT_ROWS = [
  {
    key: "recovery-reminder-timing",
    name: "Recovery reminder timing",
    state: "running",
    armCount: 2,
    blocker: "",
    summary: RECOVERY_SUMMARY,
  },
  {
    key: "guide-delivery-rollout",
    name: "Guide delivery rollout",
    state: "not_started",
    armCount: 2,
    blocker: ROLLOUT_SUMMARY.blocker,
    summary: ROLLOUT_SUMMARY,
  },
  {
    key: "cold-message-test",
    name: "Cold message test",
    state: "not_started",
    armCount: 2,
    blocker: COLD_SUMMARY.blocker,
    summary: COLD_SUMMARY,
  },
]

const EXPERIMENT_DETAILS: Record<string, unknown> = {
  "recovery-reminder-timing": {
    key: "recovery-reminder-timing",
    name: "Recovery reminder timing",
    state: "running",
    doesWhat:
      "Tests whether leaving a public comment helps when someone never opens the guide we sent them, by leaving one for most people and deliberately saying nothing to the rest.",
    affectsWho:
      "People who commented a keyword and were sent a guide but have not opened it. Around 190 a week.",
    outcome: "Whether they received the guide within 48 hours of first asking.",
    arms: [
      {
        key: "treatment",
        percent: 90,
        doesWhat: "Gets a public comment on the reel telling them to check their requests.",
        isControl: false,
      },
      {
        key: "control",
        percent: 10,
        doesWhat: "Gets nothing, so we can tell whether the reminder is what worked.",
        isControl: true,
      },
    ],
    blocker: "",
    summary: RECOVERY_SUMMARY,
    ownedFlags: FLAG_ROWS.filter(
      (row) => row.experimentKey === "recovery-reminder-timing",
    ),
  },
  "guide-delivery-rollout": {
    key: "guide-delivery-rollout",
    name: "Guide delivery rollout",
    state: "not_started",
    doesWhat:
      "Would compare the newer way of sending a guide against the older one, by serving a share of people through each.",
    affectsWho: "New guide requests. Deliveries already under way would be untouched.",
    outcome: "Whether the guide arrived complete, and whether anything needed review.",
    arms: [
      {
        key: "new_path",
        percent: null,
        doesWhat: "Served by the newer delivery path, which tracks each step separately.",
        isControl: false,
      },
      {
        key: "old_path",
        percent: null,
        doesWhat: "Served by the older path, which is what everyone gets today.",
        isControl: true,
      },
    ],
    blocker: ROLLOUT_SUMMARY.blocker,
    summary: ROLLOUT_SUMMARY,
    ownedFlags: FLAG_ROWS.filter((row) => row.experimentKey === "guide-delivery-rollout"),
  },
}

// pct1 in the funnel layer returns 0-100 (64.9, not 0.649). A fixture using the
// 0-1 form rendered "0.6488651535380507%" on Home, which looked like a formatting
// bug in the product and was a bug in the fixture.
const rate = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  pct: denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10,
  belowMinSample: false,
});

const stage = (
  key: string,
  label: string,
  count: number,
  ofEntryPct: number | null,
  ofPrevPct: number | null,
) => ({ key, label, definition: `Synthetic ${label} stage.`, count, ofEntryPct, ofPrevPct });

const HOME_FUNNEL = {
  key: "guide-follow",
  name: "Guide and follow",
  question: "Of the people who commented, how many followed and received the guide?",
  window: { from: "2026-07-19", to: "2026-08-17" },
  cohortSize: 812,
  stages: [
    stage("commented", "Commented", 812, 100, null),
    stage("gated", "Gate DM sent", 749, 92.2, 92.2),
    stage("replied", "Replied DONE", 486, 59.9, 64.9),
    stage("delivered", "Guide delivered", 471, 58, 96.9),
  ],
  headline: {
    fromStage: "gated",
    toStage: "replied",
    label: "Gate DM sent to Replied DONE",
    rationale: "The largest measured loss in this cohort.",
    rate: rate(486, 749),
  },
  followGateConversion: rate(486, 749),
  stuckAtWall: 263,
  askDistribution: [{ asks: 1, conversations: 749, cleared: 486 }],
  expressLane: 37,
  byEntryPath: [],
  retention: rate(104, 471),
  homeTileCohort: { deliveredToNonFollower: 12, ofWhichRedelivery: 3 },
};


/** Funnels, Sequence Editor and Insights fixtures — synthetic, deterministic. */
const FUNNEL_DROP_OFF = {
  bucket: "no-reply" as const,
  label: "Never replied DONE",
  definition: "Received the gate DM and never replied within the window.",
  total: 263,
  byState: { expired: 201, stillOpen: 62 },
  readEvidence: {
    confirmedSeen: 118,
    trackedNeverConfirmed: 74,
    noReadData: 71,
    confirmedSeenOfTracked: rate(118, 192),
  },
  recovery: { reminderSent: 96, reminderSuppressed: 34, inControlArm: 48, noReminder: 85 },
  rows: [],
};

const EDITOR_RESOURCE = {
  id: "resource-1",
  name: "Toddler Activity Guide",
  description: "Three quiet-time activities, sent after the follow.",
  createdAt: "2026-07-02T10:00:00.000Z",
  invalidMessageCount: 0,
  messages: [],
  keywords: [{ id: "keyword-1", keyword: "SLEEP" }],
};

const EDITOR_MESSAGES = [
  {
    id: "message-1",
    resourceId: "resource-1",
    order: 0,
    type: "text" as const,
    body: "Here is your guide — three quiet-time activities you can set up in a minute.",
    mediaUrl: null,
  },
  {
    id: "message-2",
    resourceId: "resource-1",
    order: 1,
    type: "image" as const,
    body: "Activity one: the sorting basket.",
    mediaUrl: "https://placehold.co/600x400/EBE8DF/66665F?text=Activity+one",
  },
  {
    id: "message-3",
    resourceId: "resource-1",
    order: 2,
    type: "pdf" as const,
    body: null,
    mediaUrl: "https://placehold.co/600x400/EBE8DF/66665F?text=Printable",
  },
];

const leaderboardRow = (
  mediaId: string,
  caption: string,
  usFitScore: number | null,
  reach: number,
  comments: number,
) => ({
  mediaId,
  caption,
  thumbnailUrl: null,
  permalink: `https://instagram.com/p/${mediaId}`,
  postedAt: "2026-08-04T15:00:00.000Z",
  usFitScore,
  confidence: usFitScore === null ? null : "high",
  mediaAudioType: "original_sound",
  videoUnavailable: false,
  analyzed: usFitScore !== null,
  views: reach + 400,
  reach,
  // 0-1, not a percentage: RepeatReelsCard multiplies by 100. A fixture using 41.2
  // rendered "4120% skip".
  skipRate: 0.412,
  conversion: {
    keywordComments: comments,
    gateDelivered: Math.round(comments * 0.92),
    completed: Math.round(comments * 0.61),
  },
  captureRatePct: Math.round((comments / reach) * 1000) / 10,
});

const INSIGHTS_LEADERBOARD = [
  leaderboardRow("reel-a", "Quiet time basket that actually works", 82, 24800, 214),
  leaderboardRow("reel-b", "Two-minute reset for a toddler meltdown", 74, 19100, 168),
  leaderboardRow("reel-c", "Why we stopped buying loud toys", 61, 15600, 96),
  leaderboardRow("reel-d", "Snack prep on a bad morning", null, 11200, 54),
];

const INSIGHTS_GEO = {
  stages: [
    { stage: "reached", timeframe: "last_90_days", usPct: 41.2, capturedAt: "2026-08-17T23:00:00.000Z" },
    { stage: "engaged", timeframe: "last_90_days", usPct: 38.4, capturedAt: "2026-08-17T23:00:00.000Z" },
    { stage: "followers", timeframe: "lifetime", usPct: 34.6, capturedAt: "2026-08-17T23:00:00.000Z" },
  ],
};

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

    // Home. Added so the follower chart's paper palette can be inspected in a real
    // browser: the marks, the rolling mean, and the provisional dash are SVG
    // rendering decisions that a unit test can only assert about, not look at.
    if (path === "/insights/follower-daily-adds" && method === "GET") {
      return json({ points: HOME_FLOW_POINTS, stock: HOME_STOCK });
    }
    if (path === "/stats" && method === "GET") {
      return json(HOME_STATS);
    }
    if (path === "/funnels/guide-follow" && method === "GET") {
      return json(HOME_FUNNEL);
    }
    if (path.startsWith("/insights/feed-follow-attribution") && method === "GET") {
      return json({ days: [], totals: null });
    }

    if (path === "/funnels/guide-follow/drop-off/no-reply" && method === "GET") {
      return json(FUNNEL_DROP_OFF);
    }
    if (path === "/resources" && method === "GET") {
      return json([
        { ...EDITOR_RESOURCE, _count: { messages: 3, keywords: 1 }, invalidMessageCount: 0 },
        {
          id: "resource-2",
          name: "Sleep Reset Guide",
          description: "Sent after the follow. One step is over Instagram's limit.",
          createdAt: "2026-06-11T10:00:00.000Z",
          _count: { messages: 4, keywords: 2 },
          invalidMessageCount: 1,
        },
      ]);
    }
    if (path === "/resources/resource-1" && method === "GET") return json(EDITOR_RESOURCE);
    if (path === "/messages/by-resource/resource-1" && method === "GET") {
      return json(EDITOR_MESSAGES);
    }
    if (path === "/insights/leaderboard" && method === "GET") {
      return json({ items: INSIGHTS_LEADERBOARD });
    }
    if (path === "/insights/geo" && method === "GET") return json(INSIGHTS_GEO);
    if (path === "/insights/recipe" && method === "GET") {
      return json({ top: [], bottom: [], contrasts: [] });
    }
    if (path === "/insights/reel-origin" && method === "GET") return json({ items: [] });
    if (path === "/insights/us-reach-trend" && method === "GET") return json({ points: [] });
    if (path === "/insights/geo-window-trend" && method === "GET") return json({ points: [] });
    if (path === "/insights/experiments" && method === "GET") return json({ items: [] });

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

    if (path === "/keywords" && method === "GET") {
      // Only the Content scenario needs real keywords; every other surface reads
      // this list solely to count badges, and an empty list is the quieter fixture.
      return json(activeScenario() === "content" ? CONTENT_KEYWORDS : []);
    }

    // ── Content ─────────────────────────────────────────────────────────
    if (path === "/media/content" && method === "GET") {
      return json({ items: CONTENT_MEDIA, nextCursor: null });
    }

    if (path === "/flags" && method === "GET") {
      return json({ flags: FLAG_ROWS });
    }

    // The detail page fetches its own flag by key rather than filtering the list,
    // so a bookmarked switch URL works before the list has been opened.
    if (path.startsWith("/flags/") && method === "GET") {
      const key = path.slice("/flags/".length);
      const row = FLAG_ROWS.find((entry) => entry.key === key);
      return row ? json(row) : json({ error: "not_found" }, 404);
    }

    if (path === "/experiments" && method === "GET") {
      return json({ experiments: EXPERIMENT_ROWS });
    }

    if (path.startsWith("/experiments/") && method === "GET") {
      const key = path.slice("/experiments/".length);
      const row = EXPERIMENT_DETAILS[key];
      return row ? json(row) : json({ error: "not_found" }, 404);
    }

    if (path === "/upcoming-automations" && method === "GET") {
      return json({ automations: CONTENT_UPCOMING, discoveryEnabled: true });
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
        if (view === "scheduled") {
          return r.status === "waiting" && Date.parse(String(r.eligibleAt)) > RECOVERY_NOW_MS;
        }
        if (view === "ready") {
          return r.status === "waiting" && Date.parse(String(r.eligibleAt)) <= RECOVERY_NOW_MS;
        }
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
        <Routes>
          <Route path="/dm-recovery" element={<DmRecovery />} />
        </Routes>
      </div>
    );
  }
  if (scenario === "home") {
    return (
      <div className="p-4">
        <Home />
      </div>
    );
  }
  if (scenario === "sequences") {
    return (
      <div className="p-4">
        <Sequences />
      </div>
    );
  }
  if (scenario === "funnels") {
    return (
      <div className="p-4">
        <Funnels />
      </div>
    );
  }
  if (scenario === "sequence-editor") {
    return (
      <div className="p-4">
        <Routes>
          <Route path="/guides/:id" element={<SequenceEditor />} />
        </Routes>
      </div>
    );
  }
  if (scenario === "insights") {
    return (
      <div className="p-4">
        <Insights />
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
  if (scenario === "content") {
    return (
      <div className="p-4">
        <Content />
      </div>
    );
  }
  if (scenario === "switches") {
    return (
      <div className="p-4">
        <Switches />
      </div>
    );
  }
  if (scenario === "switch-detail") {
    return (
      <div className="p-4">
        <Routes>
          <Route path="/switches/:key" element={<SwitchDetail />} />
        </Routes>
      </div>
    );
  }
  if (scenario === "experiments") {
    return (
      <div className="p-4">
        <Experiments />
      </div>
    );
  }
  if (scenario === "experiment-detail") {
    return (
      <div className="p-4">
        <Routes>
          <Route path="/experiments/:key" element={<ExperimentDetail />} />
        </Routes>
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

const harnessScenario = new URLSearchParams(window.location.search).get("scenario");
const initialEntry =
  harnessScenario?.startsWith("recovery-")
    ? "/dm-recovery"
    : harnessScenario === "sequence-editor"
      ? "/guides/resource-1"
      : harnessScenario === "switch-detail"
        ? // The lone Stop now with no matching start — the safety model made visible.
          "/switches/DM_RECOVERY_ENABLED"
        : harnessScenario === "experiment-detail"
          ? "/experiments/recovery-reminder-timing"
          : "/";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
);
