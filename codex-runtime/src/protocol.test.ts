import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { JsonRpcPeer } from "./protocol.js";

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("JsonRpcPeer", () => {
  it("matches a newline-delimited response to its request", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const peer = new JsonRpcPeer(fromServer, toServer);
    const chunks: Buffer[] = [];
    toServer.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    const pending = peer.request<{ ok: boolean }>("account/read", { refreshToken: false });
    await nextTick();
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8").trim()) as { id: number };
    fromServer.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("buffers a response split across input chunks", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const peer = new JsonRpcPeer(fromServer, toServer);
    const output = new Promise<string>((resolve) => toServer.once("data", (chunk) => resolve(String(chunk))));

    const pending = peer.request<{ connected: boolean }>("account/read", {});
    const request = JSON.parse((await output).trim()) as { id: number };
    const response = JSON.stringify({ id: request.id, result: { connected: true } });
    fromServer.write(response.slice(0, 12));
    fromServer.write(`${response.slice(12)}\n`);

    await expect(pending).resolves.toEqual({ connected: true });
  });

  it("dispatches notifications without writing a response", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const peer = new JsonRpcPeer(fromServer, toServer);
    const handler = vi.fn();
    peer.onNotification("account/updated", handler);

    fromServer.write(`${JSON.stringify({ method: "account/updated", params: { authMode: "chatgpt" } })}\n`);
    await nextTick();

    expect(handler).toHaveBeenCalledWith({ authMode: "chatgpt" });
    expect(toServer.readableLength).toBe(0);
  });

  it("dispatches server requests and writes their result", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const peer = new JsonRpcPeer(fromServer, toServer);
    peer.onRequest("item/tool/call", async () => ({ success: true, contentItems: [] }));
    const response = new Promise<string>((resolve) => toServer.once("data", (chunk) => resolve(String(chunk))));

    fromServer.write(`${JSON.stringify({ id: 91, method: "item/tool/call", params: {} })}\n`);

    await expect(response).resolves.toContain('"id":91');
  });

  it("returns method-not-found for an unknown server request", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    new JsonRpcPeer(fromServer, toServer);
    const response = new Promise<string>((resolve) => toServer.once("data", (chunk) => resolve(String(chunk))));

    fromServer.write(`${JSON.stringify({ id: 42, method: "unknown/request", params: {} })}\n`);

    await expect(response).resolves.toContain('"code":-32601');
  });

  it("rejects a request when app-server returns an error", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const peer = new JsonRpcPeer(fromServer, toServer);
    const output = new Promise<string>((resolve) => toServer.once("data", (chunk) => resolve(String(chunk))));

    const pending = peer.request("account/read", {});
    const request = JSON.parse((await output).trim()) as { id: number };
    fromServer.write(`${JSON.stringify({ id: request.id, error: { code: -32000, message: "unavailable" } })}\n`);

    await expect(pending).rejects.toThrow("account/read failed: unavailable");
  });

  it("rejects pending calls when the input stream closes", async () => {
    const fromServer = new PassThrough();
    const peer = new JsonRpcPeer(fromServer, new PassThrough());
    const pending = peer.request("account/read", {});

    fromServer.destroy();

    await expect(pending).rejects.toThrow("app-server stream closed");
  });

  it("rejects a timed-out call and ignores a late response", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const peer = new JsonRpcPeer(fromServer, toServer);
    const output = new Promise<string>((resolve) => toServer.once("data", (chunk) => resolve(String(chunk))));

    const pending = peer.request("turn/start", {}, 5);
    const request = JSON.parse((await output).trim()) as { id: number };
    await expect(pending).rejects.toThrow("turn/start timed out");
    fromServer.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    await nextTick();

    await expect(peer.request("account/read", {}, 5)).rejects.toThrow("account/read timed out");
  });
});
