import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AppServerClient, AppServerDependencies } from "./appServerClient.js";
import type { RuntimeConfig } from "./config.js";
import { startRuntime } from "./server.js";

const config: RuntimeConfig = {
  PORT: 0,
  NODE_ENV: "test",
  CODEX_HOME: "/tmp/tinysoho-test-codex-home",
  CODEX_WORKSPACE: "/tmp/tinysoho-test-codex-workspace",
  RUNTIME_SHARED_SECRET: "r".repeat(32),
};

function fakeAppServer(): AppServerClient {
  return {
    request: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(() => () => undefined),
    onRequest: vi.fn(() => () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

describe("startRuntime", () => {
  it("fails readiness and terminates after an unexpected app-server exit", async () => {
    let onUnexpectedExit: AppServerDependencies["onUnexpectedExit"];
    const exit = vi.fn();
    const appServer = fakeAppServer();
    const runtime = await startRuntime({
      config,
      exit,
      startAppServerClient: vi.fn(async (_config, dependencies) => {
        onUnexpectedExit = dependencies.onUnexpectedExit;
        return appServer;
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await request(runtime.app)
      .get("/health")
      .expect(200, { ok: true, appServerReady: true });

    onUnexpectedExit!(new Error("private child failure"));

    await request(runtime.app)
      .get("/health")
      .expect(200, { ok: true, appServerReady: false });
    await vi.waitFor(() => expect(runtime.server.listening).toBe(false));
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("logs only a stable lifecycle category when the app-server exits", async () => {
    let onUnexpectedExit: AppServerDependencies["onUnexpectedExit"];
    const error = vi.fn();
    const runtime = await startRuntime({
      config,
      exit: vi.fn(),
      startAppServerClient: vi.fn(async (_config, dependencies) => {
        onUnexpectedExit = dependencies.onUnexpectedExit;
        return fakeAppServer();
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error },
    });

    onUnexpectedExit!(new Error("token-and-prompt-must-not-be-logged"));
    await vi.waitFor(() => expect(runtime.server.listening).toBe(false));

    expect(error).toHaveBeenCalledWith(
      "Codex app-server exited; terminating runtime for platform restart",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("token-and-prompt-must-not-be-logged");
  });

  it("uses the fallback to exit once when HTTP shutdown does not complete", async () => {
    let onUnexpectedExit: AppServerDependencies["onUnexpectedExit"];
    const exit = vi.fn();
    const runtime = await startRuntime({
      config,
      exit,
      startAppServerClient: vi.fn(async (_config, dependencies) => {
        onUnexpectedExit = dependencies.onUnexpectedExit;
        return fakeAppServer();
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const close = runtime.server.close.bind(runtime.server);
    vi.useFakeTimers();
    runtime.server.close = vi.fn(() => runtime.server);

    onUnexpectedExit!(new Error("child exited"));
    onUnexpectedExit!(new Error("duplicate event"));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runtime.server.close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);

    vi.useRealTimers();
    await new Promise<void>((resolve) => close(() => resolve()));
  });

  it("suppresses crash termination while clean shutdown stops the child", async () => {
    let onUnexpectedExit: AppServerDependencies["onUnexpectedExit"];
    const exit = vi.fn();
    const error = vi.fn();
    const appServer = fakeAppServer();
    appServer.stop = vi.fn(async () => {
      onUnexpectedExit!(new Error("exit caused by stop"));
    });
    const runtime = await startRuntime({
      config,
      exit,
      startAppServerClient: vi.fn(async (_config, dependencies) => {
        onUnexpectedExit = dependencies.onUnexpectedExit;
        return appServer;
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error },
    });

    await runtime.shutdown("SIGTERM");

    expect(error).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("fails startup without listening when the child exits during readiness", async () => {
    const exit = vi.fn();
    const start = startRuntime({
      config,
      exit,
      startAppServerClient: vi.fn(async (_config, dependencies) => {
        dependencies.onUnexpectedExit!(new Error("child exited during initialize"));
        return fakeAppServer();
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(start).rejects.toThrow("app-server exited during runtime startup");
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
