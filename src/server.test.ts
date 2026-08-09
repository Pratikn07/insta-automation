import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const startGuideDeliveryScheduler = vi.fn();
const runGuideDeliveryTick = vi.fn();
const app = {
  use: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  listen: vi.fn(),
};
const express = Object.assign(vi.fn(() => app), {
  json: vi.fn(() => vi.fn()),
});

vi.mock("express", () => ({ default: express }));
vi.mock("cors", () => ({ default: vi.fn(() => vi.fn()) }));
vi.mock("./api/internalAi.routes.js", () => ({ internalAiRouter: {} }));
vi.mock("./api/router.js", () => ({ apiRouter: {} }));
vi.mock("./services/guideDeliveryScheduler.js", () => ({ startGuideDeliveryScheduler }));
vi.mock("./services/guideDeliveryWorker.js", () => ({ runGuideDeliveryTick }));

describe("server guide delivery startup", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  beforeAll(async () => {
    globalThis.setInterval = vi.fn(() => Symbol("timer") as never);
    globalThis.clearInterval = vi.fn();
    await import("./server.js");
  });

  afterAll(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  it("starts the always-on guide delivery scheduler exactly once", () => {
    expect(startGuideDeliveryScheduler).toHaveBeenCalledOnce();
    expect(startGuideDeliveryScheduler).toHaveBeenCalledWith({
      intervalMs: 60_000,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      runTick: runGuideDeliveryTick,
    });
  });
});
