import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import type { Logger } from "pino";
import type { Express } from "express";
import { createAccountService } from "./accountService.js";
import { createAdvisorService } from "./advisorService.js";
import { createAdvisorSessionStore } from "./advisorSessionStore.js";
import { createDraftService } from "./draftService.js";
import { createInternalApiClient } from "./internalApiClient.js";
import { startAppServerClient } from "./appServerClient.js";
import type { AppServerDependencies, AppServerClient } from "./appServerClient.js";
import { createRuntimeApp } from "./app.js";
import { parseRuntimeConfig } from "./config.js";
import type { RuntimeConfig } from "./config.js";

type RuntimeLogger = Pick<Logger, "info" | "warn" | "error">;
type StartAppServerClient = (
  config: RuntimeConfig,
  dependencies?: AppServerDependencies,
) => Promise<AppServerClient>;

export interface RuntimeSignalSource {
  on(signal: "SIGTERM" | "SIGINT", listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: "SIGTERM" | "SIGINT", listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface RuntimeDependencies {
  config?: RuntimeConfig;
  exit?: (code: number) => void;
  logger?: RuntimeLogger;
  signalSource?: RuntimeSignalSource;
  startAppServerClient?: StartAppServerClient;
}

export interface RunningRuntime {
  app: Express;
  server: Server;
  shutdown(signal: NodeJS.Signals): Promise<void>;
}

export async function startRuntime(deps: RuntimeDependencies = {}): Promise<RunningRuntime> {
  const config = deps.config ?? parseRuntimeConfig(process.env);
  const logger = deps.logger ?? pino({ level: process.env.LOG_LEVEL ?? "info" });
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const signalSource = deps.signalSource ?? process;
  const startClient = deps.startAppServerClient ?? startAppServerClient;
  let ready = false;
  let server: Server | undefined;
  let terminating = false;
  let shuttingDown = false;
  let exitCalled = false;
  let fallbackExitTimer: NodeJS.Timeout | undefined;
  let signalHandler: ((signal: NodeJS.Signals) => void) | undefined;

  const removeSignalHandlers = (): void => {
    if (!signalHandler) return;
    signalSource.off("SIGTERM", signalHandler);
    signalSource.off("SIGINT", signalHandler);
  };

  const exitOnce = (code: number): void => {
    if (exitCalled) return;
    exitCalled = true;
    if (fallbackExitTimer) clearTimeout(fallbackExitTimer);
    removeSignalHandlers();
    exit(code);
  };

  const handleUnexpectedExit = (): void => {
    if (terminating || shuttingDown) return;
    terminating = true;
    ready = false;
    logger.error("Codex app-server exited; terminating runtime for platform restart");

    if (!server?.listening) {
      exitOnce(1);
      return;
    }

    server.close(() => exitOnce(1));
    fallbackExitTimer = setTimeout(() => exitOnce(1), 5_000);
    fallbackExitTimer.unref();
  };

  // app-server starts BEFORE listening: a runtime that accepts requests it cannot
  // serve would report itself healthy to Railway while every call 503s.
  const appServer = await startClient(config, { onUnexpectedExit: handleUnexpectedExit });
  if (terminating) throw new Error("app-server exited during runtime startup");
  ready = true;

  if (!config.TINY_SOHO_API_URL || !config.TINY_SOHO_INTERNAL_TOKEN) {
    // Not fatal: DM drafting is tool-free and still works. Only the advisor needs
    // the read tools, and it reports itself unavailable rather than speculating.
    logger.warn("advisor data tools unconfigured; advisor routes will report unavailable");
  }

  const app = createRuntimeApp({
    accountService: createAccountService(appServer),
    draftService: createDraftService(appServer),
    advisorService: createAdvisorService({
      appServer,
      internalApi: createInternalApiClient(config),
      store: createAdvisorSessionStore(config),
      config,
    }),
    runtimeSecret: config.RUNTIME_SHARED_SECRET,
    appServerReady: () => ready,
  });

  server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "codex runtime listening");
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown || terminating) return;
    shuttingDown = true;
    ready = false;
    logger.info({ signal }, "codex runtime shutting down");
    // HTTP closes first so an in-flight request can finish against a live
    // app-server; stopping the child first would fail those requests.
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    await appServer.stop();
    exitOnce(0);
  };

  const handleShutdownFailure = (): void => {
    ready = false;
    logger.error("codex runtime shutdown failed; terminating");
    if (server?.listening) {
      try {
        server.close(() => undefined);
      } catch {
        // Process termination remains the final containment boundary.
      }
    }
    exitOnce(1);
  };

  signalHandler = (signal) => {
    void shutdown(signal).catch(handleShutdownFailure);
  };
  signalSource.on("SIGTERM", signalHandler);
  signalSource.on("SIGINT", signalHandler);

  return { app, server, shutdown };
}

async function main(): Promise<void> {
  await startRuntime();
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  main().catch(() => {
    // Startup errors can embed account or token details, so emit only a stable
    // lifecycle category and never the raw error or app-server stderr.
    pino({ level: process.env.LOG_LEVEL ?? "info" }).error("codex runtime failed to start");
    process.exit(1);
  });
}
