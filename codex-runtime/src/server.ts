import pino from "pino";
import { createAccountService } from "./accountService.js";
import { createAdvisorService } from "./advisorService.js";
import { createAdvisorSessionStore } from "./advisorSessionStore.js";
import { createDraftService } from "./draftService.js";
import { createInternalApiClient } from "./internalApiClient.js";
import { startAppServerClient } from "./appServerClient.js";
import { createRuntimeApp } from "./app.js";
import { parseRuntimeConfig } from "./config.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);

  // app-server starts BEFORE listening: a runtime that accepts requests it cannot
  // serve would report itself healthy to Railway while every call 503s.
  const appServer = await startAppServerClient(config);
  let ready = true;

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

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "codex runtime listening");
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    logger.info({ signal }, "codex runtime shutting down");
    // HTTP closes first so an in-flight request can finish against a live
    // app-server; stopping the child first would fail those requests.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await appServer.stop();
    process.exit(0);
  };

  process.on("SIGTERM", (signal) => void shutdown(signal));
  process.on("SIGINT", (signal) => void shutdown(signal));
}

main().catch((error: unknown) => {
  // Never log the raw error: an app-server startup failure can embed account or
  // token detail. Only the message is emitted.
  logger.error(
    { message: error instanceof Error ? error.message : "unknown startup failure" },
    "codex runtime failed to start",
  );
  process.exit(1);
});
