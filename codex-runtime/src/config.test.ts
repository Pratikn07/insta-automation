import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "./config.js";

describe("parseRuntimeConfig", () => {
  it("uses safe local defaults and strips unrelated secrets", () => {
    const config = parseRuntimeConfig({
      RUNTIME_SHARED_SECRET: "r".repeat(32),
      OPENAI_API_KEY: "must-not-be-consumed",
      DATABASE_URL: "postgres://must-not-be-consumed",
    });

    expect(config).toEqual({
      PORT: 3001,
      NODE_ENV: "development",
      CODEX_HOME: "/tmp/tinysoho-codex-home",
      CODEX_WORKSPACE: "/tmp/tinysoho-codex-workspace",
      RUNTIME_SHARED_SECRET: "r".repeat(32),
    });
  });

  it("rejects a short runtime secret", () => {
    expect(() => parseRuntimeConfig({ RUNTIME_SHARED_SECRET: "too-short" })).toThrow();
  });
});
