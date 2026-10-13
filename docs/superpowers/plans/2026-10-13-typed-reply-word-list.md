# Typed Reply Word List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typed yeses to an open guide card start the guide, and keyword DMs over 30 distinct words (brand pitches) go to owner review instead.

**Architecture:** Both rules live in the pure classifier `src/services/dmGuideIntent.ts`, which production already enforces (`GUIDE_DM_INTENT_GUARD_ENABLED`). `messageHandler.ts` routing does not change: it treats any keyword kind without `selected` as not accepted, and any reply kind other than `accepted_confirmation` as owner review.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-13-typed-reply-word-list-design.md`.
- Lead phrases, longest first: Yes `YES`, `YEP`, `YEAH`, `SURE`, `OK`, `OKAY`, `SEND IT`, `PLEASE SEND`, `SEND`; Done/follow `DONE`, `DOEN`, `FONE`, `DOME`, `FOLLOWED`, `FOLLOWING`, `I FOLLOW`, `I FOLLOWED`, `I AM FOLLOWING`, `IM FOLLOWING`, `READY`.
- Filler: `PLEASE`, `PLS`, `PLZ`, `THANKS`, `THANK`, `YOU`, `U`, `THX`, `TY`, `SEND`, `IT`, `HERE`, `NOW`, `ME`, `SO`, `MUCH`.
- Negations: `NO`, `NOT`, `DONT`, `NOPE`, `NAH`. Any `?` in the raw text rejects.
- Keyword DMs: more than 30 `meaningfulTokens` returns `rejected_long`.
- Every phrase in the old `CONFIRMATION_PHRASES` must still pass.
- No feature flag, no routing change, no backfill.

Run tests with: `npx vitest run src/services/dmGuideIntent.test.ts` (pure, needs no env or DB).

---

### Task 1: Typed reply to an open card

**Files:**
- Modify: `src/services/dmGuideIntent.ts` (replace `CONFIRMATION_PHRASES` and the body of `classifyOpenRequestReply`)
- Test: `src/services/dmGuideIntent.test.ts` (`describe("classifyOpenRequestReply")`)

**Interfaces:**
- Consumes: `normalizeReply(text: string): string` (existing, unchanged).
- Produces: `classifyOpenRequestReply(text: string, messageType: DmMessageType): OpenRequestReplyIntent` (signature and result type unchanged).

- [ ] **Step 1: Write the failing tests.** Add inside `describe("classifyOpenRequestReply")`:

```ts
  // Real replies from production (30 days to 2026-10-13) that went to owner review and
  // got nothing, although each one is a plain yes.
  it.each([
    "yes send it",
    "Yes, send it",
    "yes send it here",
    "yes send it here please",
    "yes pls",
    "yes plz",
    "yes please send",
    "yes please thank you",
    "yes thanks",
    "yep",
    "yeah please",
    "sure",
    "ok",
    "okay thanks",
    "following",
    "i follow",
    "doen",
    "fone",
    "Done ✅",
  ])("accepts the typed yes %s", (text) => {
    expect(classifyOpenRequestReply(text, "text")).toEqual({ kind: "accepted_confirmation" });
  });

  // Owner's decision: these are not a yes, and must keep going to owner review.
  it.each([
    "thank you",
    "Thank you!",
    "thanks",
    "please",
    "plz",
    "yes but is it dairy free?",
    "where is the recipe?",
    "yes please send it to my email",
    "following up on my order",
    "can i use almond flour",
    "someone@example.com",
    "Hey, thanks for your DM! We'll get back to you as soon as we can!",
    "yes no rush",
    "nope",
    "ok?",
  ])("sends %s to owner review", (text) => {
    expect(classifyOpenRequestReply(text, "text")).toMatchObject({
      kind: "rejected_reply",
      reason: "unrecognized_text",
    });
  });
```

- [ ] **Step 2: Run to verify the new accepts fail**

Run: `npx vitest run src/services/dmGuideIntent.test.ts`
Expected: FAIL on the "accepts the typed yes" cases that are not exact old phrases (e.g. `yes send it`, `sure`, `doen`). The existing tests still pass.

- [ ] **Step 3: Implement.** In `src/services/dmGuideIntent.ts`, replace the `CONFIRMATION_PHRASES` set with:

```ts
/**
 * Which typed replies to an open card count as "yes, send it".
 *
 * A reply must START with a lead phrase and carry nothing after it but polite filler.
 * The old rule matched whole messages against 12 phrases, so "yes send it", "yes pls",
 * "sure" and a misspelled "doen" went to owner review and got nothing: about 55 a month
 * of the 367 rejected replies in the 30 days to 2026-10-13. "Thank you" and "please"
 * alone stay out on purpose (owner's decision): they are not a yes. See
 * docs/superpowers/specs/2026-10-13-typed-reply-word-list-design.md.
 */
const CONFIRMATION_LEADS: readonly (readonly string[])[] = [
  // Yes
  ["YES"], ["YEP"], ["YEAH"], ["SURE"], ["OK"], ["OKAY"],
  ["SEND", "IT"], ["PLEASE", "SEND"], ["SEND"],
  // Done / follow, including the misspellings seen in production
  ["DONE"], ["DOEN"], ["FONE"], ["DOME"],
  ["FOLLOWED"], ["FOLLOWING"], ["I", "FOLLOW"], ["I", "FOLLOWED"],
  ["I", "AM", "FOLLOWING"], ["IM", "FOLLOWING"], ["READY"],
].sort((a, b) => b.length - a.length);

