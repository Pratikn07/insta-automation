import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "./config.js";
import { JsonRpcPeer } from "./protocol.js";
import type { RpcRequestHandler } from "./protocol.js";

export interface AppServerClient {
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
  onRequest(method: string, handler: RpcRequestHandler): () => void;
  stop(): Promise<void>;
}

export type SpawnAppServer = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface AppServerDependencies {
  spawn?: SpawnAppServer;
  codexBin?: string;
}

const disabledFeatures = [
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
] as const;

function buildArgs(): string[] {
  const args = ["app-server", "--stdio"];
  for (const feature of disabledFeatures) args.push("--disable", feature);
  args.push(
    "-c",
    "analytics.enabled=false",
    "-c",
    "shell_environment_policy.inherit=none",
    "-c",
    'cli_auth_credentials_store="file"',
  );
  return args;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export async function startAppServerClient(
  config: RuntimeConfig,
  dependencies: AppServerDependencies = {},
): Promise<AppServerClient> {
  await Promise.all([
    mkdir(config.CODEX_HOME, { recursive: true }),
    mkdir(config.CODEX_WORKSPACE, { recursive: true }),
  ]);

  const spawn = dependencies.spawn ?? (nodeSpawn as SpawnAppServer);
  const codexBin = dependencies.codexBin ?? path.resolve(process.cwd(), "node_modules/.bin/codex");
  const child = spawn(codexBin, buildArgs(), {
    cwd: config.CODEX_WORKSPACE,
    env: {
      PATH: process.env.PATH,
      CODEX_HOME: config.CODEX_HOME,
      NODE_ENV: config.NODE_ENV,
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const peer = new JsonRpcPeer(child.stdout, child.stdin);
  let stopping = false;
  let exited = false;

  // Drain diagnostics so the child cannot block on a full stderr pipe. Runtime
  // account and authentication details are intentionally never forwarded.
  child.stderr.on("data", () => undefined);
  child.once("error", (error) => peer.close(error));
  child.once("exit", (code, signal) => {
    exited = true;
    const detail = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
    peer.close(
      stopping
        ? new Error("app-server stopped")
        : new Error(`app-server exited unexpectedly with ${detail}`),
    );
  });

  try {
    await peer.request(
      "initialize",
      {
        clientInfo: {
          name: "tiny-soho-codex-runtime",
          title: "Tiny SOHO",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
      10_000,
    );
    peer.notify("initialized");
  } catch (error) {
    stopping = true;
    child.kill("SIGTERM");
    throw error;
  }

  return {
    request: <T>(method: string, params: unknown, timeoutMs?: number) =>
      peer.request<T>(method, params, timeoutMs),
    notify: (method: string, params?: unknown) => peer.notify(method, params),
    onNotification: (method: string, handler: (params: unknown) => void) =>
      peer.onNotification(method, handler),
    onRequest: (method: string, handler: RpcRequestHandler) => peer.onRequest(method, handler),
    stop: async () => {
      if (exited || stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      await waitForExit(child, 5_000);
      if (!exited) {
        child.kill("SIGKILL");
        await waitForExit(child, 1_000);
      }
      peer.close(new Error("app-server stopped"));
    },
  };
}
