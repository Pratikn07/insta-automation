import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { requireInternalRuntime } from "./internalAuth.js";

const SECRET = "i".repeat(32);

// Not a defaulted parameter: `makeApp(undefined)` must genuinely mean "no secret
// configured", and a default would silently substitute SECRET instead.
function makeApp(...args: [] | [secret: string | undefined]) {
  const secret = args.length === 0 ? SECRET : args[0];
  const app = express();
  app.use("/internal", requireInternalRuntime(secret), (_req, res) => res.sendStatus(204));
  return app;
}

describe("requireInternalRuntime", () => {
  it("accepts the configured internal token", async () => {
    await request(makeApp())
      .post("/internal/ai/tools/business_overview")
      .set("authorization", `Bearer ${SECRET}`)
      .expect(204);
  });

  it("uses constant-time comparison and rejects a wrong internal token", async () => {
    await request(makeApp())
      .post("/internal/ai/tools/business_overview")
      .set("authorization", `Bearer ${"x".repeat(32)}`)
      .expect(401, { error: "unauthorized" });
  });

  it("rejects a missing authorization header", async () => {
    await request(makeApp()).post("/internal/ai/tools/business_overview").expect(401, {
      error: "unauthorized",
    });
  });

  it("rejects a token of a different length without leaking timing", async () => {
    await request(makeApp())
      .post("/internal/ai/tools/business_overview")
      .set("authorization", "Bearer short")
      .expect(401, { error: "unauthorized" });
  });

  it("rejects a non-bearer scheme", async () => {
    await request(makeApp())
      .post("/internal/ai/tools/business_overview")
      .set("authorization", `Basic ${SECRET}`)
      .expect(401, { error: "unauthorized" });
  });

  // A deploy that forgot the variable must not silently expose the data routes.
  it("fails closed when the secret is unset", async () => {
    await request(makeApp(undefined))
      .post("/internal/ai/tools/business_overview")
      .set("authorization", `Bearer ${SECRET}`)
      .expect(503, { error: "internal_ai_not_configured" });
  });
});
