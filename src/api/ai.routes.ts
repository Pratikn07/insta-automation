import { Router } from "express";
import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { CodexRuntimeError, createCodexRuntimeClient } from "../services/codexRuntimeClient.js";
import type { CodexRuntimeClient } from "../services/codexRuntimeClient.js";

/**
 * Owner-facing AI routes. Mounted under the apiRouter, so `requireAdmin` has
 * already run — but nothing here trusts the runtime's output shape or forwards
 * its error text, because a runtime message can carry account detail.
 *
 * The client is injected so tests can drive failure modes without a live
 * runtime; production uses the env-configured singleton below.
 */
export interface AiRouterDependencies {
  client: CodexRuntimeClient;
  isConfigured: () => boolean;
}

/** Translate a runtime failure into a browser-safe status and code. */
function sendRuntimeError(res: Response, error: unknown): void {
  if (error instanceof CodexRuntimeError) {
    const status =
      error.code === "ai_not_configured"
        ? 503
        : error.code === "runtime_rate_limited"
          ? 429
          : error.code === "runtime_unauthorized"
            ? 502
            : error.code === "runtime_timeout" || error.code === "runtime_unavailable"
              ? 503
              : 502;
    res.status(status).json({
      error: error.code,
      retryAt: error.retryAt ? error.retryAt.toISOString() : null,
    });
    return;
  }
  // Unexpected failures are logged server-side only. The message can embed a
  // token or account detail, so the browser gets a generic code.
  logger.error({ err: error }, "AI route failed");
  res.status(502).json({ error: "ai_runtime_error" });
}

export function createAiRouter(deps: AiRouterDependencies): Router {
  const router = Router();

  // One guard for every route: an unconfigured runtime is answered identically
  // and without touching the client, so a partial deploy cannot half-work.
  router.use((_req: Request, res: Response, next) => {
    if (!deps.isConfigured()) {
      res.status(503).json({ error: "ai_not_configured" });
      return;
    }
    next();
  });

  router.get("/connection", async (req, res) => {
    try {
      res.json(await deps.client.getConnectionStatus(req.query.refresh === "true"));
    } catch (error) {
      sendRuntimeError(res, error);
    }
  });

  router.post("/connection", async (_req, res) => {
    try {
      res.json(await deps.client.startDeviceLogin());
    } catch (error) {
      sendRuntimeError(res, error);
    }
  });

  router.post("/disconnect", async (_req, res) => {
    try {
      await deps.client.disconnect();
      res.status(204).end();
    } catch (error) {
      sendRuntimeError(res, error);
    }
  });

  return router;
}

export const aiRouter = createAiRouter({
  client: createCodexRuntimeClient({
    baseUrl: env.CODEX_RUNTIME_URL,
    token: env.CODEX_RUNTIME_TOKEN,
  }),
  isConfigured: () => Boolean(env.CODEX_RUNTIME_URL && env.CODEX_RUNTIME_TOKEN),
});
