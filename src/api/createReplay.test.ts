import { describe, expect, it } from "vitest";
import { classifyCreateReplay } from "./createReplay.js";

describe("classifyCreateReplay", () => {
  it("calls an identical resend a replay", () => {
    expect(
      classifyCreateReplay({
        existing: { id: "id-1", name: "Guide" },
        intended: { id: "id-1", name: "Guide" },
        keys: ["id", "name"],
      }),
    ).toBe("replay");
  });

  it("calls a changed request-owned field a conflict", () => {
    // Same client UUID, different intent. Reusing the key for a different thing
    // is the caller's bug, and answering 200 would hide it.
    expect(
      classifyCreateReplay({
        existing: { id: "id-1", name: "Guide" },
        intended: { id: "id-1", name: "Different guide" },
        keys: ["id", "name"],
      }),
    ).toBe("conflict");
  });

  it("ignores fields the server owns", () => {
    // `order` is assigned by the server, so it can never disagree with a request
    // that did not send it.
    expect(
      classifyCreateReplay({
        existing: { id: "id-1", body: "Step one", order: 3, createdAt: new Date() },
        intended: { id: "id-1", body: "Step one" },
        keys: ["id", "body"],
      }),
    ).toBe("replay");
  });

  it("treats null and undefined as the same absence", () => {
    expect(
      classifyCreateReplay({
        existing: { id: "id-1", description: null },
        intended: { id: "id-1", description: undefined },
        keys: ["id", "description"],
      }),
    ).toBe("replay");
  });

  it("compares a stored Date against the request's ISO string", () => {
    expect(
      classifyCreateReplay({
        existing: { id: "id-1", postedAt: new Date("2026-08-16T10:00:00.000Z") },
        intended: { id: "id-1", postedAt: "2026-08-16T10:00:00.000Z" },
        keys: ["id", "postedAt"],
      }),
    ).toBe("replay");

    expect(
      classifyCreateReplay({
        existing: { id: "id-1", postedAt: new Date("2026-08-16T10:00:00.000Z") },
        intended: { id: "id-1", postedAt: "2026-08-17T10:00:00.000Z" },
        keys: ["id", "postedAt"],
      }),
    ).toBe("conflict");
  });

  it("compares arrays by order and content", () => {
    expect(
      classifyCreateReplay({
        existing: { id: "id-1", reelMediaIds: ["a", "b"] },
        intended: { id: "id-1", reelMediaIds: ["a", "b"] },
        keys: ["id", "reelMediaIds"],
      }),
    ).toBe("replay");

    expect(
      classifyCreateReplay({
        existing: { id: "id-1", reelMediaIds: ["a", "b"] },
        intended: { id: "id-1", reelMediaIds: ["b", "a"] },
        keys: ["id", "reelMediaIds"],
      }),
    ).toBe("conflict");

    expect(
      classifyCreateReplay({
        existing: { id: "id-1", reelMediaIds: ["a"] },
        intended: { id: "id-1", reelMediaIds: ["a", "b"] },
        keys: ["id", "reelMediaIds"],
      }),
    ).toBe("conflict");
  });

  it("does not confuse a boolean with a string of the same shape", () => {
    expect(
      classifyCreateReplay({
        existing: { id: "id-1", active: true },
        intended: { id: "id-1", active: "true" as unknown as boolean },
        keys: ["id", "active"],
      }),
    ).toBe("conflict");
  });
});
