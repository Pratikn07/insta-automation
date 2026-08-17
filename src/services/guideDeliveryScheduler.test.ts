import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

const loggerError = vi.fn();
vi.mock("../lib/logger.js", () => ({ logger: { error: loggerError, info: vi.fn(), warn: vi.fn() } }));
const { startGuideDeliveryScheduler } = await import("./guideDeliveryScheduler.js");

beforeEach(() => loggerError.mockReset());

describe("guide delivery scheduler", () => {
  it("runs immediately, prevents overlap, and stops its interval", async () => {
    let intervalCallback: (() => void) | undefined;
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const runTick = vi.fn<() => Promise<unknown>>().mockImplementationOnce(() => first).mockResolvedValue({});
    const clearInterval = vi.fn();
    const handle = Symbol("timer");
    const stop = startGuideDeliveryScheduler({
      intervalMs: 60_000,
      setInterval: vi.fn((callback: () => void) => { intervalCallback = callback; return handle as never; }),
      clearInterval: clearInterval as never,
      runTick,
    });
    expect(runTick).toHaveBeenCalledOnce();
    intervalCallback!();
    await Promise.resolve();
    expect(runTick).toHaveBeenCalledOnce();
    resolveFirst();
    await first;
    await Promise.resolve();
    intervalCallback!();
    await Promise.resolve();
    expect(runTick).toHaveBeenCalledTimes(2);
    stop();
    expect(clearInterval).toHaveBeenCalledWith(handle);
  });

  it.each(["reject", "throw"])("contains a tick that %s", async (kind) => {
    const runTick = kind === "throw"
      ? vi.fn(() => { throw new Error("private failure"); })
      : vi.fn().mockRejectedValue(new Error("private failure"));
    expect(() => startGuideDeliveryScheduler({
      intervalMs: 60_000,
      setInterval: vi.fn() as never,
      clearInterval: vi.fn() as never,
      runTick: runTick as never,
    })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loggerError).toHaveBeenCalledWith(
      { errorCode: "guide_delivery_tick_rejected" },
      "Guide delivery tick rejected",
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain("private failure");
  });

  it("closes a real HTTP server and preserves SIGTERM termination after quiescing work", async () => {
    const modulePath = path.resolve("src/services/guideDeliveryScheduler.ts");
    const child = spawn(
      process.execPath,
      [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        "-e",
        `
          import { createServer } from "node:http";
          import { writeSync } from "node:fs";
          import { bindGuideDeliveryServerShutdown } from ${JSON.stringify(modulePath)};
          const interval = setInterval(() => undefined, 1_000);
          const server = createServer((_req, res) => res.end("ok"));
          bindGuideDeliveryServerShutdown({
            server,
            stopOwnedWork: () => {
              clearInterval(interval);
              writeSync(1, "STOPPED\\n");
            },
          });
          server.listen(0, () => console.log("READY"));
        `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`child did not start: ${output}`)), 2_000);
      child.stdout.on("data", () => {
        if (output.includes("READY")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    child.kill("SIGTERM");
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`child did not terminate after SIGTERM: ${output}`));
      }, 2_000);
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });

    // tsx's Node wrapper converts the re-delivered signal into its conventional
    // process status; either way this proves the child did not remain alive on
    // the HTTP listener or interval after graceful cleanup.
    expect(exit).toEqual({ code: 143, signal: null });
    expect(output).toContain("STOPPED");
  });
});
