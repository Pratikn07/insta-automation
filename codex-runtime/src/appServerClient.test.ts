import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "./config.js";
import { startAppServerClient } from "./appServerClient.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    queueMicrotask(() => this.emit("exit", 0, signal ?? null));
    return true;
  });
  exitCode: number | null = null;

  constructor(respondToInitialize = true) {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) {
          const message = JSON.parse(line) as { id?: number; method: string };
          if (respondToInitialize && message.method === "initialize" && message.id !== undefined) {
            this.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "fake" } })}\n`);
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
  }
}

const config: RuntimeConfig = {
  PORT: 3001,
  NODE_ENV: "test",
  CODEX_HOME: "/tmp/tinysoho-test-codex-home",
  CODEX_WORKSPACE: "/tmp/tinysoho-test-codex-workspace",
  RUNTIME_SHARED_SECRET: "r".repeat(32),
};

describe("startAppServerClient", () => {
  it("starts stdio app-server with isolated environment and disabled capabilities", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(
      (_command: string, _args: readonly string[], _options: SpawnOptionsWithoutStdio) =>
        child as unknown as ChildProcessWithoutNullStreams,
    );

    const client = await startAppServerClient(config, { spawn, codexBin: "/runtime/codex" });
    const [command, args, options] = spawn.mock.calls[0] ?? [];

    expect(command).toBe("/runtime/codex");
    expect(args).toEqual(
      expect.arrayContaining([
        "app-server",
        "--stdio",
        "shell_tool",
        "browser_use",
        "browser_use_external",
        "in_app_browser",
        "computer_use",
        "apps",
        "plugins",
        "hooks",
        "multi_agent",
        "image_generation",
        "workspace_dependencies",
        "analytics.enabled=false",
        "shell_environment_policy.inherit=none",
        'cli_auth_credentials_store="file"',
      ]),
    );
    expect(options).toMatchObject({
      cwd: config.CODEX_WORKSPACE,
      env: {
        PATH: process.env.PATH,
        CODEX_HOME: config.CODEX_HOME,
        NODE_ENV: "test",
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(Object.keys((options as SpawnOptionsWithoutStdio).env ?? {}).sort()).toEqual([
      "CODEX_HOME",
      "LANG",
      "LC_ALL",
      "NODE_ENV",
      "PATH",
    ]);

    await client.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("sends initialize before initialized", async () => {
    const child = new FakeChild();
    const messages: Array<{ id?: number; method: string }> = [];
    child.stdin.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) {
        if (line) messages.push(JSON.parse(line) as { id?: number; method: string });
      }
    });
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);

    const client = await startAppServerClient(config, { spawn, codexBin: "/runtime/codex" });
    // `initialized` is a notification, so nothing awaits it. JsonRpcPeer serializes
    // every write through one queue, which means the notification is still queued
    // when startAppServerClient resolves — yield once so it reaches the stream.
    await new Promise((resolve) => setImmediate(resolve));

    expect(messages.map(({ method }) => method)).toEqual(["initialize", "initialized"]);
    expect(messages[0]).toMatchObject({ id: 1, method: "initialize" });
    expect(messages[1]).not.toHaveProperty("id");
    await client.stop();
  });

  it("rejects pending calls when the child exits", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const client = await startAppServerClient(config, { spawn, codexBin: "/runtime/codex" });

    const pending = client.request("account/read", {}, 1_000);
    child.emit("exit", 1, null);

    await expect(pending).rejects.toThrow("app-server exited unexpectedly with code 1");
  });

  it("reports an unexpected child exit to its lifecycle owner", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const onUnexpectedExit = vi.fn();
    await startAppServerClient(config, {
      spawn,
      codexBin: "/runtime/codex",
      onUnexpectedExit,
    });

    child.emit("exit", 17, null);

    expect(onUnexpectedExit).toHaveBeenCalledOnce();
    expect(onUnexpectedExit.mock.calls[0]![0].message).toContain("code 17");
  });

  it("does not report an intentional stop as an unexpected exit", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const onUnexpectedExit = vi.fn();
    const client = await startAppServerClient(config, {
      spawn,
      codexBin: "/runtime/codex",
      onUnexpectedExit,
    });

    const stopping = client.stop();
    child.stdout.emit("close");
    child.stdin.emit("close");
    await stopping;
    child.emit("exit", 0, null);

    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it("reports and rejects an exit during the initialization handshake", async () => {
    const child = new FakeChild(false);
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const onUnexpectedExit = vi.fn();
    const firstWrite = once(child.stdin, "data");

    const starting = startAppServerClient(config, {
      spawn,
      codexBin: "/runtime/codex",
      onUnexpectedExit,
    });
    await firstWrite;
    child.emit("exit", null, "SIGKILL");

    await expect(starting).rejects.toThrow("app-server exited unexpectedly with signal SIGKILL");
    expect(onUnexpectedExit).toHaveBeenCalledOnce();
  });

  it("reports a child process error only once when exit follows", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const onUnexpectedExit = vi.fn();
    await startAppServerClient(config, {
      spawn,
      codexBin: "/runtime/codex",
      onUnexpectedExit,
    });

    child.emit("error", new Error("spawn failed"));
    child.emit("exit", 1, null);

    expect(onUnexpectedExit).toHaveBeenCalledOnce();
  });
});
