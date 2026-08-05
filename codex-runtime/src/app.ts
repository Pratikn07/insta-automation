import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import type { AccountService } from "./accountService.js";
import type { AdvisorService } from "./advisorService.js";
import { AdvisorError } from "./advisorService.js";
import type { DraftService } from "./draftService.js";
import { DraftGenerationError } from "./draftService.js";
import { advisorRequestSchema, dmDraftRequestSchema } from "./schemas.js";
import { requireRuntimeSecret } from "./auth.js";

export interface RuntimeAppDependencies {
  accountService: AccountService;
  draftService: DraftService;
  advisorService: AdvisorService;
  runtimeSecret: string;
  appServerReady: () => boolean;
}

/** AdvisorError code → HTTP status. Only the code and retryAt cross back. */
const ADVISOR_ERROR_STATUS: Record<AdvisorError["code"], number> = {
  advisor_not_configured: 503,
  not_connected: 401,
  usage_limited: 429,
  turn_timeout: 504,
  invalid_advisor_output: 503,
  advisor_unavailable: 503,
};

/** DraftGenerationError code → HTTP status. Only the code and retryAt cross back. */
const DRAFT_ERROR_STATUS: Record<DraftGenerationError["code"], number> = {
  invalid_draft_output: 503,
  turn_incomplete: 503,
  turn_timeout: 504,
  usage_limited: 429,
  app_server_unauthenticated: 401,
  draft_unavailable: 503,
};

/**
 * The runtime's entire HTTP surface. Four routes, no more: a public health probe
 * for Railway, and three private account routes for the existing Tiny SOHO API.
 *
 * Every app-server failure collapses to a generic `app_server_unavailable`. The
 * underlying message can embed account or token detail, so it is logged nowhere
 * near the response body and never forwarded to the caller.
 */
export function createRuntimeApp(deps: RuntimeAppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, appServerReady: deps.appServerReady() });
  });

  const internal = express.Router();
  internal.use(requireRuntimeSecret(deps.runtimeSecret));
  // Authenticated but unusable is still a failure the caller must distinguish
  // from a bad token, so readiness is checked after auth.
  internal.use((_req, res, next) => {
    if (!deps.appServerReady()) {
      res.status(503).json({ error: "app_server_not_ready" });
      return;
    }
    next();
  });

  internal.get("/account/status", async (req, res, next) => {
    try {
      res.json(await deps.accountService.status(req.query.refresh === "true"));
    } catch (error) {
      next(error);
    }
  });

  internal.post("/account/login/start", async (_req, res, next) => {
    try {
      res.json(await deps.accountService.startDeviceLogin());
    } catch (error) {
      next(error);
    }
  });

  internal.post("/account/logout", async (_req, res, next) => {
    try {
      await deps.accountService.logout();
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  internal.post("/drafts/generate", async (req, res) => {
    const parsed = dmDraftRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      res.json(await deps.draftService.generate(parsed.data));
    } catch (error) {
      // Only the safe category and retry hint cross back; a raw app-server
      // message can embed account or token detail.
      if (error instanceof DraftGenerationError) {
        res.status(DRAFT_ERROR_STATUS[error.code]).json({
          error: error.code,
          retryAt: error.retryAt ? error.retryAt.toISOString() : null,
        });
        return;
      }
      res.status(503).json({ error: "draft_unavailable", retryAt: null });
    }
  });

  internal.get("/advisor/history", async (_req, res) => {
    try {
      res.json({ items: await deps.advisorService.history() });
    } catch {
      // History is a convenience; an empty list beats an error page.
      res.json({ items: [] });
    }
  });

  internal.post("/advisor/messages", async (req, res) => {
    const parsed = advisorRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      res.json(await deps.advisorService.ask(parsed.data));
    } catch (error) {
      if (error instanceof AdvisorError) {
        res.status(ADVISOR_ERROR_STATUS[error.code]).json({
          error: error.code,
          retryAt: error.retryAt ? error.retryAt.toISOString() : null,
        });
        return;
      }
      res.status(503).json({ error: "advisor_unavailable", retryAt: null });
    }
  });

  app.use("/internal", internal);

  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(502).json({ error: "app_server_unavailable" });
  });

  return app;
}
