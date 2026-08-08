import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { captureRawBody, handleVerification, verifyMetaSignature } from "./meta/verifyWebhook.js";
import { dispatchWebhook } from "./handlers/webhookRouter.js";
import { expireOldConversations } from "./services/conversationService.js";
import { runGateQueueTick } from "./services/gateQueueWorker.js";
import { runSnapshotTick } from "./services/snapshotWorker.js";
import { runFeedFollowSnapshotTick } from "./services/feedFollowSnapshotWorker.js";
import { runGeminiQueueTick } from "./services/geminiQueueWorker.js";
import { runFollowRecheckTick } from "./services/followRecheckWorker.js";
import { runFollowThroughTick } from "./services/followThroughWorker.js";
import { runReplyDraftTick } from "./services/replyDraftWorker.js";
import { runReplyDraftRecoveryTick } from "./services/replyDraftRecoveryWorker.js";
import { startDmRecoveryScheduler } from "./services/dmRecoveryScheduler.js";
import { runDmRecoveryTick } from "./services/dmRecoveryWorker.js";
import { runHistoricalRecoveryTick } from "./services/historicalRecoveryWorker.js";
import { runOriginEnrichmentTick } from "./services/originEnrichmentWorker.js";
import { internalAiRouter } from "./api/internalAi.routes.js";
import { seedTokenFromEnv } from "./meta/tokenStore.js";
import { runTokenRefreshTick } from "./meta/tokenRefresher.js";
import { apiRouter } from "./api/router.js";

const app = express();

const allowedOrigins = (env.WEB_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  "/api",
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      cb(null, allowedOrigins.includes(origin));
    },
    credentials: false,
  }),
);

app.use(express.json({ verify: captureRawBody, limit: "1mb" }));

// Advisor data tools for the Codex runtime. Mounted here — after the JSON body
// parser it needs, but ABOVE the owner's /api router — so it inherits neither the
// browser CORS policy (scoped to /api) nor Supabase requireAdmin. A Supabase user
// token cannot open these, and the internal service token cannot open /api.
app.use("/internal/ai", internalAiRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true, env: env.NODE_ENV });
});

app.get("/webhook", handleVerification);

app.post("/webhook", verifyMetaSignature, async (req, res) => {
  res.sendStatus(200);
  try {
    await dispatchWebhook(req.body);
  } catch {
    logger.error({ errorCode: "webhook_dispatch_failed" }, "dispatchWebhook failed after ack");
  }
});

app.use("/api", apiRouter);

const EXPIRY_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  expireOldConversations()
    .then((r) => {
      if (r.count > 0) logger.info({ expired: r.count }, "Conversations expired");
    })
    .catch((err) => logger.error({ err }, "expireOldConversations failed"));
}, EXPIRY_INTERVAL_MS);

// Gate retry worker: re-attempts failed comment→DM private replies across their
// 7-day window, paced to slip under the account rate limit. runGateQueueTick is
// non-throwing, so a failure here can't crash the server.
const GATE_RETRY_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  void runGateQueueTick();
}, GATE_RETRY_INTERVAL_MS);

// Insights snapshot worker: periodically captures per-reel performance metrics
// and account-level audience geography, and enqueues new reels for Gemini
// analysis. Self-throttles on the newest snapshot age, and runSnapshotTick is
// non-throwing, so a small interval or a Graph failure can't crash the server.
setInterval(() => {
  void runSnapshotTick();
}, env.SNAPSHOT_INTERVAL_MS);

// Regular FEED-post attribution is isolated from Reel analytics because Meta
// supports the lifetime `follows` metric for posts but not Reels. Multiple
// retries can update today's row without creating more than one daily snapshot.
setInterval(() => {
  void runFeedFollowSnapshotTick();
}, env.FEED_FOLLOW_SNAPSHOT_INTERVAL_MS);

// Gemini analysis worker: drains the queue of reels awaiting a content profile,
// paced and capped by the daily budget. No-ops when GEMINI_API_KEY is unset.
setInterval(() => {
  void runGeminiQueueTick();
}, env.GEMINI_QUEUE_INTERVAL_MS);

// Follow-recheck worker: re-reads follow status a few days after a guide is
// delivered to a non-follower, so the funnel's follower yield becomes visible.
// Non-throwing and tiny (~25 users/week), so it can't disturb the server.
setInterval(() => {
  void runFollowRecheckTick();
}, env.FOLLOW_RECHECK_INTERVAL_MS);

