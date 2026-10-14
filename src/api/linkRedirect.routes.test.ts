// src/api/linkRedirect.routes.test.ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createLinkRedirectRouter, type LinkRedirectDeps } from "./linkRedirect.routes.js";

const TOKEN = "abcDEF123_-";
const INSTAGRAM_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 312.0.0.0.0";
const SEND = {
  id: "send-1",
  conversationId: "convo-1",
  mediaId: "reel-9",
  conversationState: "link_sent",
  resource: { name: "Halloween collection", linkUrl: "https://mycuratedhaven.com/halloween" },
};
const DESTINATION =
  "https://mycuratedhaven.com/halloween?utm_source=instagram&utm_medium=organic_social&utm_campaign=comment_dm&utm_content=reel-9";
const NOW = new Date("2026-10-20T12:00:00.000Z");

function makeApp(overrides: Partial<LinkRedirectDeps> = {}) {
  const deps = {
    repository: {
      findForRedirect: vi.fn(async () => SEND),
      recordClick: vi.fn(async () => ({ recorded: true, firstHumanClick: true })),
    },
    allowedHosts: () => new Set(["mycuratedhaven.com"]),
    completeConversation: vi.fn(async () => undefined),
    now: () => NOW,
    onBackgroundError: vi.fn(),
    ...overrides,
  };
  const app = express();
  app.use("/r", createLinkRedirectRouter(deps as LinkRedirectDeps));
  return { app, deps };
}

describe("GET /r/:token", () => {
  it("redirects a parent to the guide's current link with UTM tags and no caching", async () => {
    const { app } = makeApp();
    const response = await request(app).get(`/r/${TOKEN}`).set("User-Agent", INSTAGRAM_UA).expect(302);
    expect(response.headers.location).toBe(DESTINATION);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("records the human tap and completes the conversation", async () => {
    const { app, deps } = makeApp();
    await request(app).get(`/r/${TOKEN}`).set("User-Agent", INSTAGRAM_UA).expect(302);
    await vi.waitFor(() => expect(deps.completeConversation).toHaveBeenCalledWith("convo-1"));
    expect(deps.repository.recordClick).toHaveBeenCalledWith({
      sendId: "send-1",
      destinationUrl: DESTINATION,
      isBot: false,
      uaFamily: "instagram_app",
      clickedAt: NOW,
    });
  });

  it("records a preview bot without completing anything", async () => {
    const { app, deps } = makeApp({
      repository: {
        findForRedirect: vi.fn(async () => SEND),
        recordClick: vi.fn(async () => ({ recorded: true, firstHumanClick: false })),
      },
    });
    await request(app).get(`/r/${TOKEN}`).set("User-Agent", "facebookexternalhit/1.1").expect(302);
    await vi.waitFor(() =>
      expect(deps.repository.recordClick).toHaveBeenCalledWith(
        expect.objectContaining({ isBot: true, uaFamily: "meta_preview" }),
      ),
    );
    expect(deps.completeConversation).not.toHaveBeenCalled();
  });

  it("does not let Meta's scanner, posing as a browser, complete the conversation", async () => {
    const { app, deps } = makeApp({
      repository: {
        findForRedirect: vi.fn(async () => SEND),
        recordClick: vi.fn(async () => ({ recorded: true, firstHumanClick: false })),
      },
    });
    await request(app)
      .get(`/r/${TOKEN}`)
      .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/74.0.3729.131 Safari/537.36")
      .set("X-Real-IP", "57.141.2.1")
      .expect(302);
    await vi.waitFor(() =>
      expect(deps.repository.recordClick).toHaveBeenCalledWith(
        expect.objectContaining({ isBot: true, uaFamily: "meta_scanner" }),
      ),
    );
    expect(deps.completeConversation).not.toHaveBeenCalled();
  });

  it("does not complete a conversation that is no longer link_sent", async () => {
    const { app, deps } = makeApp({
      repository: {
        findForRedirect: vi.fn(async () => ({ ...SEND, conversationState: "completed" })),
        recordClick: vi.fn(async () => ({ recorded: true, firstHumanClick: true })),
      },
    });
    await request(app).get(`/r/${TOKEN}`).set("User-Agent", INSTAGRAM_UA).expect(302);
    await vi.waitFor(() => expect(deps.repository.recordClick).toHaveBeenCalled());
    expect(deps.completeConversation).not.toHaveBeenCalled();
  });

  it("sends an unknown token to the home page", async () => {
    const { app } = makeApp({
      repository: { findForRedirect: vi.fn(async () => null), recordClick: vi.fn() },
    });
    const response = await request(app).get(`/r/${TOKEN}`).expect(302);
    expect(response.headers.location).toBe("https://mycuratedhaven.com/");
  });

  it("sends a malformed token home without touching the database", async () => {
    const { app, deps } = makeApp();
    // Wrong length: "not-a-token" itself is 11 URL-safe characters, a well-formed token.
    const response = await request(app).get("/r/not-a-valid-token").expect(302);
    expect(response.headers.location).toBe("https://mycuratedhaven.com/");
    expect(deps.repository.findForRedirect).not.toHaveBeenCalled();
  });

  it("never redirects to a host that is no longer allowed", async () => {
    const { app } = makeApp({
      repository: {
        findForRedirect: vi.fn(async () => ({
          ...SEND,
          resource: { name: "x", linkUrl: "https://evil.example/x" },
        })),
        recordClick: vi.fn(),
      },
    });
    const response = await request(app).get(`/r/${TOKEN}`).expect(302);
    expect(response.headers.location).toBe("https://mycuratedhaven.com/");
  });

  it("still redirects when the lookup fails", async () => {
    const { app, deps } = makeApp({
      repository: {
        findForRedirect: vi.fn(async () => {
          throw new Error("db down");
        }),
        recordClick: vi.fn(),
      },
    });
    const response = await request(app).get(`/r/${TOKEN}`).expect(302);
    expect(response.headers.location).toBe("https://mycuratedhaven.com/");
    expect(deps.onBackgroundError).toHaveBeenCalled();
  });
});
