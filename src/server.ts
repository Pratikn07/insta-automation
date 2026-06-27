import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { captureRawBody, handleVerification, verifyMetaSignature } from "./meta/verifyWebhook.js";
import { dispatchWebhook } from "./handlers/webhookRouter.js";
import { expireOldConversations } from "./services/conversationService.js";
import { runGateQueueTick } from "./services/gateQueueWorker.js";
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

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "insta-automation listening");
});
