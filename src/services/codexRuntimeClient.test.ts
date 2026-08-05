import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexRuntimeError,
  createCodexRuntimeClient,
} from "./codexRuntimeClient.js";

const RUNTIME_TOKEN = "t".repeat(32);

let open: Server | null = null;

afterEach(() => {
  open?.close();
  open = null;
});

/** Start a stub runtime on an ephemeral port and return its base URL. */
async function stubRuntime(
  handler: (req: Parameters<Parameters<typeof createServer>[0]>[0], res: Parameters<Parameters<typeof createServer>[0]>[1]) => void,
): Promise<string> {
  const server = createServer(handler);
  open = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function jsonResponse(res: Parameters<Parameters<typeof createServer>[0]>[1], status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

describe("createCodexRuntimeClient", () => {
  it("authenticates and validates connection status", async () => {
    const seen: Array<string | undefined> = [];
    const baseUrl = await stubRuntime((req, res) => {
      seen.push(req.headers.authorization);
      jsonResponse(res, 200, {
        connected: true,
        requiresOpenaiAuth: true,
        account: { email: "owner@example.com", planType: "plus" },
        rateLimits: { usedPercent: 12, resetsAt: 1785888000 },
      });
    });

    const client = createCodexRuntimeClient({ baseUrl, token: RUNTIME_TOKEN });
    await expect(client.getConnectionStatus()).resolves.toMatchObject({ connected: true });
    expect(seen).toEqual([`Bearer ${RUNTIME_TOKEN}`]);
  });

  it("requests the runtime's status path and forwards a refresh", async () => {
    const paths: Array<string | undefined> = [];
    const baseUrl = await stubRuntime((req, res) => {
      paths.push(req.url);
      jsonResponse(res, 200, {
        connected: false,
        requiresOpenaiAuth: false,
        account: null,
        rateLimits: null,
      });
    });

    const client = createCodexRuntimeClient({ baseUrl, token: RUNTIME_TOKEN });
    await client.getConnectionStatus();
    await client.getConnectionStatus(true);

    expect(paths).toEqual(["/internal/account/status", "/internal/account/status?refresh=true"]);
  });

  it("starts a device login and returns only display fields", async () => {
    const baseUrl = await stubRuntime((req, res) => {
      expect(req.method).toBe("POST");
      jsonResponse(res, 200, {
        loginId: "login-1",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://auth.openai.com/device",
      });
    });

    const client = createCodexRuntimeClient({ baseUrl, token: RUNTIME_TOKEN });
    await expect(client.startDeviceLogin()).resolves.toEqual({
      loginId: "login-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/device",
    });
  });

  it("disconnects on a 204", async () => {
    const baseUrl = await stubRuntime((_req, res) => {
      res.statusCode = 204;
      res.end();
    });

    const client = createCodexRuntimeClient({ baseUrl, token: RUNTIME_TOKEN });
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it("throws ai_not_configured before issuing any request when unset", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createCodexRuntimeClient({ baseUrl: undefined, token: undefined });

    await expect(client.getConnectionStatus()).rejects.toMatchObject({ code: "ai_not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects a response that fails schema validation", async () => {
    const baseUrl = await stubRuntime((_req, res) => {
      jsonResponse(res, 200, { connected: "yes" });
    });

    const client = createCodexRuntimeClient({ baseUrl, token: RUNTIME_TOKEN });
    await expect(client.getConnectionStatus()).rejects.toMatchObject({
      code: "invalid_runtime_response",
    });
  });

  it("maps a runtime 401 to a CodexRuntimeError", async () => {
    const baseUrl = await stubRuntime((_req, res) => jsonResponse(res, 401, { error: "unauthorized" }));
    const client = createCodexRuntimeClient({ baseUrl, token: RUNTIME_TOKEN });

    const error = await client.getConnectionStatus().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodexRuntimeError);
    expect(error).toMatchObject({ code: "runtime_unauthorized", status: 401, retryAt: null });
  });

  it("maps a runtime 429 and its retry-after into retryAt", async () => {
    const baseUrl = await stubRuntime((_req, res) => {
      res.setHeader("retry-after", "30");
      jsonResponse(res, 429, { error: "rate_limited" });
    });
    const client = createCodexRuntimeClient({ baseUrl, token: RUNTIME_TOKEN });

    const error = (await client.getConnectionStatus().catch((e: unknown) => e)) as CodexRuntimeError;
    expect(error).toMatchObject({ code: "runtime_rate_limited", status: 429 });
    expect(error.retryAt).toBeInstanceOf(Date);
  });

  it("maps a runtime 503 to not-ready with a null retryAt", async () => {
    const baseUrl = await stubRuntime((_req, res) =>
      jsonResponse(res, 503, { error: "app_server_not_ready" }),
    );
    const client = createCodexRuntimeClient({ baseUrl, token: RUNTIME_TOKEN });

    await expect(client.getConnectionStatus()).rejects.toMatchObject({
      code: "runtime_unavailable",
      status: 503,
      retryAt: null,
    });
  });

  it("aborts a request that exceeds the timeout", async () => {
    const baseUrl = await stubRuntime(() => {
      /* never respond */
    });
    const client = createCodexRuntimeClient({ baseUrl, token: RUNTIME_TOKEN, timeoutMs: 40 });

    await expect(client.getConnectionStatus()).rejects.toMatchObject({ code: "runtime_timeout" });
  });
});

const draftRequest = {
  requestId: "11111111-1111-1111-1111-111111111111",
  participant: { igUserId: "ig-user-1", username: "geri", name: "Geri" },
  messages: [
    {
      direction: "inbound" as const,
      text: "How old before dropping the nap?",
      messageType: "text" as const,
      source: "instagram_user",
      at: "2026-08-04T10:00:00.000Z",
    },
  ],
  brandVoice: "Warm, practical.",
  guideContext: null,
};

describe("createCodexRuntimeClient.generateDmDraft", () => {
  it("posts the request and validates the suggestion", async () => {
    let receivedBody = "";
    const baseUrl = await stubRuntime((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/internal/drafts/generate");
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8");
        jsonResponse(res, 200, {
          reply: "Most toddlers keep a nap until around 3, Geri 💛",
          rationale: "Answers directly and warmly.",
          confidence: "high",
          warnings: [],
          modelId: "codex-default",
        });
      });
    });

    const client = createCodexRuntimeClient({ baseUrl, token: RUNTIME_TOKEN });
    await expect(client.generateDmDraft(draftRequest)).resolves.toMatchObject({
      reply: "Most toddlers keep a nap until around 3, Geri 💛",
      confidence: "high",
      modelId: "codex-default",
    });
    expect(JSON.parse(receivedBody)).toMatchObject({ requestId: draftRequest.requestId });
  });

  it("maps a runtime 429 to a rate-limit error with retryAt", async () => {
    const baseUrl = await stubRuntime((_req, res) => {
      res.setHeader("retry-after", "45");
      jsonResponse(res, 429, { error: "usage_limited", retryAt: null });
    });
    const client = createCodexRuntimeClient({ baseUrl, token: RUNTIME_TOKEN });

    const error = (await client.generateDmDraft(draftRequest).catch((e: unknown) => e)) as CodexRuntimeError;
    expect(error).toBeInstanceOf(CodexRuntimeError);
    expect(error.code).toBe("runtime_rate_limited");
    expect(error.retryAt).toBeInstanceOf(Date);
  });

  it("rejects a malformed suggestion body", async () => {
    const baseUrl = await stubRuntime((_req, res) => jsonResponse(res, 200, { reply: 42 }));
    const client = createCodexRuntimeClient({ baseUrl, token: RUNTIME_TOKEN });

    await expect(client.generateDmDraft(draftRequest)).rejects.toMatchObject({
      code: "invalid_runtime_response",
    });
  });
});
