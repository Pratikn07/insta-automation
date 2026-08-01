import { describe, it, expect } from "vitest";
import {
  rankDmCandidates,
  resolveCommentMatch,
  resolveDmFallback,
  type KeywordCandidate,
} from "./keywordMatchCore.js";

/** A keyword row, with only the fields the matching decision reads. */
function kw(
  overrides: Partial<KeywordCandidate> & { keyword: string } & { id?: string },
): KeywordCandidate {
  return {
    id: overrides.id ?? `id-${overrides.keyword}-${overrides.mediaId ?? "global"}`,
    keyword: overrides.keyword,
    mediaId: overrides.mediaId ?? null,
    mediaPostedAt: overrides.mediaPostedAt ?? null,
  };
}

describe("resolveCommentMatch", () => {
  it("fires the post's own keyword when a token matches", () => {
    const post = [kw({ keyword: "SLEEP", mediaId: "postA" })];
    const global = [kw({ keyword: "SLEEP" })];

    const match = resolveCommentMatch(["SLEEP"], post, global);

    expect(match?.keyword.mediaId).toBe("postA");
    expect(match?.mode).toBe("post_strict");
    expect(match?.matchedToken).toBe("SLEEP");
  });

  // THE FIX. A post that has its own keywords must not leak another post's guide,
  // even when a global would have matched. This is the spillover being killed.
  it("returns null on a configured post when no attached keyword matches, even if a global would", () => {
    const post = [kw({ keyword: "POTTY", mediaId: "postA" })];
    const global = [kw({ keyword: "SLEEP" })];

    expect(resolveCommentMatch(["SLEEP"], post, global)).toBeNull();
  });

  // Decision 1: the 24 existing globals keep working on posts nobody has touched,
  // so nothing goes dark on deploy.
  it("falls back to a global when the post has no keywords attached", () => {
    const global = [kw({ keyword: "SLEEP" })];

    const match = resolveCommentMatch(["SLEEP"], [], global);

    expect(match?.keyword.mediaId).toBeNull();
    expect(match?.mode).toBe("global_fallback");
  });

  // The headline ask: same word, different guide, per post.
  it("resolves the same word to a different row per post", () => {
    const a = kw({ id: "kw-a", keyword: "SLEEP", mediaId: "postA" });
    const b = kw({ id: "kw-b", keyword: "SLEEP", mediaId: "postB" });
    const c = kw({ id: "kw-c", keyword: "SLEEP", mediaId: "postC" });

    // Each post sees only its own attached keywords.
    expect(resolveCommentMatch(["SLEEP"], [a], [])?.keyword.id).toBe("kw-a");
    expect(resolveCommentMatch(["SLEEP"], [b], [])?.keyword.id).toBe("kw-b");
    expect(resolveCommentMatch(["SLEEP"], [c], [])?.keyword.id).toBe("kw-c");
  });

  it("matches in token order, so the first word the user typed wins", () => {
    const post = [
      kw({ id: "kw-egg", keyword: "EGG", mediaId: "postA" }),
      kw({ id: "kw-milk", keyword: "MILK", mediaId: "postA" }),
    ];

    // Tokens arrive pre-normalized from scannableCommentTokens ("DM EGG" → [DM, EGG]).
    expect(resolveCommentMatch(["MILK", "EGG"], post, [])?.keyword.id).toBe("kw-milk");
    expect(resolveCommentMatch(["EGG", "MILK"], post, [])?.keyword.id).toBe("kw-egg");
  });

  it("returns null for an empty token list", () => {
    expect(resolveCommentMatch([], [kw({ keyword: "SLEEP", mediaId: "postA" })], [])).toBeNull();
  });

  it("returns null when neither the post nor the globals carry the word", () => {
    expect(
      resolveCommentMatch(["RANDOM"], [kw({ keyword: "SLEEP", mediaId: "postA" })], [kw({ keyword: "POTTY" })]),
    ).toBeNull();
  });
});

describe("rankDmCandidates / resolveDmFallback", () => {
  // Decision 3: a cold DM has no post attached, so newest post wins.
  it("picks the newest post when several share a word", () => {
    const old = kw({ id: "kw-old", keyword: "SLEEP", mediaId: "p1", mediaPostedAt: new Date("2026-01-15") });
    const newest = kw({ id: "kw-new", keyword: "SLEEP", mediaId: "p2", mediaPostedAt: new Date("2026-07-20") });
    const mid = kw({ id: "kw-mid", keyword: "SLEEP", mediaId: "p3", mediaPostedAt: new Date("2026-04-02") });

    expect(resolveDmFallback([old, newest, mid])?.id).toBe("kw-new");
    expect(rankDmCandidates([old, newest, mid]).map((c) => c.id)).toEqual(["kw-new", "kw-mid", "kw-old"]);
  });

  // An undated post is a weaker guess, not an unreachable one.
  it("ranks a null mediaPostedAt last without dropping it", () => {
    const dated = kw({ id: "kw-dated", keyword: "SLEEP", mediaId: "p1", mediaPostedAt: new Date("2026-03-01") });
    const undated = kw({ id: "kw-undated", keyword: "SLEEP", mediaId: "p2" });

    expect(rankDmCandidates([undated, dated]).map((c) => c.id)).toEqual(["kw-dated", "kw-undated"]);
    // Still reachable when it is the only candidate.
    expect(resolveDmFallback([undated])?.id).toBe("kw-undated");
  });

  it("is stable and order-independent when every candidate is undated", () => {
    const a = kw({ id: "kw-a", keyword: "SLEEP", mediaId: "p1" });
    const b = kw({ id: "kw-b", keyword: "SLEEP", mediaId: "p2" });

    expect(resolveDmFallback([a, b])?.id).toBe("kw-a");
    expect(resolveDmFallback([b, a])?.id).toBe("kw-a");
  });

  it("breaks a same-date tie deterministically", () => {
    const same = new Date("2026-05-05");
    const a = kw({ id: "kw-a", keyword: "SLEEP", mediaId: "p1", mediaPostedAt: same });
    const b = kw({ id: "kw-b", keyword: "SLEEP", mediaId: "p2", mediaPostedAt: same });

    expect(resolveDmFallback([a, b])?.id).toBe(resolveDmFallback([b, a])?.id);
  });

  it("returns null when there are no candidates", () => {
    expect(resolveDmFallback([])).toBeNull();
  });

  it("does not mutate the input array", () => {
    const a = kw({ id: "kw-a", keyword: "SLEEP", mediaId: "p1", mediaPostedAt: new Date("2026-01-01") });
    const b = kw({ id: "kw-b", keyword: "SLEEP", mediaId: "p2", mediaPostedAt: new Date("2026-06-01") });
    const input = [a, b];

    rankDmCandidates(input);

    expect(input.map((c) => c.id)).toEqual(["kw-a", "kw-b"]);
  });
});
