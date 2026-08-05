import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import type { AccountService } from "./accountService.js";
import { requireRuntimeSecret } from "./auth.js";

export interface RuntimeAppDependencies {
  accountService: AccountService;
  runtimeSecret: string;
  appServerReady: () => boolean;
}

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

  app.use("/internal", internal);

  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(502).json({ error: "app_server_unavailable" });
  });

  return app;
}