/** The only words allowed after a lead phrase. */
const CONFIRMATION_FILLER = new Set([
  "PLEASE", "PLS", "PLZ", "THANKS", "THANK", "YOU", "U", "THX", "TY",
  "SEND", "IT", "HERE", "NOW", "ME", "SO", "MUCH",
]);

const NEGATIONS = new Set(["NO", "NOT", "DONT", "NOPE", "NAH"]);
```

and replace the confirmation check in `classifyOpenRequestReply`:

```ts
  const normalized = normalizeReply(text);
  if (!normalized) return { kind: "rejected_reply", reason: "blank_text" };
  if (isConfirmation(text, normalized.split(" "))) return { kind: "accepted_confirmation" };
  return { kind: "rejected_reply", reason: "unrecognized_text" };
```

with this helper above it:

```ts
function isConfirmation(rawText: string, tokens: readonly string[]): boolean {
  // A question is never a yes: "yes but is it dairy free?" needs a person.
  if (rawText.includes("?")) return false;
  if (tokens.some((token) => NEGATIONS.has(token))) return false;
  const lead = CONFIRMATION_LEADS.find((phrase) =>
    phrase.every((token, index) => tokens[index] === token),
  );
  if (!lead) return false;
  return tokens.slice(lead.length).every((token) => CONFIRMATION_FILLER.has(token));
}
```

- [ ] **Step 4: Run to verify everything passes**

Run: `npx vitest run src/services/dmGuideIntent.test.ts`
Expected: PASS, including the existing "accepts the complete confirmation phrase" and "rejects unrelated text containing an affirmative word" cases.

- [ ] **Step 5: Commit**

```bash
git add src/services/dmGuideIntent.ts src/services/dmGuideIntent.test.ts
git commit -m "fix: count typed yeses to an open guide card"
```

### Task 2: Cap keyword DMs at 30 distinct words

**Files:**
- Modify: `src/services/dmGuideIntent.ts` (`DmKeywordIntent` type, `classifyDmKeywordIntent`)
- Test: `src/services/dmGuideIntent.test.ts` (`describe("classifyDmKeywordIntent")`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `DmKeywordIntent` gains the rejected kind `"rejected_long"`; export `MAX_KEYWORD_DM_TOKENS = 30`.

- [ ] **Step 1: Write the failing tests.** Add inside `describe("classifyDmKeywordIntent")`:

```ts
  // Brand pitches (43-84 distinct words) started guide flows because they mentioned a
  // keyword next to "get" or "send". Every real ask but one was 20 words or fewer.
  function longAsk(words: number): string[] {
    const head = ["CAN", "YOU", "SEND", "ME", "THE", "WAFFLE"];
    return [...head, ...Array.from({ length: words - head.length }, (_, i) => `W${i}`)];
  }

  it("sends a keyword DM over 30 distinct words to owner review", () => {
    const tokens = longAsk(31);
    expect(classifyDmKeywordIntent(tokens, [resolved("WAFFLE", 5)])).toEqual({
      kind: "rejected_long",
      meaningfulTokenCount: 31,
      keywordHitCount: 1,
      distinctGuideCount: 1,
    });
  });

  it("keeps today's answer for a keyword DM of exactly 30 distinct words", () => {
    const waffle = resolved("WAFFLE", 5);
    expect(classifyDmKeywordIntent(longAsk(30), [waffle])).toMatchObject({
      kind: "accepted_explicit",
      selected: waffle,
    });
  });

  it("still reports no_keyword for a long DM with no keyword", () => {
    expect(classifyDmKeywordIntent(longAsk(40), [])).toMatchObject({ kind: "no_keyword" });
  });
```

- [ ] **Step 2: Run to verify the 31-word case fails**

Run: `npx vitest run src/services/dmGuideIntent.test.ts`
Expected: FAIL on "sends a keyword DM over 30 distinct words to owner review" (gets `accepted_explicit`).

- [ ] **Step 3: Implement.** In `src/services/dmGuideIntent.ts`:

```ts
// in the DmKeywordIntent union
      kind: "rejected_negative" | "rejected_conversational" | "rejected_long" | "no_keyword";
```

```ts
/**
 * Above this many distinct words a keyword DM goes to owner review. In the 30 days to
 * 2026-10-13, 10 of the 11 keyword DMs over 40 words that started a guide were brand
 * pitches; every real ask but one was 20 words or fewer.
 */
export const MAX_KEYWORD_DM_TOKENS = 30;
```

and in `classifyDmKeywordIntent`, directly after the `no_keyword` return:

```ts
  if (meaningfulTokens.length > MAX_KEYWORD_DM_TOKENS) return { kind: "rejected_long", ...counts };
```

- [ ] **Step 4: Run to verify everything passes**

Run: `npx vitest run src/services/dmGuideIntent.test.ts src/handlers/messageHandler.test.ts`
Expected: PASS (the handler suite needs the fake env from the contract-DB recipe; `rejected_long` has no `selected`, so routing treats it as owner review).

- [ ] **Step 5: Commit**

```bash
git add src/services/dmGuideIntent.ts src/services/dmGuideIntent.test.ts
git commit -m "fix: send keyword DMs over 30 words to owner review"
```

### Task 3: Verify the whole branch

- [ ] **Step 1:** `npx tsc --noEmit -p tsconfig.json` → exit 0.
- [ ] **Step 2:** Full backend suite with the contract DB and fake env (see memory `contract-db-recipe`) → all files pass, none skipped.
- [ ] **Step 3:** Replay the rule over production text, read-only: the 367 rejected replies from the last 30 days, counting how many the new rule would accept. Expect roughly 55, and none of them questions, emails or auto-replies.
