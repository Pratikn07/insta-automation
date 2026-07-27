import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { captureRawBody, handleVerification, verifyMetaSignature } from "./meta/verifyWebhook.js";
import { dispatchWebhook } from "./handlers/webhookRouter.js";
import { expireOldConversations } from "./services/conversationService.js";
import { runGateQueueTick } from "./services/gateQueueWorker.js";
import { runSnapshotTick } from "./services/snapshotWorker.js";
import { runGeminiQueueTick } from "./services/geminiQueueWorker.js";
import { runFollowRecheckTick } from "./services/followRecheckWorker.js";
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

app.get("/health", (_req, res) => {
  res.json({ ok: true, env: env.NODE_ENV });
});

app.get("/webhook", handleVerification);

app.post("/webhook", verifyMetaSignature, async (req, res) => {
  res.sendStatus(200);
  try {
    await dispatchWebhook(req.body);
  } catch (err) {
    logger.error({ err }, "dispatchWebhook failed after ack");
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

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "insta-automation listening");
  // Make sure ig_token exists (and honours a hand-pasted env override) before
  // any worker tick fires. Non-throwing: getAccessToken falls back to env.
  void seedTokenFromEnv().then(() => runTokenRefreshTick());
});
