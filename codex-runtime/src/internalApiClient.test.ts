import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "./config.js";
import { createInternalApiClient, isAdvisorToolName } from "./internalApiClient.js";

const TOKEN = "i".repeat(32);
let open: Server | null = null;

afterEach(() => {
  open?.close();
  open = null;
});

async function stubApi(
  handler: (req: Parameters<Parameters<typeof createServer>[0]>[0], res: Parameters<Parameters<typeof createServer>[0]>[1]) => void,
): Promise<string> {
  const server = createServer(handler);
  open = server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function configFor(baseUrl: string | undefined, token: string | undefined = TOKEN): RuntimeConfig {
  return {
    PORT: 3001,
    NODE_ENV: "test",
    CODEX_HOME: "/tmp/h",
    CODEX_WORKSPACE: "/tmp/w",
    RUNTIME_SHARED_SECRET: "r".repeat(32),
    TINY_SOHO_API_URL: baseUrl,
    TINY_SOHO_INTERNAL_TOKEN: token,
  } as RuntimeConfig;
}

const OVERVIEW = {
  windowDays: 7,
  guideDeliveries: 42,
  inboundDmCount: 18,
  needsReplyCount: 3,
  approvedReplyCount: 5,
  replyRatePct: 27.8,
  topKeyword: { keyword: "SLEEP", triggers: 14 },
  capturedAt: "2026-08-04T10:00:00.000Z",
};

describe("isAdvisorToolName", () => {
  it("accepts only the three registered names", () => {
    expect(isAdvisorToolName("business_overview")).toBe(true);
    expect(isAdvisorToolName("keyword_guide_catalog")).toBe(true);
    expect(isAdvisorToolName("conversation_summary")).toBe(true);
    for (const bad of ["run_sql", "send_instagram_message", "", "BUSINESS_OVERVIEW"]) {
      expect(isAdvisorToolName(bad)).toBe(false);
    }
  });
});

describe("createInternalApiClient.callTool", () => {
  it("calls the tool's exact URL with the internal token", async () => {
    const seen: Array<{ url?: string; auth?: string }> = [];
    const baseUrl = await stubApi((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(OVERVIEW));
    });

    const client = createInternalApiClient(configFor(baseUrl));
    await expect(client.callTool("business_overview", { windowDays: 7 })).resolves.toMatchObject({
      guideDeliveries: 42,
    });
    expect(seen[0]).toEqual({
      url: "/internal/ai/tools/business_overview",
      auth: `Bearer ${TOKEN}`,
    });
  });

  // There is no generic path method, so an unregistered name cannot reach the API.
  it("rejects an unknown tool without any network call", async () => {
    const client = createInternalApiClient(configFor("http://127.0.0.1:1"));
    await expect(client.callTool("run_sql", { q: "select 1" })).rejects.toMatchObject({
      code: "unknown_tool",
    });
  });

  it("validates arguments before calling", async () => {
    let called = false;
    const baseUrl = await stubApi((_req, res) => {
      called = true;
      res.end("{}");
    });
    const client = createInternalApiClient(configFor(baseUrl));

    await expect(client.callTool("business_overview", { windowDays: 365 })).rejects.toMatchObject({
      code: "invalid_tool_arguments",
    });
    await expect(client.callTool("keyword_guide_catalog", { limit: 500 })).rejects.toMatchObject({
      code: "invalid_tool_arguments",
    });
    await expect(
      client.callTool("conversation_summary", { windowDays: 7, limit: 100 }),
    ).rejects.toMatchObject({ code: "invalid_tool_arguments" });
    expect(called).toBe(false);
  });

  it("rejects an extra argument key rather than forwarding it", async () => {
    const client = createInternalApiClient(configFor("http://127.0.0.1:1"));
    await expect(
      client.callTool("business_overview", { windowDays: 7, secrets: true }),
    ).rejects.toMatchObject({ code: "invalid_tool_arguments" });
  });

  it("fails when the advisor data connection is unconfigured", async () => {
    const client = createInternalApiClient(configFor(undefined));
    await expect(client.callTool("business_overview", { windowDays: 7 })).rejects.toMatchObject({
      code: "advisor_not_configured",
    });
  });

  it("rejects a structurally unexpected 200 response", async () => {
    const baseUrl = await stubApi((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ guideDeliveries: "lots" }));
    });
    const client = createInternalApiClient(configFor(baseUrl));
    await expect(client.callTool("business_overview", { windowDays: 7 })).rejects.toMatchObject({
      code: "internal_api_unavailable",
    });
  });

  it("maps a non-200 to unavailable", async () => {
    const baseUrl = await stubApi((_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
    const client = createInternalApiClient(configFor(baseUrl));
    await expect(client.callTool("business_overview", { windowDays: 7 })).rejects.toMatchObject({
      code: "internal_api_unavailable",
    });
  });

  it("passes each tool's validated arguments through as the body", async () => {
    let body = "";
    const baseUrl = await stubApi((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        body = Buffer.concat(chunks).toString("utf8");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ windowDays: 30, totals: {}, threads: [] }));
      });
    });
    const client = createInternalApiClient(configFor(baseUrl));
    await client.callTool("conversation_summary", { windowDays: 30, limit: 25 });
    expect(JSON.parse(body)).toEqual({ windowDays: 30, limit: 25 });
  });
});
