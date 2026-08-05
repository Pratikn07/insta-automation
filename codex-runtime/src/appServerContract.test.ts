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
});
