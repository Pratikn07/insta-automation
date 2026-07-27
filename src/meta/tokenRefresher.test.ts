import { describe, expect, it, vi } from "vitest";
import { classifyRefreshOutcome, expiryFromExpiresIn } from "./tokenRefresher.js";

// The DB/HTTP wiring of runTokenRefreshTick is covered by the live smoke test in
// TK4's verification (it needs a real ig_token row and a real Meta call). What is
// unit-testable — and what actually encodes the hard-won knowledge — is how a
// Meta response gets classified and how expiry is computed from it.

describe("expiryFromExpiresIn", () => {
  const NOW = Date.parse("2026-07-27T03:00:00.000Z");

  it("converts Meta's seconds into an absolute expiry", () => {
    // Meta's real sample value: 5183944s ≈ 59.99 days.
    const exp = expiryFromExpiresIn(5_183_944, NOW);
    const days = (exp.getTime() - NOW) / 86_400_000;
    expect(Math.round(days)).toBe(60);
  });

  it("falls back to 60 days when Meta omits expires_in", () => {
    // Defensive: a missing expires_in must not produce an Invalid Date that
    // silently poisons the health readout.
    const exp = expiryFromExpiresIn(undefined, NOW);
    expect(Math.round((exp.getTime() - NOW) / 86_400_000)).toBe(60);
  });

  it("ignores a nonsensical zero or negative expires_in", () => {
    // A 0 would mark the token instantly expired and trip the alarm for no
    // reason; treat it as unknown instead.
    expect(expiryFromExpiresIn(0, NOW).getTime()).toBeGreaterThan(NOW);
    expect(expiryFromExpiresIn(-5, NOW).getTime()).toBeGreaterThan(NOW);
  });
});

describe("classifyRefreshOutcome", () => {
  function graphError(message: string, code = 190) {
    return {
      isAxiosError: true,
      response: { data: { error: { message, code, type: "OAuthException" } } },
    };
  }

  it("treats Meta's under-24h complaint as benign, not an alarm", () => {
    // Every freshly minted token spends its first day in this state. Logging it
    // as an error would cry wolf once every 6h for a whole day after each
    // manual re-mint.
    const o = classifyRefreshOutcome(
      graphError("The token must be at least 24 hours old to be refreshed"),
    );
    expect(o.kind).toBe("too_young");
    expect(o.alarming).toBe(false);
  });

  it("flags an expired session as alarming — this is the state we must never reach", () => {
    const o = classifyRefreshOutcome(
      graphError("Error validating access token: Session has expired on Sunday, 26-Jul-26"),
    );
    expect(o.kind).toBe("expired");
    expect(o.alarming).toBe(true);
  });

  it("flags an invalidated session (password change) as alarming and distinct", () => {
    // Seen for real: after re-minting, the OLD token reported "session has been
    // invalidated" rather than "expired". Different cause, same required action.
    const o = classifyRefreshOutcome(
      graphError("The session has been invalidated because the user changed their password"),
    );
    expect(o.kind).toBe("invalidated");
    expect(o.alarming).toBe(true);
  });

  it("treats an unrecognised failure as alarming rather than assuming it is fine", () => {
    const o = classifyRefreshOutcome(graphError("Something entirely new", 4));
    expect(o.kind).toBe("unknown");
    expect(o.alarming).toBe(true);
  });

  it("handles a non-Graph failure (timeout, DNS) without throwing", () => {
    const o = classifyRefreshOutcome(new Error("ETIMEDOUT"));
    expect(o.kind).toBe("unknown");
    expect(o.alarming).toBe(true);
    expect(typeof o.message).toBe("string");
  });
});

describe("vitest sanity", () => {
  it("does not leak mocks between files", () => {
    expect(vi.isMockFunction(console.log)).toBe(false);
  });
});
