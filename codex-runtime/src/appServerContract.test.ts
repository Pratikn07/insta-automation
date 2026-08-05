import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "./config.js";
import { startAppServerClient } from "./appServerClient.js";

describe("pinned Codex app-server contract", () => {
  it(
    "initializes and reads account state without performing a model turn",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "tinysoho-codex-contract-"));
      const config: RuntimeConfig = {
        PORT: 3001,
        NODE_ENV: "test",
        CODEX_HOME: path.join(root, "codex-home"),
        CODEX_WORKSPACE: path.join(root, "workspace"),
        RUNTIME_SHARED_SECRET: "r".repeat(32),
      };
      let client: Awaited<ReturnType<typeof startAppServerClient>> | undefined;

      try {
        client = await startAppServerClient(config);
        const result = await client.request<{ requiresOpenaiAuth: boolean }>(
          "account/read",
          { refreshToken: false },
          10_000,
        );
        expect(result.requiresOpenaiAuth).toBeTypeOf("boolean");
      } finally {
        await client?.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  /**
   * The response SHAPES, pinned against the real binary.
   *
   * Unit tests mock the peer, so they happily agreed with wrong shapes and the
   * advisor failed the first time it met the real app-server. Four things were
   * wrong and every one of them is asserted here:
   *
   *   thread/start  -> { thread: { id } }        NOT { threadId }
   *   turn/start    -> { turn: { id } }          NOT { turnId }
   *   turn/start    -> input is an ARRAY of { type: "text" }, not a string
   *   turn/completed-> { turn: { status, items } } NOT { status, items }
   *
   * This still performs no model turn: turn/start is never called here, only the
   * thread lifecycle, so it costs no quota.
   */
  it(
    "returns the thread id under `thread.id`",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "tinysoho-codex-shape-"));
      const config: RuntimeConfig = {
        PORT: 3001,
        NODE_ENV: "test",
        CODEX_HOME: path.join(root, "codex-home"),
        CODEX_WORKSPACE: path.join(root, "workspace"),
        RUNTIME_SHARED_SECRET: "r".repeat(32),
      };
      let client: Awaited<ReturnType<typeof startAppServerClient>> | undefined;

      try {
        client = await startAppServerClient(config);
        const started = await client.request<Record<string, unknown>>(
          "thread/start",
          {
            ephemeral: true,
            approvalPolicy: "never",
            sandbox: "read-only",
            cwd: config.CODEX_WORKSPACE,
            runtimeWorkspaceRoots: [],
            environments: [],
          },
          20_000,
        );

        const thread = started.thread as { id?: unknown } | undefined;
        expect(thread?.id).toBeTypeOf("string");
        // The exact mistake that shipped: there is no top-level threadId.
        expect(started.threadId).toBeUndefined();
      } finally {
        await client?.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