// Follow-through worker: re-reads follow status ~3 weeks after a guide recipient
// was counted as a conversion, so "23 of 97 followed" can be checked against
// whether they STAYED. Unlike the recheck worker it always makes a live Graph
// call — every convert is cached as a follower by definition, so trusting the
// cache would report 100% retention unconditionally.
//
// Hourly: the eligible pool is tiny (~59 users once, then a trickle) and the
// batch cap bounds each tick. Non-throwing.
const FOLLOW_THROUGH_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  void runFollowThroughTick();
}, FOLLOW_THROUGH_INTERVAL_MS);

// Token refresh worker: keeps the Instagram access token from ever expiring.
// Meta's long-lived tokens last 60 days and each refresh resets that clock to 60
// days from the refresh, so a 6-hourly tick (with the weekly/urgent rules in
// tokenStoreCore) holds the token permanently ~53 days from expiry.
//
// 6h rather than 24h so a transient Meta failure still has three more attempts
// before the day is out. runTokenRefreshTick is non-throwing, and the first
// ticks after a manual re-mint no-op quietly until the token clears Meta's 24h
// minimum age.
const TOKEN_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  void runTokenRefreshTick();
}, TOKEN_REFRESH_INTERVAL_MS);

// Reply-draft worker: turns queued unhandled DMs into pending suggestions for the
// owner to approve. Gated on AI_DRAFTS_ENABLED (off by default), non-throwing, and
// it never sends a message — approval is a separate, explicit owner action. Only
// started when the flag is on, so it costs nothing until the feature is enabled.
if (env.AI_DRAFTS_ENABLED) {
  setInterval(() => {
    void runReplyDraftTick();
  }, env.AI_DRAFT_INTERVAL_MS);
}

// A crash after Instagram accepted a send but before local state was finalized
// leaves `sending` ambiguous. Reconcile it to a terminal, owner-check-required
// state; this worker never retries or calls Instagram.
const REPLY_DRAFT_RECOVERY_INTERVAL_MS = 15 * 60 * 1000;
function recoverStaleReplyDraftSends(): void {
  void runReplyDraftRecoveryTick()
    .then((count) => {
      if (count > 0) {
        logger.warn({ recovered: count }, "Stale AI reply sends marked uncertain");
      }
    })
    .catch(() => {
      logger.error(
        { errorCode: "reply_draft_recovery_failed" },
        "Reply draft recovery failed",
      );
    });
}
setInterval(recoverStaleReplyDraftSends, REPLY_DRAFT_RECOVERY_INTERVAL_MS);

startDmRecoveryScheduler({
  enabled: env.DM_RECOVERY_ENABLED,
  intervalMs: env.DM_RECOVERY_WORKER_INTERVAL_MS,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  runTick: runDmRecoveryTick,
});

// Historical recovery (Feature 4). Reuses the same scheduler so a tick that throws
// cannot take down the webhook server, and runs on a slower interval because these
// sends are paced by campaign caps rather than by how fast candidates arrive.
//
// Requires BOTH flags plus an owner-approved `running` campaign. With no approved
// campaign the tick finds nothing and does nothing, so starting it is not the same
// as starting to send.
startDmRecoveryScheduler({
  enabled: env.DM_RECOVERY_ENABLED && env.DM_RECOVERY_HISTORICAL_ENABLED,
  intervalMs: env.DM_RECOVERY_HISTORICAL_INTERVAL_MS,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  runTick: runHistoricalRecoveryTick,
});

// Origin enrichment runs on its own switch, independent of DM_RECOVERY_ENABLED:
// the column is worth populating and auditing before it gates any send, and the
// recovery gate falls back to the name-token screen whenever it is absent.
startDmRecoveryScheduler({
  enabled: env.DM_RECOVERY_ORIGIN_LLM_ENABLED,
  intervalMs: env.DM_RECOVERY_ORIGIN_INTERVAL_MS,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  runTick: runOriginEnrichmentTick,
});

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "insta-automation listening");
  // Make sure ig_token exists (and honours a hand-pasted env override) before
  // any worker tick fires. Non-throwing: getAccessToken falls back to env.
  void seedTokenFromEnv().then(() => {
    void runTokenRefreshTick();
    void runFeedFollowSnapshotTick();
  });
  recoverStaleReplyDraftSends();
});
