# Link Guide Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-10-12-link-guide-delivery-design.md`
**Branch:** `claude/gated-flow-redesign-9d3c92` (this worktree)

## Execution status (handoff, 2026-10-12)

**Done and reviewed (spec and quality):** Tasks 1–17. Tasks 1–6: commits `a6785af`..`4f4d909`. Tasks 7–17: `7538a61`..the Task 17 docs commit, on `claude/clever-tesla-67lsn9`, which fast-forwards this branch. **Nothing left to build.** What remains is the owner's launch checklist (Task 17, Step 7), starting with the phone tap check below.

**Launch test (Task 3 Step 8):** run by the owner on 2026-10-12.
- `private_link_card`: Meta accepted it (HTTP 200, with a message id).
- `private_link_text`: Meta accepted it (HTTP 200, with a message id).
- A second private reply on the same comment returned HTTP 500 with `graphCode: 1`.
- **The phone tap check is still pending.** Neither case is `supported` until the owner confirms the link opens from Message Requests. The results file (`docs/meta-verification/2026-10-13-link-guide-capability-results.json`) has not been written yet.
- Code for Tasks 7–17 is the same whichever shape passes. Stop only if neither shape is tappable.

**Owner rulings and in-task changes that later tasks must respect:**
- **Task 3:** the CLI prints `outcome_unknown_do_not_retry` when `httpStatus` is null, and prints only safe error codes otherwise. The runbook says to treat that outcome as unknown.
- **Task 4:** `src/api/conversations.routes.ts` `/counts` is typed `Record<ConversationState, number>`, and the response now includes a `link_sent` count. In Task 14, also check `web/src/lib/types.ts` (~line 238); its counts type lacks `link_sent`.
- **Task 6, owner ruling:**
  - `markLatestFailedSendSent` only claims a row that is still `failed`.
  - `recordClick`'s 20-row cap is a soft bound, and `firstHumanClick` can be true for more than one simultaneous tap. **Completion must be idempotent.**
  - Task 11 must add a contract test showing that completing a `link_sent` conversation twice, as two concurrent first human taps would, is harmless.

**Environment notes:**
- Run `npx prisma generate` after checkout; a stale generated client breaks `tsc`.
- Contract suites need a disposable local Postgres. Locally that was `postgresql://postgres:disposable@127.0.0.1:5433/contract`, with the env vars in Global Constraints. Without one, the suites `describe.skip`. Say so, and never point them at a shared database.
- Don't run `graphify update` until Task 17.
- Deferred minor findings from the task reviews live in the PR description, for the final whole-branch review.

**Goal:** Let the creator pick, per post, between today's follow-gated guide and a new link guide that sends one DM with a button to a page on mycuratedhaven.com, with every tap tracked.

**Architecture:** A guide (`resources` row) gains `delivery_mode` (`gated` | `link`) and link fields. A new owner answer, `"link"`, is chosen before the existing V1/V2 selector at the three places that choose today: comment handler, message handler, gate retry worker. The link path sends one Meta message (card or text), records a `guide_link_send` row whose token powers a public `GET /r/:token` redirect. The redirect records `guide_link_click` rows and completes the conversation on the first human tap. A new conversation state, `link_sent`, keeps link conversations out of every gated "open request" path.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Express 4, Prisma 5.22 on Postgres, Zod, Vitest 4 + supertest (backend), React + Vite + TanStack Query + Testing Library (web).

## Global Constraints

- **Flags:** declared with `booleanFlag(false)` in `src/config/env.ts`, never `z.coerce.boolean()` (it reads `"false"` as true). They are read only through `flags.bool("KEY")`, never `env.KEY`; `src/config/flagCallSites.test.ts` enforces this. Registry entries use `pageMayEnable: false, pageMayStop: true`.
- **Limits:**
  - Button label: 1–20 code points.
  - Card title and subtitle: up to 80 code points.
  - Characters are counted as code points (`[...s].length`), so "👻" counts as 1.
- **Allowed hosts default:** `mycuratedhaven.com,www.mycuratedhaven.com`, compared lowercase.
- **Token:** 11 URL-safe characters, `randomBytes(8).toString("base64url")`. It must match `/^[A-Za-z0-9_-]{11}$/`.
- **Click cap:** at most 20 `guide_link_click` rows per send. Every hit still redirects.
- **Unknown or invalid token:** a 302 to the first allowed host's home page. A parent never sees an error page.
- **`guide_access_v2_metric`:** link guides never write it. Never add IDs, URLs, or tokens to that payload.
- **Migrations:** hand-written SQL in a `prisma/migrations/YYYYMMDDHHMMSS_name/` folder.
  - `ALTER TYPE ... ADD VALUE` goes before `BEGIN`.
  - The transaction body starts with `SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';`.
  - New tables enable RLS and revoke `anon`/`authenticated`.
- **Contract DB:** the `insta-contract-pg` container (user `postgres`, password `disposable`, db `contract`, port 5433). Check it is up with `docker ps --filter name=insta-contract-pg`. Contract suites run with:
  `MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract`
  Without these variables, contract suites `describe.skip`.
- **Shell:** zsh with `interactivecomments` off. Never put a `# note` on a command line.
- **Deploy:** merging to `main` deploys Railway and Vercel. Never run `railway up`. Both new flags default off, so a merge changes nothing for parents.
- **Commits:** the owner's rule is "never commit unless asked". Commit steps below run only after the owner approves executing this plan.

## File map

**Backend, new files:**

| Path | Responsibility |
|---|---|
| `src/services/linkGuidePolicy.ts` | Pure rules: field validation, allowed hosts, UTM URL, click classification, token, card text |
| `src/meta/linkGuidePayloads.ts` | Pure Meta payload builders (card, text) |
| `src/meta/linkGuideCapabilitySpike.ts` + `scripts/link-guide-capability-spike.ts` | Launch-test harness |
| `src/services/linkGuideRepository.ts` | Prisma reads and writes for sends and clicks |
| `src/services/linkGuideFlowCore.ts` | Send orchestration with injected dependencies (unit-tested) |
| `src/services/linkGuideFlow.ts` | Wires the core to real modules; exports `linkGuideFlow`, `linkGuideRepository` |
| `src/services/guideOwner.ts` | `guideOwnerFor`: `"link"` before the V1/V2 selector |
| `src/api/linkRedirect.routes.ts` | Public `GET /r/:token` |
| `src/services/funnels/linkClickFunnel.ts` | Link funnel definition, SQL, summarizer |

**Backend, modified files:**
- `prisma/schema.prisma`
- `src/config/env.ts`
- `src/config/flagRegistry.ts`
- `src/services/keywordService.ts`
- `src/handlers/commentHandler.ts`
- `src/handlers/messageHandler.ts`
- `src/services/gateQueueWorker.ts`
- `src/services/conversationService.ts`
- `src/services/dmRecoveryPolicy.ts`
- `src/services/dmRecoveryService.ts`
- `src/api/resources.routes.ts`
- `src/api/keywords.routes.ts`
- `src/api/conversations.routes.ts`
- `src/api/funnels.routes.ts`
- `src/services/funnels/{guideFollowFunnel,dropOff,runFunnel,registry}.ts`
- `src/server.ts`

**Web, new files:**
- `web/src/components/DeliveryBadge.tsx`
- `web/src/features/link-guides/{LinkGuidePanel.tsx,linkGuideErrors.ts}`
- `web/src/components/funnels/LinkClickPanel.tsx`

**Web, modified files:**
- `web/src/lib/types.ts`
- `web/src/lib/automationCopy.ts`
- `web/src/components/KeywordForm.tsx`
- `web/src/pages/{SequenceEditor,Sequences,Content,Conversations,Funnels}.tsx`

## Order and the launch gate

Tasks 1–3 build what the Meta launch test needs. **After Task 3, stop.** The owner runs the two launch-test cases (Task 3, Step 8) and records the result.

| Result | What to do |
|---|---|
| Card `supported` | Continue with Tasks 4–17 unchanged. Turn `LINK_GUIDE_CARD_ENABLED` on at launch |
| Only text `supported` | Continue with Tasks 4–17. `LINK_GUIDE_CARD_ENABLED` stays off, and `go.mycuratedhaven.com` becomes a launch requirement (Task 17) |
| Neither `supported` | Stop. Link guides need a tap-first design; go back to brainstorming |

---

### Task 1: Link guide policy (pure rules)

**Files:**
- Create: `src/services/linkGuidePolicy.ts`
- Test: `src/services/linkGuidePolicy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Types:
    - `DeliveryMode = "gated" | "link"`
    - `LinkGuideResource = { id; name; description: string | null; deliveryMode: DeliveryMode; linkUrl: string | null; linkButtonLabel: string | null; linkCardTitle: string | null; linkCardSubtitle: string | null }`
    - `LinkGuideFieldError` (union of 8 codes)
    - `ClickClassification = { isBot: boolean; uaFamily: "head_request" | "meta_preview" | "bot" | "instagram_app" | "browser" | "unknown" }`
  - Constants:
    - `LINK_GUIDE_RESOURCE_SELECT`
    - `DEFAULT_LINK_GUIDE_ALLOWED_HOSTS`
    - `LINK_BUTTON_LABEL_MAX = 20`
    - `LINK_CARD_TEXT_MAX = 80`
    - `MAX_RECORDED_CLICKS_PER_SEND = 20`
    - `LINK_TOKEN_PATTERN`
    - `LINK_CARD_DEFAULT_SUBTITLE`
  - Functions:
    - `codePoints(s): number`
    - `parseAllowedHosts(value): ReadonlySet<string>`
    - `isAllowedLinkUrl(url, hosts): boolean`
    - `validateLinkGuideFields(fields, hosts): LinkGuideFieldError | null`
    - `campaignSlug(name): string`
    - `buildDestinationUrl({ linkUrl, guideName, mediaId }): string`
    - `classifyClick({ userAgent, method }): ClickClassification`
    - `newLinkToken(): string`
    - `trackedLinkUrl(baseUrl, token): string`
    - `linkCardTitle(resource): string`
    - `linkCardSubtitle(resource): string`
    - `linkGuideText({ title, url }): string`
    - `fallbackRedirectUrl(hosts): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/services/linkGuidePolicy.test.ts
import { describe, expect, it } from "vitest";
import {
  buildDestinationUrl,
  campaignSlug,
  classifyClick,
  codePoints,
  fallbackRedirectUrl,
  isAllowedLinkUrl,
  LINK_TOKEN_PATTERN,
  linkCardSubtitle,
  linkCardTitle,
  linkGuideText,
  newLinkToken,
  parseAllowedHosts,
  trackedLinkUrl,
  validateLinkGuideFields,
  type LinkGuideResource,
} from "./linkGuidePolicy.js";

const HOSTS = parseAllowedHosts("mycuratedhaven.com, WWW.mycuratedhaven.com");
const INSTAGRAM_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 312.0.0.0.0";

const LINK: LinkGuideResource = {
  id: "res-1",
  name: "Halloween collection",
  description: "8 toddler-friendly recipes",
  deliveryMode: "link",
  linkUrl: "https://mycuratedhaven.com/halloween",
  linkButtonLabel: "Open the recipes",
  linkCardTitle: null,
  linkCardSubtitle: null,
};

describe("parseAllowedHosts", () => {
  it("trims, lowercases and drops blanks", () => {
    expect([...HOSTS]).toEqual(["mycuratedhaven.com", "www.mycuratedhaven.com"]);
    expect(parseAllowedHosts(" , ").size).toBe(0);
  });
});

describe("validateLinkGuideFields", () => {
  it("accepts a gated guide with no link fields", () => {
    expect(
      validateLinkGuideFields(
        { ...LINK, deliveryMode: "gated", linkUrl: null, linkButtonLabel: null },
        HOSTS,
      ),
    ).toBeNull();
  });

  it("accepts a complete link guide, counting emoji as one character", () => {
    expect(
      validateLinkGuideFields({ ...LINK, linkButtonLabel: "Open the recipes 👻👻👻" }, HOSTS),
    ).toBeNull();
  });

  it("accepts an allowed host written in capitals", () => {
    expect(
      validateLinkGuideFields({ ...LINK, linkUrl: "https://MyCuratedHaven.com/halloween" }, HOSTS),
    ).toBeNull();
  });

  it.each([
    [{ linkUrl: null }, "link_url_required"],
    [{ linkUrl: "   " }, "link_url_required"],
    [{ linkUrl: "not a url" }, "link_url_invalid"],
    [{ linkUrl: "http://mycuratedhaven.com/halloween" }, "link_url_not_https"],
    [{ linkUrl: "https://evil.example/halloween" }, "link_url_host_not_allowed"],
    [{ linkButtonLabel: null }, "link_button_label_required"],
    [{ linkButtonLabel: "  " }, "link_button_label_required"],
    [{ linkButtonLabel: "This label is far too long" }, "link_button_label_too_long"],
    [{ linkCardTitle: "x".repeat(81) }, "link_card_title_too_long"],
    [{ linkCardSubtitle: "x".repeat(81) }, "link_card_subtitle_too_long"],
  ] as const)("rejects %o with %s", (patch, code) => {
    expect(validateLinkGuideFields({ ...LINK, ...patch }, HOSTS)).toBe(code);
  });

  it("rejects a bad saved URL even on a gated guide, so it can never go live later", () => {
    expect(
      validateLinkGuideFields(
        { ...LINK, deliveryMode: "gated", linkUrl: "https://evil.example/x" },
        HOSTS,
      ),
    ).toBe("link_url_host_not_allowed");
  });
});

describe("isAllowedLinkUrl", () => {
  it("allows only https on an allowed host", () => {
    expect(isAllowedLinkUrl("https://mycuratedhaven.com/halloween", HOSTS)).toBe(true);
    expect(isAllowedLinkUrl("http://mycuratedhaven.com/halloween", HOSTS)).toBe(false);
    expect(isAllowedLinkUrl("https://mycuratedhaven.com.evil.example/", HOSTS)).toBe(false);
    expect(isAllowedLinkUrl("javascript:alert(1)", HOSTS)).toBe(false);
  });
});

describe("campaignSlug", () => {
  it.each([
    ["Halloween collection", "halloween-collection"],
    ["Café Crème 👻!!", "cafe-creme"],
    ["👻", "guide"],
  ])("%s → %s", (name, slug) => {
    expect(campaignSlug(name)).toBe(slug);
  });
});

describe("buildDestinationUrl", () => {
  it("adds the UTM tags for the reel", () => {
    expect(
      buildDestinationUrl({
        linkUrl: "https://mycuratedhaven.com/halloween",
        guideName: "Halloween collection",
        mediaId: "reel-9",
      }),
    ).toBe(
      "https://mycuratedhaven.com/halloween?utm_source=instagram&utm_medium=dm&utm_campaign=halloween-collection&utm_content=reel-9",
    );
  });

  it("keeps the page's own query and overwrites stale UTM tags", () => {
    expect(
      buildDestinationUrl({
        linkUrl: "https://mycuratedhaven.com/halloween?ref=x&utm_source=old",
        guideName: "Halloween",
        mediaId: "reel-1",
      }),
    ).toBe(
      "https://mycuratedhaven.com/halloween?ref=x&utm_source=instagram&utm_medium=dm&utm_campaign=halloween&utm_content=reel-1",
    );
  });

  it("omits utm_content when the reel is unknown", () => {
    expect(
      buildDestinationUrl({
        linkUrl: "https://mycuratedhaven.com/halloween",
        guideName: "Halloween",
        mediaId: null,
      }),
    ).toBe(
      "https://mycuratedhaven.com/halloween?utm_source=instagram&utm_medium=dm&utm_campaign=halloween",
    );
  });
});

describe("classifyClick", () => {
  it.each([
    [{ method: "HEAD", userAgent: INSTAGRAM_UA }, { isBot: true, uaFamily: "head_request" }],
    [
      { method: "GET", userAgent: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" },
      { isBot: true, uaFamily: "meta_preview" },
    ],
    [{ method: "GET", userAgent: "meta-externalagent/1.1" }, { isBot: true, uaFamily: "meta_preview" }],
    [{ method: "GET", userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" }, { isBot: true, uaFamily: "bot" }],
    [{ method: "GET", userAgent: "" }, { isBot: true, uaFamily: "unknown" }],
    [{ method: "GET", userAgent: INSTAGRAM_UA }, { isBot: false, uaFamily: "instagram_app" }],
    [
      {
        method: "GET",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      },
      { isBot: false, uaFamily: "browser" },
    ],
  ])("%o", (input, expected) => {
    expect(classifyClick(input)).toEqual(expected);
  });
});

describe("tokens and card text", () => {
  it("mints distinct 11-character URL-safe tokens", () => {
    const a = newLinkToken();
    const b = newLinkToken();
    expect(a).toMatch(LINK_TOKEN_PATTERN);
    expect(b).toMatch(LINK_TOKEN_PATTERN);
    expect(a).not.toBe(b);
  });

  it("builds the tracked URL without a doubled slash", () => {
    expect(trackedLinkUrl("https://api.example.com/", "tok_ABCDEFG")).toBe(
      "https://api.example.com/r/tok_ABCDEFG",
    );
  });

  it("falls back to the guide name and description for the card", () => {
    expect(linkCardTitle(LINK)).toBe("Halloween collection");
    expect(linkCardSubtitle(LINK)).toBe("8 toddler-friendly recipes");
    expect(linkCardSubtitle({ ...LINK, description: null })).toBe("Tap below to open it.");
    expect(linkCardTitle({ ...LINK, linkCardTitle: "Your Halloween recipes 👻" })).toBe(
      "Your Halloween recipes 👻",
    );
  });

  it("cuts a long name to 80 characters", () => {
    expect(codePoints(linkCardTitle({ ...LINK, name: "👻".repeat(90) }))).toBe(80);
  });

  it("puts the title above the link", () => {
    expect(
      linkGuideText({ title: "Your Halloween recipes 👻", url: "https://api.example.com/r/tok_ABCDEFG" }),
    ).toBe("Your Halloween recipes 👻\nhttps://api.example.com/r/tok_ABCDEFG");
  });

  it("falls back to the first allowed host's home page", () => {
    expect(fallbackRedirectUrl(HOSTS)).toBe("https://mycuratedhaven.com/");
    expect(fallbackRedirectUrl(new Set())).toBe("https://www.instagram.com/tinysoho/");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/services/linkGuidePolicy.test.ts`
Expected: FAIL, `Failed to resolve import "./linkGuidePolicy.js"`.

- [ ] **Step 3: Write the implementation**

```ts
// src/services/linkGuidePolicy.ts
import { randomBytes } from "node:crypto";

/**
 * Pure rules for link guides: field validation, the tracked URL, UTM tagging and click
 * classification. No database, no network and no env import, so the API, the sender
 * and the redirect all apply exactly the same rules, and every rule is unit-testable.
 */

export type DeliveryMode = "gated" | "link";

export type LinkGuideResource = {
  id: string;
  name: string;
  description: string | null;
  deliveryMode: DeliveryMode;
  linkUrl: string | null;
  linkButtonLabel: string | null;
  linkCardTitle: string | null;
  linkCardSubtitle: string | null;
};

/** Prisma `select` for exactly the fields of `LinkGuideResource`. */
export const LINK_GUIDE_RESOURCE_SELECT = {
  id: true,
  name: true,
  description: true,
  deliveryMode: true,
  linkUrl: true,
  linkButtonLabel: true,
  linkCardTitle: true,
  linkCardSubtitle: true,
} as const;

export const DEFAULT_LINK_GUIDE_ALLOWED_HOSTS = "mycuratedhaven.com,www.mycuratedhaven.com";
/** Meta's button title limit. Confirmed by the launch test. */
export const LINK_BUTTON_LABEL_MAX = 20;
/** Meta's generic-template title and subtitle limit. */
export const LINK_CARD_TEXT_MAX = 80;
/** No rate-limit library exists here; this cap keeps a scraper from growing the table. */
export const MAX_RECORDED_CLICKS_PER_SEND = 20;
export const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const LINK_CARD_DEFAULT_SUBTITLE = "Tap below to open it.";
const LAST_RESORT_REDIRECT = "https://www.instagram.com/tinysoho/";

export type LinkGuideFieldError =
  | "link_url_required"
  | "link_url_invalid"
  | "link_url_not_https"
  | "link_url_host_not_allowed"
  | "link_button_label_required"
  | "link_button_label_too_long"
  | "link_card_title_too_long"
  | "link_card_subtitle_too_long";

export type ClickClassification = {
  isBot: boolean;
  uaFamily: "head_request" | "meta_preview" | "bot" | "instagram_app" | "browser" | "unknown";
};

/** Instagram counts characters as code points, so "👻" is one, not two. */
export function codePoints(value: string): number {
  return [...value].length;
}

function truncate(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

export function parseAllowedHosts(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
  );
}

function parseHttpsUrl(value: string): URL | "invalid" | "not_https" {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  return url.protocol === "https:" ? url : "not_https";
}

export function isAllowedLinkUrl(value: string, allowedHosts: ReadonlySet<string>): boolean {
  const url = parseHttpsUrl(value);
  return typeof url !== "string" && allowedHosts.has(url.hostname.toLowerCase());
}

/**
 * Requiredness applies only to link guides, but a value that IS present is always
 * checked: a bad URL saved on a gated guide must never go live when the guide flips.
 */
export function validateLinkGuideFields(
  fields: Pick<
    LinkGuideResource,
    "deliveryMode" | "linkUrl" | "linkButtonLabel" | "linkCardTitle" | "linkCardSubtitle"
  >,
  allowedHosts: ReadonlySet<string>,
): LinkGuideFieldError | null {
  const isLink = fields.deliveryMode === "link";
  const url = fields.linkUrl?.trim() ?? "";
  if (url.length > 0) {
    const parsed = parseHttpsUrl(url);
    if (parsed === "invalid") return "link_url_invalid";
    if (parsed === "not_https") return "link_url_not_https";
    if (!allowedHosts.has(parsed.hostname.toLowerCase())) return "link_url_host_not_allowed";
  } else if (isLink) {
    return "link_url_required";
  }

  const label = fields.linkButtonLabel?.trim() ?? "";
  if (codePoints(label) > LINK_BUTTON_LABEL_MAX) return "link_button_label_too_long";
  if (isLink && label.length === 0) return "link_button_label_required";

  if (fields.linkCardTitle !== null && codePoints(fields.linkCardTitle.trim()) > LINK_CARD_TEXT_MAX) {
    return "link_card_title_too_long";
  }
  if (
    fields.linkCardSubtitle !== null &&
    codePoints(fields.linkCardSubtitle.trim()) > LINK_CARD_TEXT_MAX
  ) {
    return "link_card_subtitle_too_long";
  }
  return null;
}

export function campaignSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 64)
    .replace(/-$/u, "");
  return slug.length > 0 ? slug : "guide";
}

export function buildDestinationUrl(input: {
  linkUrl: string;
  guideName: string;
  mediaId: string | null;
}): string {
  const url = new URL(input.linkUrl);
  url.searchParams.set("utm_source", "instagram");
  url.searchParams.set("utm_medium", "dm");
  url.searchParams.set("utm_campaign", campaignSlug(input.guideName));
  if (input.mediaId) url.searchParams.set("utm_content", input.mediaId);
  else url.searchParams.delete("utm_content");
  return url.toString();
}

const META_PREVIEW_AGENTS = /facebookexternalhit|meta-externalagent|facebookcatalog/i;
const GENERIC_BOTS = /bot|crawler|spider|preview|slurp|curl|wget|python-requests|headless/i;
const INSTAGRAM_APP = /Instagram/;

/** A tap counts only from a real browser. An empty user agent is treated as a bot. */
export function classifyClick(input: { userAgent: string; method: string }): ClickClassification {
  if (input.method.toUpperCase() === "HEAD") return { isBot: true, uaFamily: "head_request" };
  const userAgent = input.userAgent.trim();
  if (userAgent.length === 0) return { isBot: true, uaFamily: "unknown" };
  if (META_PREVIEW_AGENTS.test(userAgent)) return { isBot: true, uaFamily: "meta_preview" };
  if (GENERIC_BOTS.test(userAgent)) return { isBot: true, uaFamily: "bot" };
  if (INSTAGRAM_APP.test(userAgent)) return { isBot: false, uaFamily: "instagram_app" };
  return { isBot: false, uaFamily: "browser" };
}

/** 8 random bytes → 11 base64url characters, no padding. Carries no user data. */
export function newLinkToken(): string {
  return randomBytes(8).toString("base64url");
}

export function trackedLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/r/${token}`;
}

export function linkCardTitle(resource: Pick<LinkGuideResource, "name" | "linkCardTitle">): string {
  return truncate(resource.linkCardTitle?.trim() || resource.name.trim(), LINK_CARD_TEXT_MAX);
}

export function linkCardSubtitle(
  resource: Pick<LinkGuideResource, "description" | "linkCardSubtitle">,
): string {
  return truncate(
    resource.linkCardSubtitle?.trim() || resource.description?.trim() || LINK_CARD_DEFAULT_SUBTITLE,
    LINK_CARD_TEXT_MAX,
  );
}

export function linkGuideText(input: { title: string; url: string }): string {
  return `${input.title}\n${input.url}`;
}

export function fallbackRedirectUrl(allowedHosts: ReadonlySet<string>): string {
  const [first] = allowedHosts;
  return first ? `https://${first}/` : LAST_RESORT_REDIRECT;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/services/linkGuidePolicy.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/linkGuidePolicy.ts src/services/linkGuidePolicy.test.ts
git commit -m "feat: add link guide policy rules"
```

---

### Task 2: Meta payload builders for link guides

**Files:**
- Create: `src/meta/linkGuidePayloads.ts`
- Test: `src/meta/linkGuidePayloads.test.ts`

**Interfaces:**
- Consumes: from Task 1, `codePoints`, `LINK_BUTTON_LABEL_MAX` and `LINK_CARD_TEXT_MAX`. Also `IG_TEXT_CHAR_LIMIT` from `src/lib/instagramLimits.ts` and the type `MetaMessagePayload` from `src/meta/sendMessage.ts`.
- Produces:
  - `LinkGuideRecipient = { comment_id: string } | { id: string }`
  - `LINK_GUIDE_FOLLOW_BUTTON_LABEL = "Follow @tinysoho"`
  - `buildLinkGuideCardPayload({ recipient, title, subtitle, coverUrl, buttonLabel, trackedUrl, profileUrl }): MetaMessagePayload`
  - `buildLinkGuideTextPayload({ recipient, text }): MetaMessagePayload`
  - Both builders throw `Error("invalid_link_guide_payload")` on bad input.

- [ ] **Step 1: Write the failing test**

```ts
// src/meta/linkGuidePayloads.test.ts
import { describe, expect, it } from "vitest";
import {
  buildLinkGuideCardPayload,
  buildLinkGuideTextPayload,
  LINK_GUIDE_FOLLOW_BUTTON_LABEL,
} from "./linkGuidePayloads.js";

const CARD = {
  title: "Your Halloween recipes 👻",
  subtitle: "8 toddler-friendly recipes, ready to cook",
  coverUrl: "https://cdn.example.com/cover.png",
  buttonLabel: "Open the recipes",
  trackedUrl: "https://api.example.com/r/tok_ABCDEFG",
  profileUrl: "https://www.instagram.com/tinysoho/",
};

describe("buildLinkGuideCardPayload", () => {
  it("builds the private-reply card with the link first and the follow button second", () => {
    expect(buildLinkGuideCardPayload({ ...CARD, recipient: { comment_id: "comment-1" } })).toEqual({
      recipient: { comment_id: "comment-1" },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements: [
              {
                title: CARD.title,
                subtitle: CARD.subtitle,
                image_url: CARD.coverUrl,
                default_action: { type: "web_url", url: CARD.trackedUrl },
                buttons: [
                  { type: "web_url", url: CARD.trackedUrl, title: "Open the recipes" },
                  { type: "web_url", url: CARD.profileUrl, title: LINK_GUIDE_FOLLOW_BUTTON_LABEL },
                ],
              },
            ],
          },
        },
      },
    });
  });

  it("marks an open-thread DM as a response", () => {
    const payload = buildLinkGuideCardPayload({ ...CARD, recipient: { id: "ig-parent" } });
    expect(payload.recipient).toEqual({ id: "ig-parent" });
    expect(payload.messaging_type).toBe("RESPONSE");
  });

  it.each([
    { trackedUrl: "http://api.example.com/r/tok_ABCDEFG" },
    { coverUrl: "not a url" },
    { buttonLabel: "This label is far too long" },
    { title: "" },
    { subtitle: "x".repeat(81) },
  ])("refuses %o", (patch) => {
    expect(() =>
      buildLinkGuideCardPayload({ ...CARD, ...patch, recipient: { comment_id: "comment-1" } }),
    ).toThrow("invalid_link_guide_payload");
  });
});

describe("buildLinkGuideTextPayload", () => {
  it("sends plain text in the private-reply slot", () => {
    const text = "Your Halloween recipes 👻\nhttps://api.example.com/r/tok_ABCDEFG";
    expect(buildLinkGuideTextPayload({ recipient: { comment_id: "comment-1" }, text })).toEqual({
      recipient: { comment_id: "comment-1" },
      message: { text },
    });
  });

  it("refuses empty text", () => {
    expect(() => buildLinkGuideTextPayload({ recipient: { id: "ig-parent" }, text: "  " })).toThrow(
      "invalid_link_guide_payload",
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/meta/linkGuidePayloads.test.ts`
Expected: FAIL, the import cannot be resolved.

- [ ] **Step 3: Write the implementation**

```ts
// src/meta/linkGuidePayloads.ts
import type { MetaMessagePayload } from "./sendMessage.js";
import { IG_TEXT_CHAR_LIMIT } from "../lib/instagramLimits.js";
import {
  codePoints,
  LINK_BUTTON_LABEL_MAX,
  LINK_CARD_TEXT_MAX,
} from "../services/linkGuidePolicy.js";

/** 16 characters, inside Meta's 20-character button limit. */
export const LINK_GUIDE_FOLLOW_BUTTON_LABEL = "Follow @tinysoho";

export type LinkGuideRecipient = { comment_id: string } | { id: string };

type WebUrlButton = { type: "web_url"; url: string; title: string };

function invalid(): never {
  throw new Error("invalid_link_guide_payload");
}

function text(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || codePoints(trimmed) > max) invalid();
  return trimmed;
}

function https(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (url.protocol !== "https:") invalid();
  return value;
}

/** Private replies address a comment and carry no messaging_type, like sendPrivateReply. */
function envelope(recipient: LinkGuideRecipient): Omit<MetaMessagePayload, "message"> {
  return "comment_id" in recipient ? { recipient } : { recipient, messaging_type: "RESPONSE" };
}

export function buildLinkGuideCardPayload(input: {
  recipient: LinkGuideRecipient;
  title: string;
  subtitle: string;
  coverUrl: string;
  buttonLabel: string;
  trackedUrl: string;
  profileUrl: string;
}): MetaMessagePayload {
  const trackedUrl = https(input.trackedUrl);
  const buttons: WebUrlButton[] = [
    { type: "web_url", url: trackedUrl, title: text(input.buttonLabel, LINK_BUTTON_LABEL_MAX) },
    { type: "web_url", url: https(input.profileUrl), title: LINK_GUIDE_FOLLOW_BUTTON_LABEL },
  ];
  return {
    ...envelope(input.recipient),
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [
            {
              title: text(input.title, LINK_CARD_TEXT_MAX),
              subtitle: text(input.subtitle, LINK_CARD_TEXT_MAX),
              image_url: https(input.coverUrl),
              default_action: { type: "web_url", url: trackedUrl },
              buttons,
            },
          ],
        },
      },
    },
  };
}

export function buildLinkGuideTextPayload(input: {
  recipient: LinkGuideRecipient;
  text: string;
}): MetaMessagePayload {
  return { ...envelope(input.recipient), message: { text: text(input.text, IG_TEXT_CHAR_LIMIT) } };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/meta/linkGuidePayloads.test.ts`
Expected: PASS.

If `src/lib/instagramLimits.ts` turns out to import `env` and the test then fails on env validation, replace that import with `const IG_TEXT_CHAR_LIMIT = 1000;` in this file and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/meta/linkGuidePayloads.ts src/meta/linkGuidePayloads.test.ts
git commit -m "feat: add link guide Meta payload builders"
```

---

### Task 3: Launch-test harness (then STOP for the owner)

**Files:**
- Create: `src/meta/linkGuideCapabilitySpike.ts`
- Create: `scripts/link-guide-capability-spike.ts`
- Test: `src/meta/linkGuideCapabilitySpike.test.ts`
- Modify: `package.json` (scripts)
- Modify: `docs/meta-guide-gate-capability-runbook.md` (append a section)

**Interfaces:**
- Consumes: from Task 2, `buildLinkGuideCardPayload` and `buildLinkGuideTextPayload`. From Task 1, `linkGuideText`.
- Produces:
  - `LINK_GUIDE_SPIKE_CASES`
  - `LinkGuideSpikeCase`
  - `parseLinkGuideSpikeCli(args)`
  - `buildLinkGuideSpikePayload(case, environment)`
  - `runLinkGuideSpikeCase(deps, input): Promise<LinkGuideSpikeResult>`

- [ ] **Step 1: Write the failing test**

```ts
// src/meta/linkGuideCapabilitySpike.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  buildLinkGuideSpikePayload,
  parseLinkGuideSpikeCli,
  runLinkGuideSpikeCase,
} from "./linkGuideCapabilitySpike.js";

const ENV = {
  META_SPIKE_COMMENT_ID: "17890000000000001",
  META_SPIKE_LINK_URL: "https://mycuratedhaven.com/halloween?utm_source=spike",
  META_SPIKE_COVER_URL: "https://cdn.example.com/cover.png",
  META_SPIKE_PROFILE_URL: "https://www.instagram.com/tinysoho/",
};
const now = () => new Date("2026-10-13T15:00:00.000Z");

describe("parseLinkGuideSpikeCli", () => {
  it("reads the case and the explicit confirmation", () => {
    expect(parseLinkGuideSpikeCli(["--case", "private_link_card", "--confirm-controlled-send"])).toEqual({
      case: "private_link_card",
      confirmedControlledSend: true,
    });
  });

  it("rejects an unknown case and unknown flags", () => {
    expect(() => parseLinkGuideSpikeCli(["--case", "private_generic"])).toThrow(
      "invalid_link_guide_spike_case",
    );
    expect(() => parseLinkGuideSpikeCli(["--case", "private_link_card", "--yes"])).toThrow(
      "invalid_link_guide_spike_args",
    );
  });
});

describe("buildLinkGuideSpikePayload", () => {
  it("builds the card case from the environment", () => {
    const payload = buildLinkGuideSpikePayload("private_link_card", ENV);
    expect(payload.recipient).toEqual({ comment_id: ENV.META_SPIKE_COMMENT_ID });
    expect(JSON.stringify(payload)).toContain(ENV.META_SPIKE_LINK_URL);
  });

  it("builds the text case with the link in the body", () => {
    expect(buildLinkGuideSpikePayload("private_link_text", ENV).message).toEqual({
      text: `Your Halloween recipes 👻\n${ENV.META_SPIKE_LINK_URL}`,
    });
  });

  it("names the missing variable", () => {
    expect(() =>
      buildLinkGuideSpikePayload("private_link_card", { ...ENV, META_SPIKE_COVER_URL: undefined }),
    ).toThrow("missing_meta_spike_cover_url");
  });
});

describe("runLinkGuideSpikeCase", () => {
  const payload = buildLinkGuideSpikePayload("private_link_text", ENV);

  it("refuses to send without the explicit confirmation", async () => {
    const send = vi.fn();
    await expect(
      runLinkGuideSpikeCase({ send, now }, { case: "private_link_text", confirmedControlledSend: false, payload }),
    ).rejects.toThrow("controlled_send_not_confirmed");
    expect(send).not.toHaveBeenCalled();
  });

  it("reports acceptance without echoing the message id", async () => {
    const result = await runLinkGuideSpikeCase(
      { send: async () => ({ status: 200, data: { message_id: "mid.SECRET" } }), now },
      { case: "private_link_text", confirmedControlledSend: true, payload },
    );
    expect(result).toEqual({
      case: "private_link_text",
      accepted: true,
      httpStatus: 200,
      graphCode: null,
      graphSubcode: null,
      providerMessageIdPresent: true,
      checkedAt: "2026-10-13T15:00:00.000Z",
    });
  });

  it("reports a Graph rejection by code only", async () => {
    const error = Object.assign(new Error("PROVIDER-MESSAGE"), {
      response: { status: 400, data: { error: { code: 100, error_subcode: 2018001, message: "PROVIDER-MESSAGE" } } },
    });
    const result = await runLinkGuideSpikeCase(
      { send: async () => { throw error; }, now },
      { case: "private_link_text", confirmedControlledSend: true, payload },
    );
    expect(result).toEqual({
      case: "private_link_text",
      accepted: false,
      httpStatus: 400,
      graphCode: 100,
      graphSubcode: 2018001,
      providerMessageIdPresent: false,
      checkedAt: "2026-10-13T15:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("PROVIDER-MESSAGE");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/meta/linkGuideCapabilitySpike.test.ts`
Expected: FAIL, the import cannot be resolved.

- [ ] **Step 3: Write the spike module**

```ts
// src/meta/linkGuideCapabilitySpike.ts
import type { MetaMessagePayload } from "./sendMessage.js";
import { buildLinkGuideCardPayload, buildLinkGuideTextPayload } from "./linkGuidePayloads.js";
import { linkGuideText } from "../services/linkGuidePolicy.js";

/**
 * One-shot launch test for link guides in the comment private-reply slot. Meta allows one
 * private reply per comment, so each case spends one fresh controlled comment and must
 * never be retried against the same comment.
 */
export const LINK_GUIDE_SPIKE_CASES = ["private_link_card", "private_link_text"] as const;
export type LinkGuideSpikeCase = (typeof LINK_GUIDE_SPIKE_CASES)[number];

export type LinkGuideSpikeResult = {
  case: LinkGuideSpikeCase;
  accepted: boolean;
  httpStatus: number | null;
  graphCode: number | null;
  graphSubcode: number | null;
  providerMessageIdPresent: boolean;
  checkedAt: string;
};

const SPIKE_TITLE = "Your Halloween recipes 👻";
const SPIKE_SUBTITLE = "8 toddler-friendly recipes, ready to cook";
const SPIKE_BUTTON = "Open the recipes";

export function parseLinkGuideSpikeCli(args: string[]): {
  case: LinkGuideSpikeCase;
  confirmedControlledSend: boolean;
} {
  let spikeCase: string | undefined;
  let confirmedControlledSend = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--case") {
      spikeCase = args[index + 1];
      index++;
    } else if (arg === "--confirm-controlled-send") {
      confirmedControlledSend = true;
    } else {
      throw new Error("invalid_link_guide_spike_args");
    }
  }
  if (!LINK_GUIDE_SPIKE_CASES.includes(spikeCase as LinkGuideSpikeCase)) {
    throw new Error("invalid_link_guide_spike_case");
  }
  return { case: spikeCase as LinkGuideSpikeCase, confirmedControlledSend };
}

function required(environment: Record<string, string | undefined>, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`missing_${key.toLowerCase()}`);
  return value;
}

export function buildLinkGuideSpikePayload(
  spikeCase: LinkGuideSpikeCase,
  environment: Record<string, string | undefined>,
): MetaMessagePayload {
  const recipient = { comment_id: required(environment, "META_SPIKE_COMMENT_ID") };
  const linkUrl = required(environment, "META_SPIKE_LINK_URL");
  if (spikeCase === "private_link_text") {
    return buildLinkGuideTextPayload({ recipient, text: linkGuideText({ title: SPIKE_TITLE, url: linkUrl }) });
  }
  return buildLinkGuideCardPayload({
    recipient,
    title: SPIKE_TITLE,
    subtitle: SPIKE_SUBTITLE,
    coverUrl: required(environment, "META_SPIKE_COVER_URL"),
    buttonLabel: SPIKE_BUTTON,
    trackedUrl: linkUrl,
    profileUrl: required(environment, "META_SPIKE_PROFILE_URL"),
  });
}

type GraphFailure = {
  response?: { status?: number; data?: { error?: { code?: number; error_subcode?: number } } };
};

export async function runLinkGuideSpikeCase(
  deps: {
    send: (payload: MetaMessagePayload) => Promise<{ status: number; data: { message_id?: string } }>;
    now: () => Date;
  },
  input: { case: LinkGuideSpikeCase; confirmedControlledSend: boolean; payload: MetaMessagePayload },
): Promise<LinkGuideSpikeResult> {
  if (!input.confirmedControlledSend) throw new Error("controlled_send_not_confirmed");
  try {
    const response = await deps.send(input.payload);
    return {
      case: input.case,
      accepted: true,
      httpStatus: response.status,
      graphCode: null,
      graphSubcode: null,
      providerMessageIdPresent: typeof response.data.message_id === "string",
      checkedAt: deps.now().toISOString(),
    };
  } catch (error) {
    const response = (error as GraphFailure).response;
    return {
      case: input.case,
      accepted: false,
      httpStatus: response?.status ?? null,
      graphCode: response?.data?.error?.code ?? null,
      graphSubcode: response?.data?.error?.error_subcode ?? null,
      providerMessageIdPresent: false,
      checkedAt: deps.now().toISOString(),
    };
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/meta/linkGuideCapabilitySpike.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the CLI script and its npm script**

```ts
// scripts/link-guide-capability-spike.ts
// @prisma/client first: from a worktree it is what loads .env into process.env, and env
// validation below would otherwise exit 1.
import "@prisma/client";
import { pathToFileURL } from "node:url";
import { env } from "../src/config/env.js";
import { graph } from "../src/meta/graphClient.js";
import {
  buildLinkGuideSpikePayload,
  parseLinkGuideSpikeCli,
  runLinkGuideSpikeCase,
} from "../src/meta/linkGuideCapabilitySpike.js";
import type { MetaMessagePayload } from "../src/meta/sendMessage.js";

type GraphSendResponse = { message_id?: string };

export async function runLinkGuideCapabilityCli(
  args: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const parsed = parseLinkGuideSpikeCli(args);
  const payload = buildLinkGuideSpikePayload(parsed.case, environment);
  const result = await runLinkGuideSpikeCase(
    {
      now: () => new Date(),
      send: async (body: MetaMessagePayload) => {
        const response = await graph.post<GraphSendResponse>(`/${env.IG_USER_ID}/messages`, body);
        return { status: response.status, data: response.data };
      },
    },
    { case: parsed.case, confirmedControlledSend: parsed.confirmedControlledSend, payload },
  );
  console.log(JSON.stringify(result));
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  runLinkGuideCapabilityCli().catch(() => {
    console.error("link_guide_capability_failed");
    process.exitCode = 1;
  });
}
```

In `package.json` `scripts`, add this line directly after `"verify:meta-guide-gate": ...`:

```json
    "verify:link-guide": "tsx scripts/link-guide-capability-spike.ts",
```

- [ ] **Step 6: Append the runbook section**

Append to `docs/meta-guide-gate-capability-runbook.md`:

````markdown
## Link guide cases (added 2026-10-12)

These are two more one-shot private-reply cases, for link guides. The authorization, controlled accounts and one-comment-per-case rules above all apply. Each case spends one fresh comment from the controlled recipient on a TinySoho test post.

| Case | Command | Pass condition |
|---|---|---|
| `private_link_card` | `npm run verify:link-guide -- --case private_link_card --confirm-controlled-send` | Output shows `accepted: true`. The card lands in the recipient's Message Requests. Tapping **Open the recipes** on a phone opens the page without accepting the request first |
| `private_link_text` | `npm run verify:link-guide -- --case private_link_text --confirm-controlled-send` | Output shows `accepted: true`. The link in the text can be tapped from Message Requests on a phone |

Environment for both cases:
- `META_SPIKE_COMMENT_ID`: a fresh comment.
- `META_SPIKE_LINK_URL`: `https://mycuratedhaven.com/halloween?utm_source=spike`.

Card case only:
- `META_SPIKE_COVER_URL`: a public square image.
- `META_SPIKE_PROFILE_URL`: `https://www.instagram.com/tinysoho/`.

Record the results in `docs/meta-verification/2026-10-13-link-guide-capability-results.json`:

```json
{
  "schemaVersion": 1,
  "run": { "graphVersion": "v21.0", "reviewedBy": "<owner>", "reviewedAt": "<ISO time>" },
  "cases": [
    { "case": "private_link_card", "decision": "supported | unsupported | not_verified", "sanitizedResult": {}, "mobileTapFromRequests": "pass | fail | not_verified", "notes": [] },
    { "case": "private_link_text", "decision": "supported | unsupported | not_verified", "sanitizedResult": {}, "mobileTapFromRequests": "pass | fail | not_verified", "notes": [] }
  ]
}
```

`sanitizedResult` is the JSON the command printed. A case is `supported` only when Meta accepted it AND the phone tap from Message Requests passed.
````

- [ ] **Step 7: Commit**

```bash
git add src/meta/linkGuideCapabilitySpike.ts src/meta/linkGuideCapabilitySpike.test.ts scripts/link-guide-capability-spike.ts package.json docs/meta-guide-gate-capability-runbook.md
git commit -m "feat: add link guide launch-test harness"
```

- [ ] **Step 8: STOP. The owner runs the launch test.**

This step is not for an agent. It sends real Instagram messages, so it needs the owner's sign-off and their controlled accounts. Report to the owner:

> "Tasks 1–3 are done. Please run the two link-guide cases from `docs/meta-guide-gate-capability-runbook.md` (section 'Link guide cases'), check the tap on a phone, and record the result. I'll continue with Task 4 once you tell me which cases are `supported`."

Continue only on the owner's answer, using the table in "Order and the launch gate".

---
### Task 4: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261013010000_add_link_guides/migration.sql`
- Test: `src/services/linkGuideSchema.test.ts` (no database needed)
- Test: `src/services/linkGuideMigrationContract.test.ts` (real Postgres)

**Interfaces:**
- Produces:
  - Prisma enums: `GuideDeliveryMode`, `GuideLinkChannel`, `GuideLinkShape`, `GuideLinkSendStatus`.
  - Prisma models: `GuideLinkSend`, `GuideLinkClick`.
  - On `Resource`: `deliveryMode`, `linkUrl`, `linkButtonLabel`, `linkCardTitle`, `linkCardSubtitle`.
  - New `ConversationState` value `link_sent`.

- [ ] **Step 1: Write the failing schema test**

```ts
// src/services/linkGuideSchema.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");

function block(name: string): string {
  return schema.match(new RegExp(`(?:model|enum) ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
}

describe("link guide schema", () => {
  it("defaults every guide to gated", () => {
    expect(block("Resource")).toMatch(
      /deliveryMode\s+GuideDeliveryMode\s+@default\(gated\)\s+@map\("delivery_mode"\)/,
    );
  });

  it("keeps the button label within Meta's 20 characters", () => {
    expect(block("Resource")).toMatch(
      /linkButtonLabel\s+String\?\s+@map\("link_button_label"\)\s+@db\.VarChar\(20\)/,
    );
  });

  it("adds link_sent as the last conversation state", () => {
    expect(block("ConversationState")).toMatch(/expired\s+link_sent\s+@@map/);
  });

  it("makes the click token unique", () => {
    expect(block("GuideLinkSend")).toMatch(/token\s+String\s+@unique\s+@db\.VarChar\(16\)/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/services/linkGuideSchema.test.ts`
Expected: FAIL, the patterns don't match.

- [ ] **Step 3: Edit `prisma/schema.prisma`**

(a) In `model Resource`, add these fields after `createdAt    DateTime @default(now()) @map("created_at")`:

```prisma
  // How a comment on this guide's posts is answered. `gated` is the follow-gated guide
  // (every guide before link guides existed); `link` sends one DM with a button to
  // linkUrl and never checks follow. See docs/superpowers/specs/2026-10-12-link-guide-delivery-design.md.
  deliveryMode     GuideDeliveryMode @default(gated) @map("delivery_mode")
  linkUrl          String?           @map("link_url")
  linkButtonLabel  String?           @map("link_button_label") @db.VarChar(20)
  linkCardTitle    String?           @map("link_card_title") @db.VarChar(80)
  linkCardSubtitle String?           @map("link_card_subtitle") @db.VarChar(80)
```

In the same model's relation list (after `guideAccessAttempts GuideAccessAttempt[]`), add:

```prisma
  guideLinkSends      GuideLinkSend[]
```

(b) Change `enum ConversationState` to:

```prisma
enum ConversationState {
  awaiting_done
  completed
  expired
  // A link guide's DM is on its way or sent. Never an open guide request, so a reply can
  // never reach the follow gate. A first human tap on the link moves it to completed.
  link_sent

  @@map("conversation_state")
}
```

(c) In `model Conversation`'s relation list (after `guideAccessAttempts GuideAccessAttempt[]`), add `guideLinkSends      GuideLinkSend[]`.

(d) In `model Keyword`'s relation list, add `guideLinkSends GuideLinkSend[]`.

(e) Append the new enums and models at the end of the file:

```prisma
enum GuideDeliveryMode {
  gated
  link

  @@map("guide_delivery_mode")
}

enum GuideLinkChannel {
  private_reply
  dm

  @@map("guide_link_channel")
}

enum GuideLinkShape {
  card
  text

  @@map("guide_link_shape")
}

enum GuideLinkSendStatus {
  pending
  sent
  failed

  @@map("guide_link_send_status")
}

/// One link-guide DM attempt. Its token is the only thing in the /r/<token> URL.
model GuideLinkSend {
  id                String              @id @default(uuid()) @db.Uuid
  token             String              @unique @db.VarChar(16)
  conversationId    String              @map("conversation_id") @db.Uuid
  resourceId        String              @map("resource_id") @db.Uuid
  keywordId         String              @map("keyword_id") @db.Uuid
  mediaId           String?             @map("media_id")
  igUserId          String              @map("ig_user_id")
  channel           GuideLinkChannel
  shape             GuideLinkShape
  status            GuideLinkSendStatus @default(pending)
  providerMessageId String?             @map("provider_message_id")
  createdAt         DateTime            @default(now()) @map("created_at") @db.Timestamptz(3)
  sentAt            DateTime?           @map("sent_at") @db.Timestamptz(3)

  conversation Conversation     @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  resource     Resource         @relation(fields: [resourceId], references: [id], onDelete: Restrict)
  keyword      Keyword          @relation(fields: [keywordId], references: [id], onDelete: Cascade)
  clicks       GuideLinkClick[]

  @@index([conversationId])
  @@index([resourceId])
  @@index([keywordId])
  @@index([mediaId, createdAt])
  @@map("guide_link_send")
}

/// One hit on /r/<token>. Capped per send; bots are recorded but never count as a tap.
model GuideLinkClick {
  id             String   @id @default(uuid()) @db.Uuid
  sendId         String   @map("send_id") @db.Uuid
  clickedAt      DateTime @default(now()) @map("clicked_at") @db.Timestamptz(3)
  destinationUrl String   @map("destination_url")
  isBot          Boolean  @map("is_bot")
  uaFamily       String   @map("ua_family") @db.VarChar(32)

  send GuideLinkSend @relation(fields: [sendId], references: [id], onDelete: Cascade)

  @@index([sendId, isBot])
  @@map("guide_link_click")
}
```

- [ ] **Step 4: Write the migration**

```sql
-- prisma/migrations/20261013010000_add_link_guides/migration.sql
-- Link guides: a guide can send one DM with a button to a page on our site instead of
-- running the follow gate. Additive only: every existing guide becomes `gated`, which is
-- exactly how it behaves today.

-- ALTER TYPE ... ADD VALUE stays outside the transaction below, matching
-- 20260927010000_guide_audience_decision_origin. Nothing in this file uses the new value.
ALTER TYPE "conversation_state" ADD VALUE IF NOT EXISTS 'link_sent';

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TYPE "guide_delivery_mode" AS ENUM ('gated', 'link');
CREATE TYPE "guide_link_channel" AS ENUM ('private_reply', 'dm');
CREATE TYPE "guide_link_shape" AS ENUM ('card', 'text');
CREATE TYPE "guide_link_send_status" AS ENUM ('pending', 'sent', 'failed');

ALTER TABLE "resources"
  ADD COLUMN "delivery_mode" "guide_delivery_mode" NOT NULL DEFAULT 'gated',
  ADD COLUMN "link_url" TEXT,
  ADD COLUMN "link_button_label" VARCHAR(20),
  ADD COLUMN "link_card_title" VARCHAR(80),
  ADD COLUMN "link_card_subtitle" VARCHAR(80);

CREATE TABLE "guide_link_send" (
    "id" UUID NOT NULL,
    "token" VARCHAR(16) NOT NULL,
    "conversation_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "keyword_id" UUID NOT NULL,
    "media_id" TEXT,
    "ig_user_id" TEXT NOT NULL,
    "channel" "guide_link_channel" NOT NULL,
    "shape" "guide_link_shape" NOT NULL,
    "status" "guide_link_send_status" NOT NULL DEFAULT 'pending',
    "provider_message_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "guide_link_send_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "guide_link_send_token_key" ON "guide_link_send"("token");
CREATE INDEX "guide_link_send_conversation_id_idx" ON "guide_link_send"("conversation_id");
CREATE INDEX "guide_link_send_resource_id_idx" ON "guide_link_send"("resource_id");
CREATE INDEX "guide_link_send_keyword_id_idx" ON "guide_link_send"("keyword_id");
CREATE INDEX "guide_link_send_media_id_created_at_idx" ON "guide_link_send"("media_id", "created_at");

CREATE TABLE "guide_link_click" (
    "id" UUID NOT NULL,
    "send_id" UUID NOT NULL,
    "clicked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "destination_url" TEXT NOT NULL,
    "is_bot" BOOLEAN NOT NULL,
    "ua_family" VARCHAR(32) NOT NULL,

    CONSTRAINT "guide_link_click_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "guide_link_click_send_id_is_bot_idx" ON "guide_link_click"("send_id", "is_bot");

ALTER TABLE "guide_link_send"
    ADD CONSTRAINT "guide_link_send_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guide_link_send"
    ADD CONSTRAINT "guide_link_send_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "resources"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "guide_link_send"
    ADD CONSTRAINT "guide_link_send_keyword_id_fkey"
    FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guide_link_click"
    ADD CONSTRAINT "guide_link_click_send_id_fkey"
    FOREIGN KEY ("send_id") REFERENCES "guide_link_send"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "guide_link_send" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guide_link_click" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "guide_link_send" FROM anon;
    REVOKE ALL ON TABLE "guide_link_click" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "guide_link_send" FROM authenticated;
    REVOKE ALL ON TABLE "guide_link_click" FROM authenticated;
  END IF;
END
$$;

COMMIT;
```

- [ ] **Step 5: Write the migration contract test**

```ts
// src/services/linkGuideMigrationContract.test.ts
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithLocalDatabase = databaseUrl ? describe.sequential : describe.skip;

let db: PrismaClient;

beforeAll(() => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  if (db) await db.$disconnect();
});

describeWithLocalDatabase("link guide migration contract", () => {
  it("defaults existing and new guides to gated", async () => {
    const rows = await db.$queryRaw<Array<{ column_default: string | null; is_nullable: string }>>`
      SELECT column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'resources' AND column_name = 'delivery_mode'
    `;
    expect(rows).toEqual([{ column_default: "'gated'::guide_delivery_mode", is_nullable: "NO" }]);
  });

  it("appends link_sent to the conversation states", async () => {
    const rows = await db.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e.enumlabel
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'conversation_state'
      ORDER BY e.enumsortorder
    `;
    expect(rows.map((row) => row.enumlabel)).toEqual(["awaiting_done", "completed", "expired", "link_sent"]);
  });

  it("enables row level security on both new tables", async () => {
    const rows = await db.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relname IN ('guide_link_send', 'guide_link_click')
      ORDER BY relname
    `;
    expect(rows).toEqual([
      { relname: "guide_link_click", relrowsecurity: true },
      { relname: "guide_link_send", relrowsecurity: true },
    ]);
  });
});
```

- [ ] **Step 6: Validate, generate the client, and run the tests**

```bash
npx prisma validate
```

```bash
npx prisma generate
```

```bash
npx vitest run src/services/linkGuideSchema.test.ts
```

Expected: all PASS.

```bash
MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract npx vitest run src/services/linkGuideMigrationContract.test.ts
```

Expected: PASS. Vitest's global setup applies the migration first.

Confirm the hand-written SQL matches the Prisma schema. This is a read-only diff of the migrated contract DB:

```bash
npx prisma migrate diff --from-url postgresql://postgres:disposable@127.0.0.1:5433/contract --to-schema-datamodel prisma/schema.prisma --script
```

Expected: `-- This is an empty migration.` If the output shows statements, fix the SQL (not the schema) until it is empty.

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261013010000_add_link_guides src/services/linkGuideSchema.test.ts src/services/linkGuideMigrationContract.test.ts
git commit -m "feat: add link guide schema and migration"
```

---

### Task 5: Configuration and switches

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/flagRegistry.ts`
- Modify: `src/config/experimentRegistry.test.ts`
- Modify: `.env.example`
- Test: `src/config/env.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_LINK_GUIDE_ALLOWED_HOSTS` from Task 1.
- Produces:
  - `env.LINK_GUIDE_ENABLED`
  - `env.LINK_GUIDE_CARD_ENABLED`
  - `env.LINK_GUIDE_ALLOWED_HOSTS: string`
  - `env.LINK_GUIDE_REDIRECT_BASE_URL: string | undefined`
  - Registry keys `LINK_GUIDE_ENABLED` and `LINK_GUIDE_CARD_ENABLED`, readable through `flags.bool`.

- [ ] **Step 1: Write the failing tests**

Append to `src/config/env.test.ts`. It already defines `baseEnv` and imports `envSchema`:

```ts
describe("env configuration schema for link guides", () => {
  it("keeps link guides off and points them at our own site by default", () => {
    const parsed = envSchema.parse(baseEnv);
    expect(parsed.LINK_GUIDE_ENABLED).toBe(false);
    expect(parsed.LINK_GUIDE_CARD_ENABLED).toBe(false);
    expect(parsed.LINK_GUIDE_ALLOWED_HOSTS).toBe("mycuratedhaven.com,www.mycuratedhaven.com");
    expect(parsed.LINK_GUIDE_REDIRECT_BASE_URL).toBeUndefined();
  });

  it('parses LINK_GUIDE_ENABLED="false" as off', () => {
    expect(envSchema.parse({ ...baseEnv, LINK_GUIDE_ENABLED: "false" }).LINK_GUIDE_ENABLED).toBe(false);
  });

  it("refuses to turn link guides on without a redirect origin", () => {
    expect(envSchema.safeParse({ ...baseEnv, LINK_GUIDE_ENABLED: "true" }).success).toBe(false);
  });

  it("requires the redirect origin to be https", () => {
    expect(
      envSchema.safeParse({
        ...baseEnv,
        LINK_GUIDE_ENABLED: "true",
        LINK_GUIDE_REDIRECT_BASE_URL: "http://api.example.com",
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...baseEnv,
        LINK_GUIDE_ENABLED: "true",
        LINK_GUIDE_REDIRECT_BASE_URL: "https://api.example.com",
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL. The keys are undefined and the "on without origin" case parses successfully.

- [ ] **Step 3: Edit `src/config/env.ts`**

Add an import near the other imports at the top:

```ts
import { DEFAULT_LINK_GUIDE_ALLOWED_HOSTS } from "../services/linkGuidePolicy.js";
```

Directly after the line `  GUIDE_COVER_DELIVERY_ROLLOUT_PERCENT: z.coerce.number().int().min(0).max(100).default(0),`, add:

```ts
  // Link guides: one DM with a button to a page on our site, no follow gate. Both
  // switches default off. The card shape stays off until the launch test marks the
  // private-reply card `supported`; with it off, link guides send text with the link.
  LINK_GUIDE_ENABLED: booleanFlag(false),
  LINK_GUIDE_CARD_ENABLED: booleanFlag(false),
  LINK_GUIDE_ALLOWED_HOSTS: z.string().default(DEFAULT_LINK_GUIDE_ALLOWED_HOSTS),
  // Public https origin the tracked /r/<token> links point at: the Railway API domain,
  // or go.mycuratedhaven.com once that DNS record exists. Empty counts as unset, so the
  // blank line in .env.example parses.
  LINK_GUIDE_REDIRECT_BASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
```

In the `.superRefine((value, ctx) => { ... })` block, directly before its closing `});`, add:

```ts
  if (value.LINK_GUIDE_REDIRECT_BASE_URL && !value.LINK_GUIDE_REDIRECT_BASE_URL.startsWith("https://")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["LINK_GUIDE_REDIRECT_BASE_URL"],
      message: "LINK_GUIDE_REDIRECT_BASE_URL must be an https origin",
    });
  }
  if (value.LINK_GUIDE_ENABLED && !value.LINK_GUIDE_REDIRECT_BASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["LINK_GUIDE_ENABLED"],
      message: "LINK_GUIDE_ENABLED requires LINK_GUIDE_REDIRECT_BASE_URL",
    });
  }
```

- [ ] **Step 4: Register the flags**

In `src/config/flagRegistry.ts`, add these two entries as the last elements of `FLAG_REGISTRY`, directly before `] as const;`. The prose must not contain code identifiers; the registry test rejects `[A-Z]{2,}_[A-Z]`.

```ts
  {
    key: "LINK_GUIDE_ENABLED",
    name: "Link guides",
    group: "outbound",
    kind: "boolean",
    doesWhat:
      "Lets a guide set to Link answer a comment with one message holding a button to a page on our site, instead of asking the person to follow first.",
    affectsWho:
      "People who comment or message a keyword whose guide is set to Link. Guides set to Gated are not affected.",
    ifOff:
      "Posts that use a link guide get no public reply and no message, so nobody is promised a message that never comes. Gated guides keep working as before.",
    pageMayEnable: false,
    pageMayStop: true,
  },
  {
    key: "LINK_GUIDE_CARD_ENABLED",
    name: "Link guide as a card",
    group: "outbound",
    kind: "boolean",
    doesWhat:
      "Sends a link guide as a card with the guide's cover image and an open button, instead of a plain message with the link in it.",
    affectsWho: "People who get a link guide whose guide has a published square cover.",
    ifOff:
      "Link guides are sent as a plain message with the link. The link and the click tracking work the same way.",
    pageMayEnable: false,
    pageMayStop: true,
  },
```

In `src/config/experimentRegistry.test.ts`, the test "leaves exactly the flags with no declared comparison standing alone" holds an exact ordered list. Add the two keys after `"WORKERS_ENABLED",`:

```ts
      "LINK_GUIDE_ENABLED",
      "LINK_GUIDE_CARD_ENABLED",
```

- [ ] **Step 5: Document the variables in `.env.example`**

Append:

```
# Link guides: a guide set to Link answers a comment with one DM holding a button to our
# site, no follow gate. Keep both off until the launch test and the redirect origin are ready.
LINK_GUIDE_ENABLED=false
LINK_GUIDE_CARD_ENABLED=false
LINK_GUIDE_ALLOWED_HOSTS=mycuratedhaven.com,www.mycuratedhaven.com
# Required while LINK_GUIDE_ENABLED=true. The public https origin of this API.
LINK_GUIDE_REDIRECT_BASE_URL=
```

The empty `LINK_GUIDE_REDIRECT_BASE_URL=` line must parse as unset, which is why Step 3 wraps the declaration in `z.preprocess`. Add a test for that case to the Step 1 describe block:

```ts
  it("treats an empty redirect origin as unset", () => {
    expect(envSchema.parse({ ...baseEnv, LINK_GUIDE_REDIRECT_BASE_URL: "" }).LINK_GUIDE_REDIRECT_BASE_URL).toBeUndefined();
  });
```

- [ ] **Step 6: Run the config tests**

```bash
npx vitest run src/config
```

Expected: PASS. This covers `env.test.ts`, `flagRegistry.test.ts`, `flagCallSites.test.ts`, `experimentRegistry.test.ts` and `booleanFlag.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts src/config/flagRegistry.ts src/config/experimentRegistry.test.ts .env.example
git commit -m "feat: add link guide switches and config"
```

---
### Task 6: Link guide repository

**Files:**
- Create: `src/services/linkGuideRepository.ts`
- Test: `src/services/linkGuideRepositoryContract.test.ts` (real Postgres)

**Interfaces:**
- Consumes: Task 4's Prisma models and `MAX_RECORDED_CLICKS_PER_SEND` from Task 1.
- Produces:
  - `createLinkGuideRepository(db: PrismaClient | Prisma.TransactionClient)`
  - `LinkGuideRepository`, which has:
    - `createSend({ token, conversationId, resourceId, keywordId, mediaId, igUserId, channel, shape }): Promise<{ id: string }>`
    - `markSendSent(id, providerMessageId: string | null, sentAt: Date): Promise<void>`
    - `markSendFailed(id): Promise<void>`
    - `markLatestFailedSendSent(conversationId, providerMessageId, sentAt): Promise<boolean>`
    - `findForRedirect(token): Promise<RedirectSend | null>`
    - `recordClick({ sendId, destinationUrl, isBot, uaFamily, clickedAt }): Promise<{ recorded: boolean; firstHumanClick: boolean }>`
  - `RedirectSend = { id; conversationId; mediaId: string | null; conversationState: string; resource: { name: string; linkUrl: string | null } }`

- [ ] **Step 1: Write the failing contract test**

```ts
// src/services/linkGuideRepositoryContract.test.ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLinkGuideRepository, type LinkGuideRepository } from "./linkGuideRepository.js";
import { MAX_RECORDED_CLICKS_PER_SEND } from "./linkGuidePolicy.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID().slice(0, 8).toUpperCase();
const ids = { resource: randomUUID(), keyword: randomUUID(), conversation: randomUUID() };
let db: PrismaClient;
let repository: LinkGuideRepository;

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  repository = createLinkGuideRepository(db);
  await db.resource.create({
    data: {
      id: ids.resource,
      name: `Repo link ${suffix}`,
      deliveryMode: "link",
      linkUrl: "https://mycuratedhaven.com/halloween",
      linkButtonLabel: "Open the recipes",
    },
  });
  await db.keyword.create({
    data: {
      id: ids.keyword,
      keyword: `RPO${suffix}`,
      resourceId: ids.resource,
      publicReply: "x",
      gateMessage: "x",
      mediaId: `reel-${suffix}`,
    },
  });
  await db.conversation.create({
    data: { id: ids.conversation, igUserId: `ig-${suffix}`, keywordId: ids.keyword, state: "link_sent" },
  });
});

afterAll(async () => {
  if (!databaseUrl) return;
  await db.conversation.deleteMany({ where: { keywordId: ids.keyword } });
  await db.keyword.deleteMany({ where: { id: ids.keyword } });
  await db.resource.deleteMany({ where: { id: ids.resource } });
  await db.$disconnect();
});

function newSend(token: string) {
  return repository.createSend({
    token,
    conversationId: ids.conversation,
    resourceId: ids.resource,
    keywordId: ids.keyword,
    mediaId: `reel-${suffix}`,
    igUserId: `ig-${suffix}`,
    channel: "private_reply",
    shape: "card",
  });
}

describeWithDatabase("link guide repository", () => {
  it("finds a send by token with the guide's current link and the conversation state", async () => {
    const token = `a${suffix}AB`;
    const send = await newSend(token);
    await repository.markSendSent(send.id, "mid-1", new Date());

    await expect(repository.findForRedirect(token)).resolves.toEqual({
      id: send.id,
      conversationId: ids.conversation,
      mediaId: `reel-${suffix}`,
      conversationState: "link_sent",
      resource: { name: `Repo link ${suffix}`, linkUrl: "https://mycuratedhaven.com/halloween" },
    });
    await expect(repository.findForRedirect("zzzzzzzzzzz")).resolves.toBeNull();
  });

  it("reports only the first human click as first, whatever bots did before", async () => {
    const send = await newSend(`b${suffix}AB`);
    const base = { sendId: send.id, destinationUrl: "https://mycuratedhaven.com/halloween", clickedAt: new Date() };

    await expect(repository.recordClick({ ...base, isBot: true, uaFamily: "meta_preview" })).resolves.toEqual({
      recorded: true,
      firstHumanClick: false,
    });
    await expect(repository.recordClick({ ...base, isBot: false, uaFamily: "instagram_app" })).resolves.toEqual({
      recorded: true,
      firstHumanClick: true,
    });
    await expect(repository.recordClick({ ...base, isBot: false, uaFamily: "instagram_app" })).resolves.toEqual({
      recorded: true,
      firstHumanClick: false,
    });
  });

  it("stops recording at the per-send cap without throwing", async () => {
    const send = await newSend(`c${suffix}AB`);
    const click = {
      sendId: send.id,
      destinationUrl: "https://mycuratedhaven.com/halloween",
      clickedAt: new Date(),
      isBot: true,
      uaFamily: "bot",
    };
    for (let i = 0; i < MAX_RECORDED_CLICKS_PER_SEND; i++) await repository.recordClick(click);

    await expect(repository.recordClick(click)).resolves.toEqual({ recorded: false, firstHumanClick: false });
    await expect(db.guideLinkClick.count({ where: { sendId: send.id } })).resolves.toBe(
      MAX_RECORDED_CLICKS_PER_SEND,
    );
  });

  it("marks the latest failed send as sent when its text retry lands", async () => {
    const send = await newSend(`d${suffix}AB`);
    await repository.markSendFailed(send.id);

    await expect(repository.markLatestFailedSendSent(ids.conversation, "mid-retry", new Date())).resolves.toBe(true);
    await expect(db.guideLinkSend.findUniqueOrThrow({ where: { id: send.id } })).resolves.toMatchObject({
      status: "sent",
      shape: "text",
      providerMessageId: "mid-retry",
    });
    await expect(repository.markLatestFailedSendSent(ids.conversation, "mid-x", new Date())).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract npx vitest run src/services/linkGuideRepositoryContract.test.ts
```

Expected: FAIL, the import cannot be resolved.

- [ ] **Step 3: Write the repository**

```ts
// src/services/linkGuideRepository.ts
import type { GuideLinkChannel, GuideLinkShape, Prisma, PrismaClient } from "@prisma/client";
import { MAX_RECORDED_CLICKS_PER_SEND } from "./linkGuidePolicy.js";

type LinkGuideDatabase = PrismaClient | Prisma.TransactionClient;

export type RedirectSend = {
  id: string;
  conversationId: string;
  mediaId: string | null;
  conversationState: string;
  resource: { name: string; linkUrl: string | null };
};

/**
 * Reads and writes for link-guide sends and clicks. Takes the client as an argument so
 * the contract test can point it at the disposable database. The production instance
 * lives in linkGuideFlow.ts, the only file that imports the app's prisma singleton.
 */
export function createLinkGuideRepository(db: LinkGuideDatabase) {
  return {
    async createSend(input: {
      token: string;
      conversationId: string;
      resourceId: string;
      keywordId: string;
      mediaId: string | null;
      igUserId: string;
      channel: GuideLinkChannel;
      shape: GuideLinkShape;
    }): Promise<{ id: string }> {
      return db.guideLinkSend.create({ data: input, select: { id: true } });
    },

    async markSendSent(id: string, providerMessageId: string | null, sentAt: Date): Promise<void> {
      await db.guideLinkSend.update({ where: { id }, data: { status: "sent", providerMessageId, sentAt } });
    },

    async markSendFailed(id: string): Promise<void> {
      await db.guideLinkSend.update({ where: { id }, data: { status: "failed" } });
    },

    /**
     * A failed link DM is retried by the gate queue as text carrying the SAME token, so
     * the retry completes the send it retried rather than creating a second one.
     */
    async markLatestFailedSendSent(
      conversationId: string,
      providerMessageId: string | null,
      sentAt: Date,
    ): Promise<boolean> {
      const latest = await db.guideLinkSend.findFirst({
        where: { conversationId, status: "failed" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (!latest) return false;
      await db.guideLinkSend.update({
        where: { id: latest.id },
        data: { status: "sent", shape: "text", providerMessageId, sentAt },
      });
      return true;
    },

    async findForRedirect(token: string): Promise<RedirectSend | null> {
      const row = await db.guideLinkSend.findUnique({
        where: { token },
        select: {
          id: true,
          conversationId: true,
          mediaId: true,
          conversation: { select: { state: true } },
          resource: { select: { name: true, linkUrl: true } },
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        conversationId: row.conversationId,
        mediaId: row.mediaId,
        conversationState: row.conversation.state,
        resource: row.resource,
      };
    },

    async recordClick(input: {
      sendId: string;
      destinationUrl: string;
      isBot: boolean;
      uaFamily: string;
      clickedAt: Date;
    }): Promise<{ recorded: boolean; firstHumanClick: boolean }> {
      const existing = await db.guideLinkClick.count({ where: { sendId: input.sendId } });
      if (existing >= MAX_RECORDED_CLICKS_PER_SEND) return { recorded: false, firstHumanClick: false };
      const priorHumanClicks = input.isBot
        ? 0
        : await db.guideLinkClick.count({ where: { sendId: input.sendId, isBot: false } });
      await db.guideLinkClick.create({ data: input });
      return { recorded: true, firstHumanClick: !input.isBot && priorHumanClicks === 0 };
    },
  };
}

export type LinkGuideRepository = ReturnType<typeof createLinkGuideRepository>;
```

- [ ] **Step 4: Run the contract test and confirm it passes**

Run the Step 2 command again. Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/linkGuideRepository.ts src/services/linkGuideRepositoryContract.test.ts
git commit -m "feat: add link guide send and click repository"
```

---

### Task 7: `markLinkSent` and link wording for the 2-hour reminder

**Files:**
- Modify: `src/services/conversationService.ts`
- Modify: `src/services/dmRecoveryPolicy.ts`
- Modify: `src/services/dmRecoveryService.ts`
- Test: `src/services/dmRecoveryPolicy.test.ts`
- Test: `src/services/linkGuideRepositoryContract.test.ts` (one more case)

**Interfaces:**
- Produces:
  - `markLinkSent(conversationId: string): Promise<void>`
  - `renderRecoveryCopy(trigger, keywordSnapshot, handle?, openingOnly = false, opening: "guide" | "link" = "guide")`
  - A new optional field on `AcceptedGateRecoveryInput`: `openingKind?: "guide" | "link"`

- [ ] **Step 1: Write the failing tests**

Add inside `describe("renderRecoveryCopy", ...)` in `src/services/dmRecoveryPolicy.test.ts`:

```ts
    it("tells a link-guide parent we sent the link, not a guide", () => {
      expect(renderRecoveryCopy("no_confirmed_read", "GHOST", null, true, "link")).toBe(
        "I sent you the link 💛 Instagram may have tucked it into your Message Requests, so check there. Still nothing? DM @tinysoho “GHOST” and I’ll resend.",
      );
    });

    it("keeps the settings-blocked copy for link guides", () => {
      expect(renderRecoveryCopy("settings_blocked", "GHOST", null, true, "link")).toBe(
        renderRecoveryCopy("settings_blocked", "GHOST"),
      );
    });
```

Add inside `describeWithDatabase(...)` in `src/services/linkGuideRepositoryContract.test.ts`:

```ts
  it("moves an awaiting_done conversation to link_sent and leaves a completed one alone", async () => {
    const { markLinkSent } = await import("./conversationService.js");
    const awaiting = await db.conversation.create({
      data: { igUserId: `ig-${suffix}-w`, keywordId: ids.keyword, state: "awaiting_done" },
    });
    const done = await db.conversation.create({
      data: { igUserId: `ig-${suffix}-d`, keywordId: ids.keyword, state: "completed" },
    });

    await markLinkSent(awaiting.id);
    await markLinkSent(done.id);

    await expect(db.conversation.findUniqueOrThrow({ where: { id: awaiting.id } })).resolves.toMatchObject({
      state: "link_sent",
    });
    await expect(db.conversation.findUniqueOrThrow({ where: { id: done.id } })).resolves.toMatchObject({
      state: "completed",
    });
  });
```

The dynamic import keeps `conversationService` (which loads the app's env and Prisma client) out of plain unit runs, where this suite is skipped.

- [ ] **Step 2: Run them and confirm they fail**

```bash
npx vitest run src/services/dmRecoveryPolicy.test.ts
```

Expected: FAIL. The copy still says "I sent you a DM".

- [ ] **Step 3: Implement**

In `src/services/dmRecoveryPolicy.ts`, change `renderRecoveryCopy` to:

```ts
export function renderRecoveryCopy(
  trigger: "no_confirmed_read" | "settings_blocked",
  keywordSnapshot: string,
  handle?: string | null,
  openingOnly = false,
  opening: "guide" | "link" = "guide",
): string {
  let keyword: string;
  try {
    keyword = normalizeRecoveryKeyword(keywordSnapshot);
  } catch {
    throw new Error("invalid_keyword_snapshot: Snapshot must be a non-empty string");
  }

  const mentioned = normalizeRecoveryHandle(handle);
  const mention = mentioned ? `@${mentioned} ` : "";
  // A link guide's only DM is the link itself, so "your guide" would be untrue.
  const sent = opening === "link" ? "I sent you the link" : openingOnly ? "I sent you a DM" : "I sent your guide";

  return trigger === "settings_blocked"
    ? `${mention}I couldn’t send your DM 💛 Your message-request settings blocked it. DM @tinysoho “${keyword}”.`
    : `${mention}${sent} 💛 Instagram may have tucked it into your Message Requests, so check there. Still nothing? DM @tinysoho “${keyword}” and I’ll resend.`;
}
```

In `src/services/dmRecoveryService.ts`, add this field to `AcceptedGateRecoveryInput`, after `acceptedAt: Date;`:

```ts
  /** What the opening DM was. Only changes the reminder wording. Absent means a guide. */
  openingKind?: "guide" | "link";
```

and change the `renderRecoveryCopy` call inside `scheduleAcceptedGateRecovery` to:

```ts
  const publicReplyText = renderRecoveryCopy(
    "no_confirmed_read",
    input.keywordSnapshot,
    audience.handle,
    twoHourAll,
    input.openingKind ?? "guide",
  );
```

In `src/services/conversationService.ts`, add after `markGated`:

```ts
/**
 * A link guide's conversation leaves awaiting_done as soon as its link is on the way, so
 * a reply to the link DM can never be read as the answer to an open guide request (the
 * follow gate). Moves only a conversation that is still awaiting_done: a completed one
 * stays completed, which keeps a repeat DM from undoing a recorded tap.
 */
export async function markLinkSent(conversationId: string): Promise<void> {
  await prisma.conversation.updateMany({
    where: { id: conversationId, state: "awaiting_done" },
    data: { state: "link_sent", gatedAt: new Date() },
  });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run src/services/dmRecoveryPolicy.test.ts src/services/dmRecoveryService.test.ts src/services/conversationService.test.ts
```

Expected: PASS. Existing callers pass no `opening`, so their copy is unchanged.

```bash
MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract npx vitest run src/services/linkGuideRepositoryContract.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/conversationService.ts src/services/dmRecoveryPolicy.ts src/services/dmRecoveryPolicy.test.ts src/services/dmRecoveryService.ts src/services/linkGuideRepositoryContract.test.ts
git commit -m "feat: add link_sent transition and link reminder wording"
```

---
### Task 8: Link guide send flow

**Files:**
- Create: `src/services/linkGuideFlowCore.ts` (unit-tested, dependencies injected)
- Create: `src/services/linkGuideFlow.ts` (wires the core to real modules)
- Test: `src/services/linkGuideFlowCore.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 1–2: policy and payloads.
  - Task 6: `LinkGuideRepository`.
  - Task 7: `markLinkSent`, `AcceptedGateRecoveryInput.openingKind`.
  - Existing modules:
    - `sendTrackedPrivateCard`, `sendTrackedPrivateReply`, `sendTrackedText` (`src/services/dmDeliveryService.ts`)
    - `sendMetaMessage` (`src/meta/sendMessage.ts`)
    - `loadGateCard` (`src/services/guideGateCard.ts`)
    - `markThreadResolved` (`src/services/dmThreadService.ts`)
    - `scheduleAcceptedGateRecovery` (`src/services/dmRecoveryService.ts`)
    - `logEvent`, `describeGraphError` (`src/services/eventLogger.ts`)
    - `GUIDE_PROFILE_URL` (`src/meta/sendGuideAction.ts`)
    - `flags` (`src/services/flagService.ts`)
- Produces (other tasks use these exact names):
  - `createLinkGuideFlow(deps: LinkGuideFlowDeps)` → `{ readiness, sendLinkGuide, runCommentLinkGuide, runDmLinkGuide }`
  - `readiness(resource: LinkGuideResource): "ready" | "disabled" | "misconfigured"`
  - `runCommentLinkGuide({ conversationId, keywordId, keywordSnapshot, commentId, mediaId, igUserId, resource }): Promise<LinkGuideRunResult>`
  - `runDmLinkGuide({ conversationId, keywordId, mediaId, igUserId, resource, threadId, inboundMessageId }): Promise<LinkGuideRunResult>`
  - `LinkGuideRunResult`, one of:
    - `{ outcome: "sent"; sendId; shape; receipt }`
    - `{ outcome: "failed"; sendId; shape; error; retryText }`
    - `{ outcome: "not_ready"; readiness }`
  - From `linkGuideFlow.ts`: `linkGuideFlow` (same four methods, built lazily on first call) and `linkGuideRepository` (the production repository instance).

- [ ] **Step 1: Write the failing test**

```ts
// src/services/linkGuideFlowCore.test.ts
import { describe, expect, it, vi } from "vitest";
import { createLinkGuideFlow, type LinkGuideFlowDeps } from "./linkGuideFlowCore.js";
import type { LinkGuideResource } from "./linkGuidePolicy.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const RECEIPT = { instagramMessageId: "mid-1", dmMessageId: "dm-1", acceptedAt: NOW };
const TRACKED = "https://api.example.com/r/tok_ABCDEFG";
const RESOURCE: LinkGuideResource = {
  id: "res-1",
  name: "Halloween collection",
  description: "8 toddler-friendly recipes",
  deliveryMode: "link",
  linkUrl: "https://mycuratedhaven.com/halloween",
  linkButtonLabel: "Open the recipes",
  linkCardTitle: "Your Halloween recipes 👻",
  linkCardSubtitle: null,
};
const COMMENT_INPUT = {
  conversationId: "convo-1",
  keywordId: "kw-1",
  keywordSnapshot: "GHOST",
  commentId: "comment-1",
  mediaId: "reel-9",
  igUserId: "ig-parent",
  resource: RESOURCE,
};
const DM_INPUT = {
  conversationId: "convo-1",
  keywordId: "kw-1",
  mediaId: "reel-9",
  igUserId: "ig-parent",
  resource: RESOURCE,
  threadId: "thread-1",
  inboundMessageId: "message-1",
};

function makeDeps(overrides: Partial<LinkGuideFlowDeps> = {}) {
  const deps = {
    repository: {
      createSend: vi.fn(async () => ({ id: "send-1" })),
      markSendSent: vi.fn(async () => undefined),
      markSendFailed: vi.fn(async () => undefined),
    },
    isEnabled: () => true,
    isCardEnabled: () => true,
    isTwoHourRecoveryEnabled: () => false,
    redirectBaseUrl: "https://api.example.com",
    allowedHosts: new Set(["mycuratedhaven.com"]),
    profileUrl: "https://www.instagram.com/tinysoho/",
    loadCover: vi.fn(async () => ({ coverUrl: "https://cdn.example.com/cover.png" })),
    sendMeta: vi.fn(async () => ({ messageId: "mid-dm" })),
    sendTrackedPrivateCard: vi.fn(async (input: { send: () => Promise<unknown> }) => {
      await input.send();
      return RECEIPT;
    }),
    sendTrackedPrivateReply: vi.fn(async () => RECEIPT),
    sendTrackedText: vi.fn(async () => ({ messageId: "mid-text" })),
    markLinkSent: vi.fn(async () => undefined),
    scheduleAcceptedGateRecovery: vi.fn(async () => ({ id: "rec-1" })),
    markThreadResolved: vi.fn(async () => undefined),
    logEvent: vi.fn(async () => undefined),
    describeError: () => ({ category: "unknown_error" }),
    newToken: () => "tok_ABCDEFG",
    now: () => NOW,
    ...overrides,
  };
  return deps as typeof deps & LinkGuideFlowDeps;
}

describe("readiness", () => {
  it("is ready only when switched on, configured, and the guide's link is valid", () => {
    expect(createLinkGuideFlow(makeDeps()).readiness(RESOURCE)).toBe("ready");
    expect(createLinkGuideFlow(makeDeps({ isEnabled: () => false })).readiness(RESOURCE)).toBe("disabled");
    expect(createLinkGuideFlow(makeDeps({ redirectBaseUrl: undefined })).readiness(RESOURCE)).toBe("misconfigured");
    expect(
      createLinkGuideFlow(makeDeps()).readiness({ ...RESOURCE, linkUrl: "https://evil.example/x" }),
    ).toBe("misconfigured");
    expect(createLinkGuideFlow(makeDeps()).readiness({ ...RESOURCE, deliveryMode: "gated" })).toBe("misconfigured");
  });
});

describe("runCommentLinkGuide", () => {
  it("moves the conversation to link_sent, then sends the card as the private reply", async () => {
    const deps = makeDeps();
    const result = await createLinkGuideFlow(deps).runCommentLinkGuide(COMMENT_INPUT);

    expect(result).toEqual({ outcome: "sent", sendId: "send-1", shape: "card", receipt: RECEIPT });
    expect(deps.markLinkSent).toHaveBeenCalledWith("convo-1");
    expect(deps.markLinkSent.mock.invocationCallOrder[0]).toBeLessThan(
      deps.repository.createSend.mock.invocationCallOrder[0]!,
    );
    expect(deps.repository.createSend).toHaveBeenCalledWith({
      token: "tok_ABCDEFG",
      conversationId: "convo-1",
      resourceId: "res-1",
      keywordId: "kw-1",
      mediaId: "reel-9",
      igUserId: "ig-parent",
      channel: "private_reply",
      shape: "card",
    });
    const [payload, metadata] = deps.sendMeta.mock.calls[0] as unknown as [
      { recipient: unknown; message: { attachment: { payload: { elements: Array<{ title: string; subtitle: string; buttons: Array<{ url: string; title: string }> }> } } } },
      { mode: string },
    ];
    expect(payload.recipient).toEqual({ comment_id: "comment-1" });
    const element = payload.message.attachment.payload.elements[0]!;
    expect(element.title).toBe("Your Halloween recipes 👻");
    expect(element.subtitle).toBe("8 toddler-friendly recipes");
    expect(element.buttons[0]).toEqual({ type: "web_url", url: TRACKED, title: "Open the recipes" });
    expect(metadata.mode).toBe("private_link_card");
    expect(deps.repository.markSendSent).toHaveBeenCalledWith("send-1", "mid-1", NOW);
    expect(deps.logEvent).toHaveBeenCalledWith("dm_sent", {
      conversationId: "convo-1",
      kind: "link",
      shape: "card",
      channel: "private_reply",
    });
  });

  it("sends text with the link when the card switch is off, without loading a cover", async () => {
    const deps = makeDeps({ isCardEnabled: () => false });
    const result = await createLinkGuideFlow(deps).runCommentLinkGuide(COMMENT_INPUT);

    expect(result).toMatchObject({ outcome: "sent", shape: "text" });
    expect(deps.loadCover).not.toHaveBeenCalled();
    expect(deps.sendTrackedPrivateReply).toHaveBeenCalledWith({
      recipientIgUserId: "ig-parent",
      commentId: "comment-1",
      text: `Your Halloween recipes 👻\n${TRACKED}`,
      source: "keyword_automation",
    });
  });

  it("sends text when the guide has no published square cover", async () => {
    const deps = makeDeps({ loadCover: vi.fn(async () => null) });
    await expect(createLinkGuideFlow(deps).runCommentLinkGuide(COMMENT_INPUT)).resolves.toMatchObject({
      shape: "text",
    });
    expect(deps.sendTrackedPrivateCard).not.toHaveBeenCalled();
  });

  it("returns the text-with-link retry when the send fails, and marks the send failed", async () => {
    const error = new Error("socket hang up");
    const deps = makeDeps({ sendTrackedPrivateCard: vi.fn(async () => { throw error; }) });
    const result = await createLinkGuideFlow(deps).runCommentLinkGuide(COMMENT_INPUT);

    expect(result).toEqual({
      outcome: "failed",
      sendId: "send-1",
      shape: "card",
      error,
      retryText: `Your Halloween recipes 👻\n${TRACKED}`,
    });
    expect(deps.repository.markSendFailed).toHaveBeenCalledWith("send-1");
    expect(deps.repository.markSendSent).not.toHaveBeenCalled();
  });

  it("never reports a delivered DM as failed when only the bookkeeping write fails", async () => {
    const deps = makeDeps();
    deps.repository.markSendSent.mockRejectedValueOnce(new Error("db down"));
    await expect(createLinkGuideFlow(deps).runCommentLinkGuide(COMMENT_INPUT)).resolves.toMatchObject({
      outcome: "sent",
    });
    expect(deps.logEvent).toHaveBeenCalledWith("link_send_record_failed", { conversationId: "convo-1" });
  });

  it("schedules the 2-hour reminder with link wording only when that switch is on", async () => {
    const off = makeDeps();
    await createLinkGuideFlow(off).runCommentLinkGuide(COMMENT_INPUT);
    expect(off.scheduleAcceptedGateRecovery).not.toHaveBeenCalled();

    const on = makeDeps({ isTwoHourRecoveryEnabled: () => true });
    await createLinkGuideFlow(on).runCommentLinkGuide(COMMENT_INPUT);
    expect(on.scheduleAcceptedGateRecovery).toHaveBeenCalledWith({
      conversationId: "convo-1",
      igUserId: "ig-parent",
      keywordId: "kw-1",
      keywordSnapshot: "GHOST",
      commentId: "comment-1",
      mediaId: "reel-9",
      gateDmMessageId: "dm-1",
      instagramGateMessageId: "mid-1",
      acceptedAt: NOW,
      openingKind: "link",
    });
  });

  it("does nothing but log when link guides are switched off", async () => {
    const deps = makeDeps({ isEnabled: () => false });
    await expect(createLinkGuideFlow(deps).runCommentLinkGuide(COMMENT_INPUT)).resolves.toEqual({
      outcome: "not_ready",
      readiness: "disabled",
    });
    expect(deps.markLinkSent).not.toHaveBeenCalled();
    expect(deps.repository.createSend).not.toHaveBeenCalled();
    expect(deps.logEvent).toHaveBeenCalledWith("link_guide_disabled", {
      conversationId: "convo-1",
      resourceId: "res-1",
      source: "comment",
    });
  });
});

describe("runDmLinkGuide", () => {
  it("sends the card into the open thread and resolves the thread", async () => {
    const deps = makeDeps();
    await expect(createLinkGuideFlow(deps).runDmLinkGuide(DM_INPUT)).resolves.toMatchObject({
      outcome: "sent",
      shape: "card",
      receipt: null,
    });
    const [payload, metadata] = deps.sendMeta.mock.calls[0] as unknown as [
      { recipient: unknown; messaging_type: string },
      { mode: string },
    ];
    expect(payload.recipient).toEqual({ id: "ig-parent" });
    expect(payload.messaging_type).toBe("RESPONSE");
    expect(metadata.mode).toBe("dm_link_card");
    expect(deps.repository.markSendSent).toHaveBeenCalledWith("send-1", "mid-dm", NOW);
    expect(deps.markThreadResolved).toHaveBeenCalledWith({ threadId: "thread-1", inboundMessageId: "message-1" });
  });

  it("logs a DM failure and leaves the thread for the owner", async () => {
    const deps = makeDeps({ sendMeta: vi.fn(async () => { throw new Error("socket hang up"); }) });
    await expect(createLinkGuideFlow(deps).runDmLinkGuide(DM_INPUT)).resolves.toMatchObject({ outcome: "failed" });
    expect(deps.markThreadResolved).not.toHaveBeenCalled();
    expect(deps.logEvent).toHaveBeenCalledWith("dm_failed", {
      conversationId: "convo-1",
      stage: "link_inbound_dm",
      category: "unknown_error",
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/services/linkGuideFlowCore.test.ts`
Expected: FAIL, the import cannot be resolved.

- [ ] **Step 3: Write `src/services/linkGuideFlowCore.ts`**

```ts
// src/services/linkGuideFlowCore.ts
import type { AcceptedGateRecoveryInput } from "./dmRecoveryService.js";
import type { TrackedPrivateReplyReceipt } from "./dmDeliveryService.js";
import type { LinkGuideRepository } from "./linkGuideRepository.js";
import type { MetaMessagePayload, SafeMetaMessageLog } from "../meta/sendMessage.js";
import type { MetaSendResult } from "../types/meta.js";
import { buildLinkGuideCardPayload, type LinkGuideRecipient } from "../meta/linkGuidePayloads.js";
import {
  codePoints,
  linkCardSubtitle,
  linkCardTitle,
  linkGuideText,
  trackedLinkUrl,
  validateLinkGuideFields,
  type LinkGuideResource,
} from "./linkGuidePolicy.js";

/**
 * Sending a link guide: one Meta message (card or text) whose button goes through our
 * /r/<token> redirect. No follow check, no guide_access_attempt, no delivery ledger.
 *
 * Every collaborator is injected as an arrow-typed property, so a missing one is a type
 * error rather than a silent default, and the whole flow is testable without Meta or a
 * database. linkGuideFlow.ts supplies the real ones.
 */

export type LinkGuideReadiness = "ready" | "disabled" | "misconfigured";
export type LinkGuideShape = "card" | "text";

export type LinkGuideFlowDeps = {
  repository: Pick<LinkGuideRepository, "createSend" | "markSendSent" | "markSendFailed">;
  isEnabled: () => boolean;
  isCardEnabled: () => boolean;
  isTwoHourRecoveryEnabled: () => boolean;
  redirectBaseUrl: string | undefined;
  allowedHosts: ReadonlySet<string>;
  profileUrl: string;
  loadCover: (resourceId: string) => Promise<{ coverUrl: string } | null>;
  sendMeta: (payload: MetaMessagePayload, metadata: SafeMetaMessageLog) => Promise<MetaSendResult>;
  sendTrackedPrivateCard: (input: {
    recipientIgUserId: string;
    commentId: string;
    send: () => Promise<MetaSendResult>;
    subtitle: string;
    coverUrl: string;
    source: "keyword_automation";
  }) => Promise<TrackedPrivateReplyReceipt>;
  sendTrackedPrivateReply: (input: {
    recipientIgUserId: string;
    commentId: string;
    text: string;
    source: "keyword_automation";
  }) => Promise<TrackedPrivateReplyReceipt>;
  sendTrackedText: (input: {
    recipientIgUserId: string;
    text: string;
    source: "keyword_automation";
  }) => Promise<MetaSendResult>;
  markLinkSent: (conversationId: string) => Promise<void>;
  scheduleAcceptedGateRecovery: (input: AcceptedGateRecoveryInput) => Promise<unknown>;
  markThreadResolved: (input: { threadId: string; inboundMessageId: string }) => Promise<void>;
  logEvent: (kind: string, payload: object) => Promise<void>;
  describeError: (error: unknown) => object;
  newToken: () => string;
  now: () => Date;
};

type LinkSendCommon = {
  conversationId: string;
  keywordId: string;
  mediaId: string | null;
  igUserId: string;
  resource: LinkGuideResource;
};

export type LinkGuideSendInput =
  | (LinkSendCommon & { channel: "private_reply"; commentId: string })
  | (LinkSendCommon & { channel: "dm" });

export type LinkGuideSendResult =
  | { outcome: "sent"; sendId: string; shape: LinkGuideShape; receipt: TrackedPrivateReplyReceipt | null }
  | { outcome: "failed"; sendId: string; shape: LinkGuideShape; error: unknown; retryText: string };

export type LinkGuideRunResult =
  | LinkGuideSendResult
  | { outcome: "not_ready"; readiness: Exclude<LinkGuideReadiness, "ready"> };

export type CommentLinkGuideInput = LinkSendCommon & { keywordSnapshot: string; commentId: string };
export type DmLinkGuideInput = LinkSendCommon & { threadId: string; inboundMessageId: string };

export function createLinkGuideFlow(deps: LinkGuideFlowDeps) {
  function readiness(resource: LinkGuideResource): LinkGuideReadiness {
    if (!deps.isEnabled()) return "disabled";
    if (!deps.redirectBaseUrl) return "misconfigured";
    if (resource.deliveryMode !== "link") return "misconfigured";
    return validateLinkGuideFields(resource, deps.allowedHosts) === null ? "ready" : "misconfigured";
  }

  async function notReady(
    state: Exclude<LinkGuideReadiness, "ready">,
    context: object,
  ): Promise<LinkGuideRunResult> {
    await deps.logEvent(state === "disabled" ? "link_guide_disabled" : "link_guide_misconfigured", context);
    return { outcome: "not_ready", readiness: state };
  }

  async function sendLinkGuide(input: LinkGuideSendInput): Promise<LinkGuideSendResult> {
    if (!deps.redirectBaseUrl) throw new Error("link_guide_not_ready");
    const token = deps.newToken();
    const url = trackedLinkUrl(deps.redirectBaseUrl, token);
    const title = linkCardTitle(input.resource);
    const subtitle = linkCardSubtitle(input.resource);
    const text = linkGuideText({ title, url });
    // A card with no image is a worse message than plain text, so no cover means text.
    const cover = deps.isCardEnabled() ? await deps.loadCover(input.resource.id) : null;
    const shape: LinkGuideShape = cover ? "card" : "text";
    const send = await deps.repository.createSend({
      token,
      conversationId: input.conversationId,
      resourceId: input.resource.id,
      keywordId: input.keywordId,
      mediaId: input.mediaId,
      igUserId: input.igUserId,
      channel: input.channel,
      shape,
    });
    const cardFor = (recipient: LinkGuideRecipient, coverUrl: string) =>
      buildLinkGuideCardPayload({
        recipient,
        title,
        subtitle,
        coverUrl,
        buttonLabel: input.resource.linkButtonLabel ?? "",
        trackedUrl: url,
        profileUrl: deps.profileUrl,
      });

    let receipt: TrackedPrivateReplyReceipt | null = null;
    let providerMessageId: string | null;
    try {
      if (input.channel === "private_reply") {
        const commentId = input.commentId;
        receipt = cover
          ? await deps.sendTrackedPrivateCard({
              recipientIgUserId: input.igUserId,
              commentId,
              subtitle,
              coverUrl: cover.coverUrl,
              source: "keyword_automation",
              send: () =>
                deps.sendMeta(cardFor({ comment_id: commentId }, cover.coverUrl), {
                  commentId,
                  mode: "private_link_card",
                  messageLength: codePoints(subtitle),
                }),
            })
          : await deps.sendTrackedPrivateReply({
              recipientIgUserId: input.igUserId,
              commentId,
              text,
              source: "keyword_automation",
            });
        providerMessageId = receipt.instagramMessageId;
      } else {
        const result = cover
          ? await deps.sendMeta(cardFor({ id: input.igUserId }, cover.coverUrl), {
              recipientId: input.igUserId,
              mode: "dm_link_card",
              messageLength: codePoints(subtitle),
            })
          : await deps.sendTrackedText({ recipientIgUserId: input.igUserId, text, source: "keyword_automation" });
        providerMessageId = result.messageId;
      }
    } catch (error) {
      await deps.repository.markSendFailed(send.id).catch(() => undefined);
      return { outcome: "failed", sendId: send.id, shape, error, retryText: text };
    }

    // The message is out. A failed bookkeeping write must never be reported as a failed
    // send: the caller would queue a retry and the parent would get the link twice.
    try {
      await deps.repository.markSendSent(send.id, providerMessageId, deps.now());
    } catch {
      await deps.logEvent("link_send_record_failed", { conversationId: input.conversationId });
    }
    await deps.logEvent("dm_sent", {
      conversationId: input.conversationId,
      kind: "link",
      shape,
      channel: input.channel,
    });
    return { outcome: "sent", sendId: send.id, shape, receipt };
  }

  async function runCommentLinkGuide(input: CommentLinkGuideInput): Promise<LinkGuideRunResult> {
    const state = readiness(input.resource);
    if (state !== "ready") {
      return notReady(state, { conversationId: input.conversationId, resourceId: input.resource.id, source: "comment" });
    }
    await deps.markLinkSent(input.conversationId);
    const result = await sendLinkGuide({
      channel: "private_reply",
      conversationId: input.conversationId,
      keywordId: input.keywordId,
      mediaId: input.mediaId,
      igUserId: input.igUserId,
      resource: input.resource,
      commentId: input.commentId,
    });
    if (result.outcome === "sent" && result.receipt && deps.isTwoHourRecoveryEnabled()) {
      const receipt = result.receipt;
      try {
        await deps.scheduleAcceptedGateRecovery({
          conversationId: input.conversationId,
          igUserId: input.igUserId,
          keywordId: input.keywordId,
          keywordSnapshot: input.keywordSnapshot,
          commentId: input.commentId,
          mediaId: input.mediaId,
          gateDmMessageId: receipt.dmMessageId,
          instagramGateMessageId: receipt.instagramMessageId,
          acceptedAt: receipt.acceptedAt,
          openingKind: "link",
        });
      } catch {
        await deps.logEvent("dm_recovery_schedule_failed", {
          conversationId: input.conversationId,
          commentId: input.commentId,
          triggerKind: "no_confirmed_read",
        });
      }
    }
    return result;
  }

  async function runDmLinkGuide(input: DmLinkGuideInput): Promise<LinkGuideRunResult> {
    const state = readiness(input.resource);
    if (state !== "ready") {
      return notReady(state, { conversationId: input.conversationId, resourceId: input.resource.id, source: "dm" });
    }
    await deps.markLinkSent(input.conversationId);
    const result = await sendLinkGuide({
      channel: "dm",
      conversationId: input.conversationId,
      keywordId: input.keywordId,
      mediaId: input.mediaId,
      igUserId: input.igUserId,
      resource: input.resource,
    });
    if (result.outcome === "sent") {
      await deps.markThreadResolved({ threadId: input.threadId, inboundMessageId: input.inboundMessageId });
    } else {
      await deps.logEvent("dm_failed", {
        conversationId: input.conversationId,
        stage: "link_inbound_dm",
        ...deps.describeError(result.error),
      });
    }
    return result;
  }

  return { readiness, sendLinkGuide, runCommentLinkGuide, runDmLinkGuide };
}

export type LinkGuideFlow = ReturnType<typeof createLinkGuideFlow>;
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/services/linkGuideFlowCore.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `src/services/linkGuideFlow.ts`**

```ts
// src/services/linkGuideFlow.ts
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { GUIDE_PROFILE_URL } from "../meta/sendGuideAction.js";
import { sendMetaMessage } from "../meta/sendMessage.js";
import { markLinkSent } from "./conversationService.js";
import { sendTrackedPrivateCard, sendTrackedPrivateReply, sendTrackedText } from "./dmDeliveryService.js";
import { scheduleAcceptedGateRecovery } from "./dmRecoveryService.js";
import { markThreadResolved } from "./dmThreadService.js";
import { describeGraphError, logEvent } from "./eventLogger.js";
import { flags } from "./flagService.js";
import { loadGateCard } from "./guideGateCard.js";
import { createLinkGuideFlow, type LinkGuideFlow } from "./linkGuideFlowCore.js";
import { newLinkToken, parseAllowedHosts } from "./linkGuidePolicy.js";
import { createLinkGuideRepository } from "./linkGuideRepository.js";

export const linkGuideRepository = createLinkGuideRepository(prisma);

let instance: LinkGuideFlow | undefined;

/** Built on first use, so importing a handler never reads config before a test mocks it. */
function getLinkGuideFlow(): LinkGuideFlow {
  instance ??= createLinkGuideFlow({
    repository: linkGuideRepository,
    isEnabled: () => flags.bool("LINK_GUIDE_ENABLED"),
    isCardEnabled: () => flags.bool("LINK_GUIDE_CARD_ENABLED"),
    isTwoHourRecoveryEnabled: () => flags.bool("DM_RECOVERY_TWO_HOUR_ALL_ENABLED"),
    redirectBaseUrl: env.LINK_GUIDE_REDIRECT_BASE_URL,
    allowedHosts: parseAllowedHosts(env.LINK_GUIDE_ALLOWED_HOSTS),
    profileUrl: GUIDE_PROFILE_URL,
    loadCover: loadGateCard,
    sendMeta: sendMetaMessage,
    sendTrackedPrivateCard,
    sendTrackedPrivateReply,
    sendTrackedText,
    markLinkSent,
    scheduleAcceptedGateRecovery,
    markThreadResolved,
    logEvent,
    describeError: describeGraphError,
    newToken: newLinkToken,
    now: () => new Date(),
  });
  return instance;
}

export const linkGuideFlow: LinkGuideFlow = {
  readiness: (resource) => getLinkGuideFlow().readiness(resource),
  sendLinkGuide: (input) => getLinkGuideFlow().sendLinkGuide(input),
  runCommentLinkGuide: (input) => getLinkGuideFlow().runCommentLinkGuide(input),
  runDmLinkGuide: (input) => getLinkGuideFlow().runDmLinkGuide(input),
};
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. If an assignment of a real function to a dependency fails to type-check, the dependency type is wrong. Fix the type in `linkGuideFlowCore.ts`; never cast the real function.

- [ ] **Step 7: Commit**

```bash
git add src/services/linkGuideFlowCore.ts src/services/linkGuideFlowCore.test.ts src/services/linkGuideFlow.ts
git commit -m "feat: add link guide send flow"
```

---
### Task 9: Owner routing and the comment path

**Files:**
- Create: `src/services/guideOwner.ts`
- Test: `src/services/guideOwner.test.ts`
- Modify: `src/services/keywordService.ts`
- Test: `src/services/keywordService.test.ts`
- Modify: `src/handlers/commentHandler.ts`
- Test: `src/handlers/commentHandler.test.ts`
- Test: `src/handlers/guideAudienceGate.handler.test.ts` (add one mock)

**Interfaces:**
- Consumes:
  - Task 1: `DeliveryMode`, `LINK_GUIDE_RESOURCE_SELECT`.
  - Task 8: `linkGuideFlow.readiness`, `linkGuideFlow.runCommentLinkGuide`.
- Produces:
  - `GuideOwner = "v1" | "v2" | "link"`
  - `guideOwnerFor({ deliveryMode, igUserId, resourceId }, selectStrictOwner): GuideOwner`. The selector's errors propagate; callers keep their existing catch-and-log fallback to `"v1"`.
  - `findKeywordForComment` now returns keywords that include `resource: LinkGuideResource`.

- [ ] **Step 1: Write the failing `guideOwner` test**

```ts
// src/services/guideOwner.test.ts
import { describe, expect, it, vi } from "vitest";
import { guideOwnerFor } from "./guideOwner.js";

describe("guideOwnerFor", () => {
  it("routes a link guide to the link path without asking the strict-gate selector", () => {
    const select = vi.fn(() => "v2" as const);
    expect(guideOwnerFor({ deliveryMode: "link", igUserId: "ig-1", resourceId: "res-1" }, select)).toBe("link");
    expect(select).not.toHaveBeenCalled();
  });

  it.each(["gated", undefined] as const)("leaves a %s guide to the selector", (deliveryMode) => {
    expect(guideOwnerFor({ deliveryMode, igUserId: "ig-1", resourceId: "res-1" }, () => "v2")).toBe("v2");
  });

  it("lets a selector failure reach the caller, which falls back to V1 and logs it", () => {
    expect(() =>
      guideOwnerFor({ deliveryMode: "gated", igUserId: "ig-1", resourceId: "res-1" }, () => {
        throw new Error("flag_read_failed");
      }),
    ).toThrow("flag_read_failed");
  });
});
```

- [ ] **Step 2: Run it, confirm it fails, then implement it**

Run: `npx vitest run src/services/guideOwner.test.ts`. Expected: FAIL, the module is missing.

```ts
// src/services/guideOwner.ts
import type { DeliveryMode } from "./linkGuidePolicy.js";

export type GuideOwner = "v1" | "v2" | "link";

/**
 * Which path answers a guide request. A link guide is decided by the guide alone and
 * never reaches the strict-gate selector, so no flag or allowlist can put a link guide
 * behind the follow gate. Everything else is the selector's decision, unchanged.
 *
 * Selector errors propagate on purpose: each caller already catches them, logs, and
 * falls back to V1, and that behavior stays where it is.
 */
export function guideOwnerFor(
  input: { deliveryMode: DeliveryMode | undefined; igUserId: string; resourceId: string },
  selectStrictOwner: (input: { igUserId: string; resourceId: string }) => "v1" | "v2",
): GuideOwner {
  if (input.deliveryMode === "link") return "link";
  return selectStrictOwner({ igUserId: input.igUserId, resourceId: input.resourceId });
}
```

Run it again. Expected: PASS.

- [ ] **Step 3: Load the guide's link fields with the comment keyword**

In `src/services/keywordService.ts`, add the import:

```ts
import { LINK_GUIDE_RESOURCE_SELECT } from "./linkGuidePolicy.js";
```

Add next to `WITH_SEQUENCE`:

```ts
// The comment path decides gated vs link before it replies, so the guide's mode and
// link fields arrive with the keyword. One query, no second read that could fail alone.
const WITH_LINK_FIELDS = { resource: { select: LINK_GUIDE_RESOURCE_SELECT } } as const;
```

In `findKeywordForComment`, add `include: WITH_LINK_FIELDS` to both `findMany` calls:

```ts
  const [postKeywords, globalKeywords] = await Promise.all([
    mediaId
      ? prisma.keyword.findMany({ where: { mediaId, active: true }, include: WITH_LINK_FIELDS })
      : Promise.resolve([]),
    prisma.keyword.findMany({
      where: { keyword: { in: scan }, mediaId: null, active: true },
      include: WITH_LINK_FIELDS,
    }),
  ]);
```

In `src/services/keywordService.test.ts`, the `findKeywordForComment("Day 1", "post-1")` test asserts the exact `findMany` arguments. Update that expectation to:

```ts
    expect(findMany).toHaveBeenCalledWith({
      where: {
        keyword: { in: ["DAY 1", "DAY1", "DAY", "1"] },
        mediaId: null,
        active: true,
      },
      include: { resource: { select: LINK_GUIDE_RESOURCE_SELECT } },
    });
```

and add `import { LINK_GUIDE_RESOURCE_SELECT } from "./linkGuidePolicy.js";` to the test's imports. Then run `grep -n "toHaveBeenCalledWith({" src/services/keywordService.test.ts`. Update any other `findKeywordForComment` assertion the same way; leave the `findDmKeywordCandidates` ones as they are.

Run: `npx vitest run src/services/keywordService.test.ts`. Expected: PASS.

- [ ] **Step 4: Write the failing comment-handler tests**

In `src/handlers/commentHandler.test.ts`:

(a) Next to the other `vi.fn()` declarations at the top, add:

```ts
const linkReadiness = vi.fn();
const runCommentLinkGuide = vi.fn();
```

(b) Next to the other `vi.mock(...)` calls, before `const { handleComment } = await import("./commentHandler.js");`, add:

```ts
vi.mock("../services/linkGuideFlow.js", () => ({
  linkGuideFlow: { readiness: linkReadiness, runCommentLinkGuide, runDmLinkGuide: vi.fn() },
  linkGuideRepository: {},
}));
```

(c) In `beforeEach`, add `linkReadiness` and `runCommentLinkGuide` to the reset array, and after the loop add:

```ts
  linkReadiness.mockReturnValue("ready");
  runCommentLinkGuide.mockResolvedValue({
    outcome: "sent",
    sendId: "send-1",
    shape: "card",
    receipt: { instagramMessageId: "mid-1", dmMessageId: "dm-1", acceptedAt: new Date() },
  });
```

(d) Append this block:

```ts
describe("link guides — comment path", () => {
  const LINK_RESOURCE = {
    id: RESOURCE_ID,
    name: "Halloween collection",
    description: null,
    deliveryMode: "link",
    linkUrl: "https://mycuratedhaven.com/halloween",
    linkButtonLabel: "Open the recipes",
    linkCardTitle: "Your Halloween recipes 👻",
    linkCardSubtitle: null,
  };
  const COMMENT = {
    id: "comment-link-1",
    text: "GHOST",
    from: { id: "ig-parent", username: "parent" },
    media: { id: "reel-9", media_product_type: "REELS" },
  };

  beforeEach(() => {
    extractCandidates.mockReturnValue(["GHOST"]);
    scannableCommentMatchCandidates.mockReturnValue(["GHOST"]);
    findKeywordForComment.mockResolvedValue({
      mode: "post_strict",
      matchedToken: "GHOST",
      keyword: {
        id: "keyword-ghost",
        keyword: "GHOST",
        mediaId: "reel-9",
        resourceId: RESOURCE_ID,
        publicReply: "Sent you the recipes",
        gateMessage: "unused",
        resource: LINK_RESOURCE,
      },
    });
  });

  it("replies publicly, sends the link, and never starts the follow gate", async () => {
    gateOwner.mockReturnValue("v2");

    await handleComment(COMMENT);

    expect(replyToComment).toHaveBeenCalledWith("comment-link-1", "Sent you the recipes");
    expect(runCommentLinkGuide).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      keywordId: "keyword-ghost",
      keywordSnapshot: "GHOST",
      commentId: "comment-link-1",
      mediaId: "reel-9",
      igUserId: "ig-parent",
      resource: LINK_RESOURCE,
    });
    expect(gateOwner).not.toHaveBeenCalled();
    expect(startCommentGuideRequest).not.toHaveBeenCalled();
    expect(sendTrackedPrivateReply).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "keyword_matched",
      expect.objectContaining({ deliveryMode: "link" }),
    );
  });

  it("stays silent before the public reply when link guides are switched off", async () => {
    linkReadiness.mockReturnValue("disabled");

    await handleComment(COMMENT);

    expect(replyToComment).not.toHaveBeenCalled();
    expect(resolveJourneyIntent).not.toHaveBeenCalled();
    expect(runCommentLinkGuide).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith("link_guide_disabled", {
      commentId: "comment-link-1",
      keywordId: "keyword-ghost",
      resourceId: RESOURCE_ID,
    });
  });

  it("queues the text-with-link retry when the link DM fails", async () => {
    runCommentLinkGuide.mockResolvedValue({
      outcome: "failed",
      sendId: "send-1",
      shape: "card",
      error: new Error("socket hang up"),
      retryText: "Your Halloween recipes 👻\nhttps://api.example.com/r/tok_ABCDEFG",
    });

    await handleComment(COMMENT);

    expect(enqueueGate).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        commentId: "comment-link-1",
        gateMessage: "Your Halloween recipes 👻\nhttps://api.example.com/r/tok_ABCDEFG",
      }),
    );
  });

  it("sends nothing more for a repeat comment inside the same journey", async () => {
    resolveJourneyIntent.mockResolvedValue({
      disposition: "reused_active",
      intentId: "intent-1",
      conversationId: "conversation-1",
      maySendGate: false,
    });

    await handleComment(COMMENT);

    expect(replyToComment).toHaveBeenCalledTimes(1);
    expect(runCommentLinkGuide).not.toHaveBeenCalled();
  });
});
```

In `src/handlers/guideAudienceGate.handler.test.ts`, add the same `vi.mock("../services/linkGuideFlow.js", ...)` block next to its other mocks, using `vi.fn()` inline for `readiness` and `runCommentLinkGuide`:

```ts
vi.mock("../services/linkGuideFlow.js", () => ({
  linkGuideFlow: { readiness: vi.fn(() => "ready"), runCommentLinkGuide: vi.fn(), runDmLinkGuide: vi.fn() },
  linkGuideRepository: {},
}));
```

- [ ] **Step 5: Run them and confirm the new ones fail**

Run: `npx vitest run src/handlers/commentHandler.test.ts`
Expected: the 4 new link tests FAIL. Every existing test still passes.

- [ ] **Step 6: Wire the comment handler**

In `src/handlers/commentHandler.ts`:

(a) Add imports:

```ts
import { guideOwnerFor, type GuideOwner } from "../services/guideOwner.js";
import { linkGuideFlow } from "../services/linkGuideFlow.js";
```

(b) Directly after the audience-authorization `try { ... } catch { ... }` block, before `// Attach this comment to the person's canonical journey`, add:

```ts
  // A link guide that cannot send must stay silent BEFORE the public reply: replying
  // "check your DMs" and then sending nothing is the one outcome worse than silence.
  // `?.` because rows matched before the include existed may lack it in tests.
  const deliveryMode = keyword.resource?.deliveryMode ?? "gated";
  if (deliveryMode === "link") {
    const readiness = linkGuideFlow.readiness(keyword.resource);
    if (readiness !== "ready") {
      await logEvent(readiness === "disabled" ? "link_guide_disabled" : "link_guide_misconfigured", {
        commentId: comment.id,
        keywordId: keyword.id,
        resourceId: keyword.resourceId,
      });
      return;
    }
  }
```

(c) In the `logEvent("keyword_matched", { ... })` payload, add after `mediaId: comment.media?.id ?? null,`:

```ts
    // Funnels read this: the guide-follow cohort skips link guides, the link funnel
    // selects them. Absent means gated, so every gated payload stays byte-identical.
    ...(deliveryMode === "link" && { deliveryMode }),
```

(d) Replace the strict-owner block:

```ts
  let strictGateOwner: "v1" | "v2" = "v1";
  try {
    strictGateOwner = guideFollowGateV2Selector.owner({
      igUserId: senderId,
      resourceId: keyword.resourceId,
    });
  } catch {
    log.warn({ igUserId: senderId }, "Strict gate ownership unavailable — using V1");
  }
```

with:

```ts
  let owner: GuideOwner = "v1";
  try {
    owner = guideOwnerFor(
      { deliveryMode, igUserId: senderId, resourceId: keyword.resourceId },
      (input) => guideFollowGateV2Selector.owner(input),
    );
  } catch {
    log.warn({ igUserId: senderId }, "Strict gate ownership unavailable — using V1");
  }

  // ---- Link guide -------------------------------------------------------------
  // One private reply holding the link. No follow check, no access attempt. A failed
  // send runs the same recovery ladder as the gate, with the text-with-link as the retry.
  if (owner === "link") {
    try {
      const result = await linkGuideFlow.runCommentLinkGuide({
        conversationId: convo.id,
        keywordId: keyword.id,
        keywordSnapshot: keyword.keyword,
        commentId: comment.id,
        mediaId: comment.media?.id ?? null,
        igUserId: senderId,
        resource: keyword.resource,
      });
      if (result.outcome === "failed") {
        await recoverFailedPrivateReply({
          error: result.error,
          conversationId: convo.id,
          senderId,
          keywordId: keyword.id,
          keywordSnapshot: keyword.keyword,
          commentId: comment.id,
          parentId: comment.parent_id ?? null,
          mediaId: comment.media?.id ?? null,
          gateMessage: result.retryText,
        });
      }
    } catch (error) {
      // Must not fail the webhook, and must not fall through to a gate for a link guide.
      log.error(describeGraphError(error), "Link guide send failed");
    }
    return;
  }
```

(e) Rename the remaining uses of `strictGateOwner` to `owner`. Run `grep -n "strictGateOwner" src/handlers/commentHandler.ts` and confirm it returns nothing after the edit. The first is `if (strictGateOwner === "v2") {`, which becomes `if (owner === "v2") {`.

- [ ] **Step 7: Run the handler tests and typecheck**

```bash
npx vitest run src/handlers/commentHandler.test.ts src/handlers/guideAudienceGate.handler.test.ts src/services/keywordService.test.ts src/services/guideOwner.test.ts
```

Expected: PASS, including the 4 new link tests.

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/services/guideOwner.ts src/services/guideOwner.test.ts src/services/keywordService.ts src/services/keywordService.test.ts src/handlers/commentHandler.ts src/handlers/commentHandler.test.ts src/handlers/guideAudienceGate.handler.test.ts
git commit -m "feat: route link guides on the comment path"
```

---
### Task 10: DM path and the retry worker

**Files:**
- Modify: `src/handlers/messageHandler.ts`
- Test: `src/handlers/messageHandler.test.ts`
- Modify: `src/services/gateQueueWorker.ts`
- Test: `src/services/gateQueueWorker.test.ts`

**Interfaces:**
- Consumes:
  - Task 8: `linkGuideFlow.runDmLinkGuide`, `linkGuideRepository.markLatestFailedSendSent`.
  - Task 9: `guideOwnerFor`, `GuideOwner`.
  - Task 7: `openingKind` on `scheduleAcceptedGateRecovery`.
- Produces: no new exports. Behavior:
  - A DM of a link guide's keyword sends the link card in the open thread.
  - A reply to a still-`awaiting_done` link conversation sends the link, never the gate.
  - A retried link private reply lands the conversation in `link_sent`.

- [ ] **Step 1: Write the failing message-handler tests**

In `src/handlers/messageHandler.test.ts`:

(a) Next to the other `vi.fn()` declarations, add `const runDmLinkGuide = vi.fn();`.

(b) Next to the other mocks, add:

```ts
vi.mock("../services/linkGuideFlow.js", () => ({
  linkGuideFlow: { readiness: vi.fn(() => "ready"), runCommentLinkGuide: vi.fn(), runDmLinkGuide },
  linkGuideRepository: {},
}));
```

(c) Add `runDmLinkGuide` to the `beforeEach` reset array, and after the loop add:

```ts
  runDmLinkGuide.mockResolvedValue({ outcome: "sent", sendId: "send-1", shape: "card", receipt: null });
```

(d) Append:

```ts
describe("link guides — direct DM", () => {
  const LINK_KEYWORD = {
    ...keywordFixture,
    resource: {
      ...keywordFixture.resource,
      deliveryMode: "link",
      linkUrl: "https://mycuratedhaven.com/halloween",
      linkButtonLabel: "Open the recipes",
      linkCardTitle: null,
      linkCardSubtitle: null,
    },
  };

  beforeEach(() => {
    findKeywordInMessage.mockResolvedValue(LINK_KEYWORD);
  });

  it("sends the link card into the thread instead of any gate or guide", async () => {
    gateOwner.mockReturnValue("v2");
    resolveUsername.mockResolvedValue({ isFollower: false, username: "p", name: "P" });

    await handleMessage(inbound("SLEEP"));

    expect(runDmLinkGuide).toHaveBeenCalledTimes(1);
    expect(runDmLinkGuide.mock.calls[0]![0]).toMatchObject({
      conversationId: "convo-1",
      igUserId: "ig-user-1",
      threadId: "thread-1",
      inboundMessageId: "message-1",
      resource: { deliveryMode: "link" },
    });
    expect(gateOwner).not.toHaveBeenCalled();
    expect(startDirectDmGuideRequest).not.toHaveBeenCalled();
    expect(sendSequence).not.toHaveBeenCalled();
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
    expect(sendTrackedText).not.toHaveBeenCalled();
  });
});

describe("link guides — reply to a conversation still awaiting_done", () => {
  const OPEN_LINK_CONVO = {
    id: "convo-open-link",
    keywordId: "keyword-1",
    keyword: {
      keyword: "GHOST",
      mediaId: "reel-9",
      resource: {
        id: "resource-9",
        name: "Halloween collection",
        description: null,
        deliveryMode: "link",
        linkUrl: "https://mycuratedhaven.com/halloween",
        linkButtonLabel: "Open the recipes",
        linkCardTitle: null,
        linkCardSubtitle: null,
        messages: [],
      },
    },
  };

  beforeEach(() => {
    findKeywordInMessage.mockResolvedValue(null);
    findActiveAwaitingDone.mockResolvedValue(OPEN_LINK_CONVO);
  });

  it("answers a plain yes with the link and never the follow gate", async () => {
    gateOwner.mockReturnValue("v2");

    await handleMessage(inbound("yes"));

    expect(runDmLinkGuide).toHaveBeenCalledTimes(1);
    expect(runDmLinkGuide.mock.calls[0]![0]).toMatchObject({
      conversationId: "convo-open-link",
      keywordId: "keyword-1",
      mediaId: "reel-9",
    });
    expect(startDirectDmGuideRequest).not.toHaveBeenCalled();
    expect(deliverGuideForTrigger).not.toHaveBeenCalled();
    expect(sendSequence).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and confirm the new ones fail**

Run: `npx vitest run src/handlers/messageHandler.test.ts`
Expected: the 2 new tests FAIL. Every existing test still passes.

- [ ] **Step 3: Wire the message handler**

In `src/handlers/messageHandler.ts`:

(a) Add imports:

```ts
import { guideOwnerFor, type GuideOwner } from "../services/guideOwner.js";
import { linkGuideFlow } from "../services/linkGuideFlow.js";
import type { DeliveryMode } from "../services/linkGuidePolicy.js";
```

(b) Replace the whole `strictGateOwnerFor` function (lines ~71–85) with:

```ts
/**
 * One ownership decision per call site. A link guide is decided by the guide alone;
 * everything else fails closed to V1 so a flag-read problem can never strand a parent
 * between the two gated paths.
 */
function guideOwnerForResource(
  igUserId: string,
  resource: { id: string; deliveryMode?: DeliveryMode },
): GuideOwner {
  try {
    return guideOwnerFor(
      { deliveryMode: resource.deliveryMode, igUserId, resourceId: resource.id },
      (input) => guideFollowGateV2Selector.owner(input),
    );
  } catch {
    logger.warn(
      { errorCode: "strict_gate_owner_unavailable", igUserId },
      "Strict gate ownership unavailable — using V1",
    );
    return "v1";
  }
}
```

(c) In the DM keyword path's `logEvent("keyword_matched", { ... })` payload, add after `mediaId: keyword.mediaId,`:

```ts
      ...(keyword.resource.deliveryMode === "link" && { deliveryMode: "link" }),
```

(d) In the DM keyword path, replace:

```ts
    if (strictGateOwnerFor(senderId, keyword.resource.id) === "v2") {
```

with:

```ts
    const keywordOwner = guideOwnerForResource(senderId, keyword.resource);
    // A link guide answers a DM'd keyword with the link itself, follower or not.
    if (keywordOwner === "link") {
      await linkGuideFlow.runDmLinkGuide({
        conversationId: keywordConversation.id,
        keywordId: keyword.id,
        mediaId: keyword.mediaId ?? null,
        igUserId: senderId,
        resource: keyword.resource,
        threadId: inbound.threadId,
        inboundMessageId: inbound.messageId,
      });
      return;
    }
    if (keywordOwner === "v2") {
```

(e) In the open-request reply branch, replace:

```ts
    if (strictGateOwnerFor(senderId, convo.keyword.resource.id) === "v2") {
```

with:

```ts
    const replyOwner = guideOwnerForResource(senderId, convo.keyword.resource);
    // A conversation still awaiting_done whose guide is a link guide: its link DM is being
    // retried, or the guide was switched to Link mid-journey. The reply opened the thread,
    // so answer with the link. Never the follow gate.
    if (replyOwner === "link") {
      await linkGuideFlow.runDmLinkGuide({
        conversationId: convo.id,
        keywordId: convo.keywordId,
        mediaId: convo.keyword.mediaId ?? null,
        igUserId: senderId,
        resource: convo.keyword.resource,
        threadId: inbound.threadId,
        inboundMessageId: inbound.messageId,
      });
      return;
    }
    if (replyOwner === "v2") {
```

(f) Run `grep -n "strictGateOwnerFor" src/handlers/messageHandler.ts`. Expected: no output. Replace any remaining call the same way, as `guideOwnerForResource(...) === "v2"`.

- [ ] **Step 4: Run the message-handler tests and confirm they pass**

Run: `npx vitest run src/handlers/messageHandler.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing retry-worker test**

In `src/services/gateQueueWorker.test.ts`:

(a) Next to the other `vi.fn()` declarations, add `const markLatestFailedSendSent = vi.fn();`.

(b) Add the mock:

```ts
vi.mock("./linkGuideFlow.js", () => ({
  linkGuideFlow: {},
  linkGuideRepository: { markLatestFailedSendSent },
}));
```

(c) Add `markLatestFailedSendSent` to the `beforeEach` reset array.

(d) Append:

```ts
describe("runGateQueueTick — link guides", () => {
  it("retries a link guide as the link itself and never reopens the gate", async () => {
    const linkConvo = { ...convoObj, keyword: { ...convoObj.keyword, resource: { deliveryMode: "link" } } };
    conversation.findMany.mockResolvedValue([linkConvo]);
    conversation.findUnique.mockResolvedValue(linkConvo);
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-retry",
      dmMessageId: "dm-retry",
      acceptedAt: new Date(),
    });
    markLatestFailedSendSent.mockResolvedValue(true);

    await runGateQueueTick();

    expect(conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { state: "link_sent", gatedAt: expect.any(Date) },
    });
    expect(conversation.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "awaiting_done" }) }),
    );
    expect(markLatestFailedSendSent).toHaveBeenCalledWith("conversation-1", "mid-retry", expect.any(Date));
    expect(logEvent).toHaveBeenCalledWith("dm_sent", {
      conversationId: "conversation-1",
      kind: "link",
      source: "retry",
      gateOwner: "link",
    });
    expect(gateOwner).not.toHaveBeenCalled();
    expect(recordGuideAccessMetric).not.toHaveBeenCalled();
    expect(scheduleAcceptedGateRecovery).not.toHaveBeenCalled();
  });

  it("schedules the link reminder when the 2-hour switch is on", async () => {
    flags.allTwoHour = true;
    const linkConvo = { ...convoObj, keyword: { ...convoObj.keyword, resource: { deliveryMode: "link" } } };
    conversation.findMany.mockResolvedValue([linkConvo]);
    conversation.findUnique.mockResolvedValue(linkConvo);
    sendTrackedPrivateReply.mockResolvedValue({
      instagramMessageId: "mid-retry",
      dmMessageId: "dm-retry",
      acceptedAt: new Date(),
    });

    await runGateQueueTick();

    expect(scheduleAcceptedGateRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conversation-1", openingKind: "link" }),
    );
  });
});
```

Run: `npx vitest run src/services/gateQueueWorker.test.ts`. Expected: the 2 new tests FAIL.

- [ ] **Step 6: Wire the retry worker**

In `src/services/gateQueueWorker.ts`:

(a) Add imports:

```ts
import { guideOwnerFor, type GuideOwner } from "./guideOwner.js";
import { linkGuideRepository } from "./linkGuideFlow.js";
```

(b) In the conversation load (`prisma.conversation.findMany({ ..., include: { keyword: true, ... } })`), change `keyword: true` to:

```ts
          keyword: { include: { resource: { select: { deliveryMode: true } } } },
```

(c) Replace the block that starts at `// Immediately finalize delivery state` and ends at the closing brace of `if (retryOwner !== "v2" || flags.bool("DM_RECOVERY_TWO_HOUR_ALL_ENABLED")) { ... }` with:

```ts
          // Ownership first. A link guide's retry IS the link, so its conversation must
          // land in link_sent, never back in awaiting_done where a reply would open the
          // gate. Computed the same way every other call site does, and fails closed to V1.
          let retryOwner: GuideOwner = "v1";
          try {
            retryOwner = guideOwnerFor(
              {
                deliveryMode: convo.keyword.resource?.deliveryMode,
                igUserId: row.igUserId,
                resourceId: convo.keyword.resourceId,
              },
              (input) => guideFollowGateV2Selector.owner(input),
            );
          } catch {
            logger.warn(
              { errorCode: "strict_gate_owner_unavailable", gateQueueId: row.id },
              "Strict gate ownership unavailable — treating retry as V1",
            );
          }

          // Immediately finalize delivery state
          await prisma.gateQueue.update({
            where: { id: row.id },
            data: { status: "sent", attempts: row.attempts + 1, lastError: null },
          });
          await prisma.conversation.update({
            where: { id: row.conversationId },
            data:
              retryOwner === "link"
                ? { state: "link_sent", gatedAt: new Date() }
                : { state: "awaiting_done", gatedAt: new Date() },
          });
          if (retryOwner === "link") {
            // The retry re-sent the failed send's own token, so complete that send.
            await linkGuideRepository
              .markLatestFailedSendSent(row.conversationId, receipt.instagramMessageId, new Date())
              .catch(() => undefined);
          }

          await logEvent("dm_sent", {
            conversationId: row.conversationId,
            kind: retryOwner === "link" ? "link" : "gate",
            source: "retry",
            // Tagged so V2 and link retry volume never silently inflates the V1 baseline.
            gateOwner: retryOwner,
          });

          // if/else rather than `continue`: the shared tail below owns the tick counter
          // and the inter-send pacing, and no retry may skip either.
          if (retryOwner === "v2") {
            // The strict opening was re-sent, so this counts on V2's own metric.
            await recordGuideAccessMetric("opening", "accepted");
          }
          if (retryOwner === "v1" || flags.bool("DM_RECOVERY_TWO_HOUR_ALL_ENABLED")) {
            // Schedule recovery in separate block (failures do not un-send or revert queue)
            try {
              await scheduleAcceptedGateRecovery({
                conversationId: row.conversationId,
                igUserId: row.igUserId,
                keywordId: convo.keywordId,
                keywordSnapshot: convo.keyword.keyword,
                commentId: row.commentId,
                mediaId: row.mediaId,
                gateDmMessageId: receipt.dmMessageId,
                instagramGateMessageId: receipt.instagramMessageId,
                acceptedAt: receipt.acceptedAt,
                ...(retryOwner === "link" ? { openingKind: "link" as const } : {}),
              });
            } catch {
              await logEvent("dm_recovery_schedule_failed", {
                conversationId: row.conversationId,
                commentId: row.commentId,
                triggerKind: "no_confirmed_read",
              });
            }
          }
```

The old condition was `retryOwner !== "v2" || ...`. Changing it to `retryOwner === "v1" || ...` keeps V1 and V2 exactly as they were, and gives link guides V2's rule: a reminder only under the 2-hour switch.

- [ ] **Step 7: Run the tests and typecheck**

```bash
npx vitest run src/services/gateQueueWorker.test.ts src/handlers
```

Expected: PASS, every handler test plus the worker.

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/handlers/messageHandler.ts src/handlers/messageHandler.test.ts src/services/gateQueueWorker.ts src/services/gateQueueWorker.test.ts
git commit -m "feat: route link guides on the DM path and gate retries"
```

---
### Task 11: Public click redirect `GET /r/:token`

**Files:**
- Create: `src/api/linkRedirect.routes.ts`
- Test: `src/api/linkRedirect.routes.test.ts` (supertest, fake dependencies)
- Test: `src/api/linkRedirectContract.test.ts` (real Postgres plus the real `markCompleted`)
- Modify: `src/server.ts`

**Interfaces:**
- Consumes:
  - Task 1: `LINK_TOKEN_PATTERN`, `buildDestinationUrl`, `classifyClick`, `fallbackRedirectUrl`, `isAllowedLinkUrl`, `parseAllowedHosts`.
  - Task 6: `LinkGuideRepository.findForRedirect`, `LinkGuideRepository.recordClick`.
  - Task 8: `linkGuideRepository`.
  - The existing `markCompleted` from `src/services/conversationService.ts`.
- Produces:
  - `LinkRedirectDeps`
  - `createLinkRedirectHandler(deps)`
  - `createLinkRedirectRouter(deps)`, mounted at `/r` on the app, outside `/api` auth and CORS.

- [ ] **Step 1: Write the failing route test**

```ts
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
  "https://mycuratedhaven.com/halloween?utm_source=instagram&utm_medium=dm&utm_campaign=halloween-collection&utm_content=reel-9";
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
    const response = await request(app).get("/r/not-a-token").expect(302);
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/api/linkRedirect.routes.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Write the route**

```ts
// src/api/linkRedirect.routes.ts
import type { Request, Response } from "express";
import { asyncRouter } from "./asyncRouter.js";
import type { LinkGuideRepository } from "../services/linkGuideRepository.js";
import {
  buildDestinationUrl,
  classifyClick,
  fallbackRedirectUrl,
  isAllowedLinkUrl,
  LINK_TOKEN_PATTERN,
} from "../services/linkGuidePolicy.js";

/**
 * GET /r/:token — the link-guide button. Public and unauthenticated: a parent taps it
 * from Instagram. Every request redirects; nothing here can show a parent an error page.
 *
 * The destination is the guide's CURRENT link, so fixing a URL also fixes DMs already
 * sent, and it is re-checked against the allowed hosts on every hit, so this can never
 * become an open redirect. The click is recorded after the redirect is sent, and the
 * first human tap completes the conversation.
 */
export type LinkRedirectDeps = {
  repository: Pick<LinkGuideRepository, "findForRedirect" | "recordClick">;
  allowedHosts: () => ReadonlySet<string>;
  completeConversation: (conversationId: string) => Promise<unknown>;
  now: () => Date;
  onBackgroundError: (error: unknown) => void;
};

export function createLinkRedirectHandler(deps: LinkRedirectDeps) {
  return async function linkRedirect(req: Request, res: Response): Promise<void> {
    const allowedHosts = deps.allowedHosts();
    const fallback = fallbackRedirectUrl(allowedHosts);
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");

    const token = String(req.params.token ?? "");
    if (!LINK_TOKEN_PATTERN.test(token)) {
      res.redirect(302, fallback);
      return;
    }

    let send: Awaited<ReturnType<LinkRedirectDeps["repository"]["findForRedirect"]>>;
    try {
      send = await deps.repository.findForRedirect(token);
    } catch (error) {
      deps.onBackgroundError(error);
      res.redirect(302, fallback);
      return;
    }
    if (!send || !send.resource.linkUrl || !isAllowedLinkUrl(send.resource.linkUrl, allowedHosts)) {
      res.redirect(302, fallback);
      return;
    }

    const destination = buildDestinationUrl({
      linkUrl: send.resource.linkUrl,
      guideName: send.resource.name,
      mediaId: send.mediaId,
    });
    res.redirect(302, destination);

    const click = classifyClick({ userAgent: req.get("user-agent") ?? "", method: req.method });
    try {
      const recorded = await deps.repository.recordClick({
        sendId: send.id,
        destinationUrl: destination,
        isBot: click.isBot,
        uaFamily: click.uaFamily,
        clickedAt: deps.now(),
      });
      if (recorded.firstHumanClick && send.conversationState === "link_sent") {
        await deps.completeConversation(send.conversationId);
      }
    } catch (error) {
      deps.onBackgroundError(error);
    }
  };
}

export function createLinkRedirectRouter(deps: LinkRedirectDeps) {
  const router = asyncRouter();
  router.get("/:token", createLinkRedirectHandler(deps));
  return router;
}
```

- [ ] **Step 4: Run the route test and confirm it passes**

Run: `npx vitest run src/api/linkRedirect.routes.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Mount it in `src/server.ts`**

Add imports:

```ts
import { createLinkRedirectRouter } from "./api/linkRedirect.routes.js";
import { markCompleted } from "./services/conversationService.js";
import { linkGuideRepository } from "./services/linkGuideFlow.js";
import { parseAllowedHosts } from "./services/linkGuidePolicy.js";
```

Directly before `app.use("/api", apiRouter);`, add:

```ts
// Link-guide button. Public and unauthenticated like /health and /webhook: parents tap
// it from Instagram. Outside the /api router, so it inherits neither admin auth nor CORS.
app.use(
  "/r",
  createLinkRedirectRouter({
    repository: linkGuideRepository,
    allowedHosts: () => parseAllowedHosts(env.LINK_GUIDE_ALLOWED_HOSTS),
    completeConversation: markCompleted,
    now: () => new Date(),
    onBackgroundError: () =>
      logger.error({ errorCode: "link_redirect_failed" }, "Link redirect lookup or click record failed"),
  }),
);
```

- [ ] **Step 6: Write the contract test against the real database**

```ts
// src/api/linkRedirectContract.test.ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLinkRedirectRouter } from "./linkRedirect.routes.js";
import { createLinkGuideRepository } from "../services/linkGuideRepository.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID().slice(0, 8).toUpperCase();
const ids = { resource: randomUUID(), keyword: randomUUID(), human: randomUUID(), bot: randomUUID() };
const tokens = { human: `h${suffix}AB`, bot: `x${suffix}AB` };
const INSTAGRAM_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 312.0.0.0.0";
const backgroundErrors: unknown[] = [];
let db: PrismaClient;

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.resource.create({
    data: {
      id: ids.resource,
      name: `Redirect link ${suffix}`,
      deliveryMode: "link",
      linkUrl: "https://mycuratedhaven.com/halloween",
      linkButtonLabel: "Open the recipes",
    },
  });
  await db.keyword.create({
    data: { id: ids.keyword, keyword: `RDR${suffix}`, resourceId: ids.resource, publicReply: "x", gateMessage: "x", mediaId: `reel-${suffix}` },
  });
  for (const [key, conversationId] of [["human", ids.human], ["bot", ids.bot]] as const) {
    await db.conversation.create({
      data: { id: conversationId, igUserId: `ig-${suffix}-${key}`, keywordId: ids.keyword, state: "link_sent" },
    });
    await db.guideLinkSend.create({
      data: {
        token: tokens[key],
        conversationId,
        resourceId: ids.resource,
        keywordId: ids.keyword,
        mediaId: `reel-${suffix}`,
        igUserId: `ig-${suffix}-${key}`,
        channel: "private_reply",
        shape: "card",
        status: "sent",
        sentAt: new Date(),
      },
    });
  }
});

afterAll(async () => {
  if (!databaseUrl) return;
  await db.conversation.deleteMany({ where: { keywordId: ids.keyword } });
  await db.keyword.deleteMany({ where: { id: ids.keyword } });
  await db.resource.deleteMany({ where: { id: ids.resource } });
  await db.$disconnect();
});

async function app() {
  const { markCompleted } = await import("../services/conversationService.js");
  const value = express();
  value.use(
    "/r",
    createLinkRedirectRouter({
      repository: createLinkGuideRepository(db),
      allowedHosts: () => new Set(["mycuratedhaven.com"]),
      completeConversation: markCompleted,
      now: () => new Date(),
      // Collected, not thrown: the handler calls this after the response is sent.
      onBackgroundError: (error) => {
        backgroundErrors.push(error);
      },
    }),
  );
  return value;
}

describeWithDatabase("link redirect against the real database", () => {
  it("records a human tap and completes the link_sent conversation", async () => {
    const response = await request(await app())
      .get(`/r/${tokens.human}`)
      .set("User-Agent", INSTAGRAM_UA)
      .expect(302);

    expect(response.headers.location).toBe(
      `https://mycuratedhaven.com/halloween?utm_source=instagram&utm_medium=dm&utm_campaign=redirect-link-${suffix.toLowerCase()}&utm_content=reel-${suffix}`,
    );
    await vi.waitFor(async () => {
      const conversation = await db.conversation.findUniqueOrThrow({ where: { id: ids.human } });
      expect(conversation.state).toBe("completed");
    });
    await expect(
      db.guideLinkClick.findMany({ where: { send: { token: tokens.human } }, select: { isBot: true, uaFamily: true } }),
    ).resolves.toEqual([{ isBot: false, uaFamily: "instagram_app" }]);
    expect(backgroundErrors).toEqual([]);
  });

  it("records a preview bot and leaves the conversation in link_sent", async () => {
    await request(await app()).get(`/r/${tokens.bot}`).set("User-Agent", "facebookexternalhit/1.1").expect(302);

    await vi.waitFor(async () => {
      await expect(db.guideLinkClick.count({ where: { send: { token: tokens.bot } } })).resolves.toBe(1);
    });
    await expect(db.conversation.findUniqueOrThrow({ where: { id: ids.bot } })).resolves.toMatchObject({
      state: "link_sent",
    });
  });
});
```

- [ ] **Step 7: Run everything for this task**

```bash
npx vitest run src/api/linkRedirect.routes.test.ts
```

```bash
MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract npx vitest run src/api/linkRedirectContract.test.ts
```

Expected: PASS. The contract test proves the real `markCompleted` handles a `link_sent` conversation that has no journey intent. If it throws there, read `markCompleted` and `markIntentCompleted` and fix the real code path; don't stub it in the test.

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/api/linkRedirect.routes.ts src/api/linkRedirect.routes.test.ts src/api/linkRedirectContract.test.ts src/server.ts
git commit -m "feat: add public link-guide click redirect"
```

---
### Task 12: Guides, keywords and conversations API

**Files:**
- Modify: `src/api/resources.routes.ts`
- Test: `src/api/resources.routes.test.ts`
- Modify: `src/api/keywords.routes.ts`
- Modify: `src/api/conversations.routes.ts`

**Interfaces:**
- Consumes: `validateLinkGuideFields` and `parseAllowedHosts` from Task 1, and `env.LINK_GUIDE_ALLOWED_HOSTS` from Task 5.
- Produces:
  - `POST /api/resources` and `PATCH /api/resources/:id` accept `deliveryMode`, `linkUrl`, `linkButtonLabel`, `linkCardTitle` and `linkCardSubtitle`, and answer `400 { error: <LinkGuideFieldError> }` on invalid link fields.
  - `DELETE` answers `409 { error: "resource_has_link_history" }`.
  - `GET /api/keywords` includes `resource.deliveryMode`.
  - `GET /api/conversations?state=link_sent` is accepted.

- [ ] **Step 1: Write the failing route tests**

In `src/api/resources.routes.test.ts`:

(a) Next to the other `vi.fn()` declarations, add:

```ts
const updateResource = vi.fn();
const countLinkSends = vi.fn();
```

(b) In the `vi.mock("../lib/prisma.js", ...)` factory, change `resource: { findMany, findUnique, create, delete: deleteResource }` to `resource: { findMany, findUnique, create, update: updateResource, delete: deleteResource }`, and add `guideLinkSend: { count: countLinkSends },`.

(c) Before `const { resourcesRouter } = await import("./resources.routes.js");`, add:

```ts
vi.mock("../config/env.js", () => ({ env: { LINK_GUIDE_ALLOWED_HOSTS: "mycuratedhaven.com" } }));
```

(d) In the file's `beforeEach`, next to its other default resolutions, add:

```ts
  updateResource.mockReset();
  countLinkSends.mockReset().mockResolvedValue(0);
```

(e) Append:

```ts
describe("link guide fields", () => {
  const LINK_BODY = {
    id: RESOURCE_ID,
    name: "Halloween collection",
    description: null,
    deliveryMode: "link",
    linkUrl: "https://mycuratedhaven.com/halloween",
    linkButtonLabel: "Open the recipes",
  };
  const STORED_GATED = {
    deliveryMode: "gated",
    linkUrl: null,
    linkButtonLabel: null,
    linkCardTitle: null,
    linkCardSubtitle: null,
  };

  it("creates a link guide when the link is complete", async () => {
    await request(makeApp()).post("/api/resources").send(LINK_BODY).expect(201);
    expect(create).toHaveBeenCalledWith({ data: LINK_BODY });
  });

  it("keeps a plain gated create byte-identical to before", async () => {
    await request(makeApp())
      .post("/api/resources")
      .send({ id: RESOURCE_ID, name: "Guide name", description: null })
      .expect(201);
    expect(create).toHaveBeenCalledWith({ data: { id: RESOURCE_ID, name: "Guide name", description: null } });
  });

  it("refuses a link to another site", async () => {
    const response = await request(makeApp())
      .post("/api/resources")
      .send({ ...LINK_BODY, linkUrl: "https://evil.example/x" })
      .expect(400);
    expect(response.body).toEqual({ error: "link_url_host_not_allowed" });
    expect(create).not.toHaveBeenCalled();
  });

  it("validates a PATCH against what is stored", async () => {
    findUnique.mockResolvedValue(STORED_GATED);
    const response = await request(makeApp())
      .patch(`/api/resources/${RESOURCE_ID}`)
      .send({ deliveryMode: "link" })
      .expect(400);
    expect(response.body).toEqual({ error: "link_url_required" });
    expect(updateResource).not.toHaveBeenCalled();
  });

  it("saves a complete switch to link", async () => {
    findUnique.mockResolvedValue(STORED_GATED);
    updateResource.mockResolvedValue({ id: RESOURCE_ID });
    await request(makeApp())
      .patch(`/api/resources/${RESOURCE_ID}`)
      .send({ deliveryMode: "link", linkUrl: "https://mycuratedhaven.com/halloween", linkButtonLabel: "Open the recipes" })
      .expect(200);
    expect(updateResource).toHaveBeenCalledWith({
      where: { id: RESOURCE_ID },
      data: { deliveryMode: "link", linkUrl: "https://mycuratedhaven.com/halloween", linkButtonLabel: "Open the recipes" },
    });
  });

  it("renames without reading the stored link fields", async () => {
    updateResource.mockResolvedValue({ id: RESOURCE_ID });
    await request(makeApp()).patch(`/api/resources/${RESOURCE_ID}`).send({ name: "New name" }).expect(200);
    expect(findUnique).not.toHaveBeenCalled();
    expect(updateResource).toHaveBeenCalledWith({ where: { id: RESOURCE_ID }, data: { name: "New name" } });
  });

  it("refuses to delete a guide that has sent links", async () => {
    countLinkSends.mockResolvedValue(1);
    const response = await request(makeApp()).delete(`/api/resources/${RESOURCE_ID}`).expect(409);
    expect(response.body).toEqual({ error: "resource_has_link_history" });
  });
});
```

Run: `npx vitest run src/api/resources.routes.test.ts`. Expected: the new tests FAIL. If "renames without reading" fails only because `findUnique` was called by an earlier test, add `findUnique.mockReset()` to `beforeEach`.

- [ ] **Step 2: Implement the resources route changes**

In `src/api/resources.routes.ts`:

(a) Add imports:

```ts
import { env } from "../config/env.js";
import { parseAllowedHosts, validateLinkGuideFields } from "../services/linkGuidePolicy.js";
```

(b) Replace the schema block (`const createSchema = ...` through `const updateSchema = ...`) with:

```ts
/**
 * Link-guide fields. Zod only bounds the size; the real rules (https, allowed host,
 * code-point limits) live in validateLinkGuideFields, shared with the sender.
 */
const linkFields = {
  deliveryMode: z.enum(["gated", "link"]).optional(),
  linkUrl: z.string().trim().max(2048).nullish(),
  linkButtonLabel: z.string().trim().max(64).nullish(),
  linkCardTitle: z.string().trim().max(256).nullish(),
  linkCardSubtitle: z.string().trim().max(256).nullish(),
};

const createSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  ...linkFields,
});
const updateSchema = createSchema.omit({ id: true }).partial();

const STORED_LINK_FIELDS = {
  deliveryMode: true,
  linkUrl: true,
  linkButtonLabel: true,
  linkCardTitle: true,
  linkCardSubtitle: true,
} as const;

const NEW_GUIDE_LINK_FIELDS = {
  deliveryMode: "gated" as const,
  linkUrl: null,
  linkButtonLabel: null,
  linkCardTitle: null,
  linkCardSubtitle: null,
};

/** Only the link fields the request actually sent; an empty string clears a field. */
function sentLinkFields(data: z.infer<typeof updateSchema>) {
  return {
    ...(data.deliveryMode !== undefined && { deliveryMode: data.deliveryMode }),
    ...(data.linkUrl !== undefined && { linkUrl: data.linkUrl || null }),
    ...(data.linkButtonLabel !== undefined && { linkButtonLabel: data.linkButtonLabel || null }),
    ...(data.linkCardTitle !== undefined && { linkCardTitle: data.linkCardTitle || null }),
    ...(data.linkCardSubtitle !== undefined && { linkCardSubtitle: data.linkCardSubtitle || null }),
  };
}

const allowedHosts = () => parseAllowedHosts(env.LINK_GUIDE_ALLOWED_HOSTS);
```

`RESOURCE_REPLAY_KEYS` stays `["name", "description"]`.

(c) In `POST /`, replace

```ts
  const data = { ...parsed.data, description: parsed.data.description ?? null };
```

with

```ts
  const link = sentLinkFields(parsed.data);
  const linkError = validateLinkGuideFields({ ...NEW_GUIDE_LINK_FIELDS, ...link }, allowedHosts());
  if (linkError) return res.status(400).json({ error: linkError });
  // Link keys are added only when sent, so a plain gated create is unchanged.
  const data = {
    id: parsed.data.id,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    ...link,
  };
```

(d) Replace the body of `PATCH /:id` with:

```ts
resourcesRouter.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const link = sentLinkFields(parsed.data);
  // Validate the guide as it WOULD be after this write, so turning on Link without a
  // URL fails here rather than at the parent's comment.
  if (Object.keys(link).length > 0) {
    const stored = await prisma.resource.findUnique({
      where: { id: req.params.id },
      select: STORED_LINK_FIELDS,
    });
    if (!stored) return res.status(404).json({ error: "not_found" });
    const linkError = validateLinkGuideFields({ ...stored, ...link }, allowedHosts());
    if (linkError) return res.status(400).json({ error: linkError });
  }
  const { name, description } = parsed.data;
  const updated = await prisma.resource.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...link,
    },
  });
  res.json(updated);
});
```

(e) In `DELETE /:id`, directly after the `resource_has_guide_access_history` guard, add:

```ts
  /**
   * A link send is history for the same reason: it records that a real parent was sent
   * this guide's link and whether they tapped it. Without this guard, deleting the
   * guide's keywords would cascade the click history away and then let the delete through.
   */
  const linkHistoryCount = await prisma.guideLinkSend.count({ where: { resourceId: id } });
  if (linkHistoryCount > 0) {
    return res.status(409).json({ error: "resource_has_link_history" });
  }
```

- [ ] **Step 3: Keywords and conversations**

In `src/api/keywords.routes.ts`, change the `GET /` include's resource select (line ~67) to:

```ts
      resource: { select: { id: true, name: true, deliveryMode: true, _count: { select: { messages: true } } } },
```

Then run `grep -n "_count: { select: { messages: true } }" src/api/keywords.routes.test.ts`. If that file exists and an assertion pins the include, add `deliveryMode: true` to it the same way, and `git add` the test file in Step 5 too.

In `src/api/conversations.routes.ts`, change the list filter to:

```ts
  state: z.enum(["awaiting_done", "completed", "expired", "link_sent"]).optional(),
```

- [ ] **Step 4: Run the API tests and typecheck**

```bash
npx vitest run src/api
```

Expected: PASS.

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/api/resources.routes.ts src/api/resources.routes.test.ts src/api/keywords.routes.ts src/api/conversations.routes.ts
git commit -m "feat: accept and validate link guide fields in the API"
```

---
### Task 13: Funnels: exclude link guides from the gated funnel, add the link funnel

**Files:**
- Create: `src/services/funnels/linkClickFunnel.ts`
- Test: `src/services/funnels/linkClickFunnel.test.ts` (pure)
- Test: `src/services/funnels/linkClickFunnelContract.test.ts` (real Postgres)
- Modify:
  - `src/services/funnels/guideFollowFunnel.ts`
  - `src/services/funnels/dropOff.ts`
  - `src/services/funnels/runFunnel.ts`
  - `src/services/funnels/registry.ts`
  - `src/api/funnels.routes.ts`
  - `docs/funnels.md`
- Test: `src/services/funnels/guideFollowFunnel.test.ts`

**Interfaces:**
- Consumes:
  - The `keyword_matched.deliveryMode` payload from Tasks 9–10.
  - The `guide_link_send` and `guide_link_click` tables.
  - `FunnelDef`, `guardedRate` and `toStageCounts` from `./types.js`.
- Produces:
  - `linkClickDef` (key `"link-click"`)
  - `LINK_CLICK_COHORT_SQL`
  - `LinkClickRow`
  - `LinkClickResult`
  - `summarizeLinkClick(rows, window, minSample)`
  - `fetchLinkClickRows(db, window)`
  - `runLinkClickFunnel(db, window, minSample)`
  - `GET /api/funnels/link-click?from=&to=`

- [ ] **Step 1: Write the failing summarizer test**

```ts
// src/services/funnels/linkClickFunnel.test.ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { summarizeLinkClick, type LinkClickRow } from "./linkClickFunnel.js";

const WINDOW = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" };

function row(patch: Partial<LinkClickRow>): LinkClickRow {
  return {
    conversationId: randomUUID(),
    mediaId: "reel-a",
    linkSent: true,
    clicked: false,
    rechecked: false,
    followsNow: null,
    ...patch,
  };
}

describe("summarizeLinkClick", () => {
  it("reports click rate over links sent, and each reel, busiest first", () => {
    const rows = [
      ...Array.from({ length: 6 }, () => row({ mediaId: "reel-a", clicked: true })),
      ...Array.from({ length: 4 }, () => row({ mediaId: "reel-a" })),
      ...Array.from({ length: 2 }, () => row({ mediaId: "reel-b", linkSent: false })),
    ];

    const result = summarizeLinkClick(rows, WINDOW, 5);

    expect(result.cohortSize).toBe(12);
    expect(result.stages.map((stage) => [stage.key, stage.count])).toEqual([
      ["entered", 12],
      ["linkSent", 10],
      ["clicked", 6],
      ["followingMeasured", 0],
    ]);
    expect(result.headline.rate).toEqual({ numerator: 6, denominator: 10, pct: 60, belowMinSample: false });
    expect(result.byReel).toEqual([
      {
        mediaId: "reel-a",
        entered: 10,
        linkSent: 10,
        clicked: 6,
        clickRate: { numerator: 6, denominator: 10, pct: 60, belowMinSample: false },
      },
      {
        mediaId: "reel-b",
        entered: 2,
        linkSent: 0,
        clicked: 0,
        clickRate: { numerator: 0, denominator: 0, pct: null, belowMinSample: true },
      },
    ]);
  });

  it("measures followed-anyway among rechecked clickers only", () => {
    const rows = [
      row({ clicked: true, rechecked: true, followsNow: true }),
      row({ clicked: true, rechecked: true, followsNow: false }),
      row({ clicked: true, rechecked: false, followsNow: true }),
      row({ clicked: false, rechecked: true, followsNow: true }),
    ];
    expect(summarizeLinkClick(rows, WINDOW, 1).followedAnyway).toEqual({
      numerator: 1,
      denominator: 2,
      pct: 50,
      belowMinSample: false,
    });
  });

  it("withholds a rate below the minimum sample", () => {
    const result = summarizeLinkClick([row({ clicked: true })], WINDOW, 5);
    expect(result.headline.rate.pct).toBeNull();
    expect(result.headline.rate.belowMinSample).toBe(true);
  });
});
```

Run: `npx vitest run src/services/funnels/linkClickFunnel.test.ts`. Expected: FAIL, the module is missing.

- [ ] **Step 2: Write `linkClickFunnel.ts`**

```ts
// src/services/funnels/linkClickFunnel.ts
import {
  type FunnelDef,
  type FunnelHeadline,
  type FunnelStageCount,
  type GuardedRate,
  guardedRate,
  toStageCounts,
} from "./types.js";

export const LINK_CLICK_MIN_SAMPLE = 5;

export const linkClickDef: FunnelDef = {
  key: "link-click",
  name: "Comment → link click",
  question: "Of the people who ask for a link guide, how many open the page, and which reels send the most?",
  headline: {
    fromStage: "linkSent",
    toStage: "clicked",
    label: "Click rate",
    rationale:
      "A link guide has no follow step, so the only loss after the message is a parent who never taps the button. This is the number the link pilot is judged on.",
  },
  minSample: LINK_CLICK_MIN_SAMPLE,
  stages: [
    {
      key: "entered",
      label: "Asked for a link guide",
      definition:
        "Commented or messaged a keyword whose guide is set to Link. Counted once per conversation on its first keyword_matched inside the window.",
    },
    {
      key: "linkSent",
      label: "Got the link",
      definition:
        "Meta accepted the link message, on the first try or a retry. A parent whose settings block messages, or whose send kept failing, does not count.",
    },
    {
      key: "clicked",
      label: "Opened the page",
      definition:
        "Tapped the button at least once from a real browser. Link-preview bots and HEAD requests are recorded but never count here.",
    },
    {
      key: "followingMeasured",
      label: "Following (first reading)",
      definition:
        "Of the parents who opened the page, measured as following when the recheck worker read them about 3 days later. Nobody was asked to follow first.",
      coverageOnly: true,
    },
  ],
};

/** One row per conversation in the cohort. Shape returned by LINK_CLICK_COHORT_SQL. */
export interface LinkClickRow {
  conversationId: string;
  mediaId: string | null;
  linkSent: boolean;
  clicked: boolean;
  rechecked: boolean;
  followsNow: boolean | null;
}

/**
 * Parameters: $1 from (timestamptz, inclusive), $2 to (exclusive). Read-only.
 * Reads event_log, conversations, ig_users, guide_link_send and guide_link_click.
 */
export const LINK_CLICK_COHORT_SQL = `
WITH cohort AS (
  SELECT
    (e.payload->>'conversationId')::uuid AS conversation_id,
    MIN(e.payload->>'mediaId')           AS media_id
  FROM event_log e
  WHERE e.kind = 'keyword_matched'
    AND e.payload->>'deliveryMode' = 'link'
    AND e.created_at >= $1::timestamptz
    AND e.created_at <  $2::timestamptz
    AND e.payload->>'conversationId' IS NOT NULL
  GROUP BY 1
)
SELECT
  co.conversation_id::text AS "conversationId",
  co.media_id              AS "mediaId",
  EXISTS (
    SELECT 1 FROM guide_link_send s
    WHERE s.conversation_id = co.conversation_id AND s.status = 'sent'
  )                        AS "linkSent",
  EXISTS (
    SELECT 1 FROM guide_link_send s
    JOIN guide_link_click k ON k.send_id = s.id
    WHERE s.conversation_id = co.conversation_id AND k.is_bot = false
  )                        AS "clicked",
  (c.follow_rechecked_at IS NOT NULL) AS "rechecked",
  u.is_follower            AS "followsNow"
FROM cohort co
JOIN conversations c ON c.id = co.conversation_id
LEFT JOIN ig_users u ON u.id = c.ig_user_id
ORDER BY co.conversation_id
`.trim();

export interface LinkClickReelBreakdown {
  mediaId: string | null;
  entered: number;
  linkSent: number;
  clicked: number;
  clickRate: GuardedRate;
}

export interface LinkClickResult {
  key: string;
  name: string;
  question: string;
  window: { from: string; to: string };
  cohortSize: number;
  stages: FunnelStageCount[];
  headline: FunnelHeadline & { rate: GuardedRate };
  /** Following at the ~3-day recheck, among clickers the worker has read. */
  followedAnyway: GuardedRate;
  byReel: LinkClickReelBreakdown[];
}

/** Pure summarizer. No database, no clock: everything comes from `rows`. */
export function summarizeLinkClick(
  rows: LinkClickRow[],
  window: { from: string; to: string },
  minSample: number = LINK_CLICK_MIN_SAMPLE,
): LinkClickResult {
  const counts: Record<string, number> = {
    entered: rows.length,
    linkSent: rows.filter((r) => r.linkSent).length,
    clicked: rows.filter((r) => r.clicked).length,
    followingMeasured: rows.filter((r) => r.clicked && r.rechecked && r.followsNow === true).length,
  };
  const recheckedClickers = rows.filter((r) => r.clicked && r.rechecked).length;

  const reels = new Map<string | null, { entered: number; linkSent: number; clicked: number }>();
  for (const r of rows) {
    const reel = reels.get(r.mediaId) ?? { entered: 0, linkSent: 0, clicked: 0 };
    reel.entered += 1;
    if (r.linkSent) reel.linkSent += 1;
    if (r.clicked) reel.clicked += 1;
    reels.set(r.mediaId, reel);
  }
  const byReel = [...reels.entries()]
    .map(([mediaId, reel]) => ({
      mediaId,
      ...reel,
      clickRate: guardedRate(reel.clicked, reel.linkSent, minSample),
    }))
    .sort((a, b) => b.clicked - a.clicked || b.entered - a.entered || String(a.mediaId).localeCompare(String(b.mediaId)));

  return {
    key: linkClickDef.key,
    name: linkClickDef.name,
    question: linkClickDef.question,
    window,
    cohortSize: rows.length,
    stages: toStageCounts(linkClickDef.stages, counts),
    headline: { ...linkClickDef.headline, rate: guardedRate(counts.clicked!, counts.linkSent!, minSample) },
    followedAnyway: guardedRate(counts.followingMeasured!, recheckedClickers, minSample),
    byReel,
  };
}
```

Run the Step 1 test again. Expected: PASS.

- [ ] **Step 3: Runner, registry and route**

In `src/services/funnels/runFunnel.ts`, add the import and two functions:

```ts
import {
  LINK_CLICK_COHORT_SQL,
  LINK_CLICK_MIN_SAMPLE,
  summarizeLinkClick,
  type LinkClickResult,
  type LinkClickRow,
} from "./linkClickFunnel.js";

export async function fetchLinkClickRows(db: FunnelDb, window: FunnelWindow): Promise<LinkClickRow[]> {
  // $queryRawUnsafe because the statement is a module constant; the values are bound.
  return db.$queryRawUnsafe<LinkClickRow[]>(
    LINK_CLICK_COHORT_SQL,
    window.from.toISOString(),
    window.to.toISOString(),
  );
}

export async function runLinkClickFunnel(
  db: FunnelDb,
  window: FunnelWindow = defaultWindow(),
  minSample: number = LINK_CLICK_MIN_SAMPLE,
): Promise<LinkClickResult> {
  const rows = await fetchLinkClickRows(db, window);
  return summarizeLinkClick(rows, { from: window.from.toISOString(), to: window.to.toISOString() }, minSample);
}
```

In `src/services/funnels/registry.ts`, import `linkClickDef` from `./linkClickFunnel.js` and register it:

```ts
export const FUNNELS: Record<string, FunnelDef> = {
  [guideFollowDef.key]: guideFollowDef,
  [linkClickDef.key]: linkClickDef,
};
```

In `src/api/funnels.routes.ts`:

(a) Add `runLinkClickFunnel` to the `../services/funnels/runFunnel.js` import. Add these imports:

```ts
import { guideFollowDef } from "../services/funnels/guideFollowFunnel.js";
import { linkClickDef, type LinkClickResult } from "../services/funnels/linkClickFunnel.js";
```

(b) After `funnelCache`, add:

```ts
/** Separate cache: the two funnels return different shapes. */
export const linkClickCache = createReadThroughCache<LinkClickResult>({
  ttlMs: FUNNEL_CACHE_TTL_MS,
  maxEntries: 32,
});
```

(c) In `GET /:key`, replace the final `res.json(await funnelCache.get(...))` block (and its `// Only one funnel so far` comment) with:

```ts
  if (def.key === linkClickDef.key) {
    res.json(
      await linkClickCache.get(funnelCacheKey(def.key, window, def.minSample), () =>
        runLinkClickFunnel(prisma, window, def.minSample),
      ),
    );
    return;
  }
  res.json(
    await funnelCache.get(funnelCacheKey(def.key, window, def.minSample), () =>
      runGuideFollowFunnel(prisma, window, def.minSample),
    ),
  );
```

(d) In `GET /:key/drop-off/:bucket`, directly after the `if (!def) { ... }` block, add:

```ts
  // Drop-off lists are built on the guide-follow cohort only.
  if (def.key !== guideFollowDef.key) {
    res.status(404).json({ error: "no_drop_off_for_funnel" });
    return;
  }
```

- [ ] **Step 4: Keep link guides out of the gated cohorts**

In `src/services/funnels/guideFollowFunnel.ts`, in `COHORT_SQL`'s `cohort` CTE, add this line directly after `WHERE e.kind = 'keyword_matched'`:

```sql
    AND COALESCE(e.payload->>'deliveryMode', 'gated') <> 'link'
```

In `src/services/funnels/dropOff.ts`, add the same line in the same place (its `cohort` CTE, directly after `WHERE e.kind = 'keyword_matched'`).

In `src/services/funnels/guideFollowFunnel.test.ts`, add `COHORT_SQL` to the existing import from `./guideFollowFunnel.js` if it isn't there, and add:

```ts
describe("guide-follow cohort", () => {
  it("leaves link guides out of the gated funnel", () => {
    expect(COHORT_SQL).toContain("COALESCE(e.payload->>'deliveryMode', 'gated') <> 'link'");
  });
});
```

- [ ] **Step 5: Write the funnel contract test**

```ts
// src/services/funnels/linkClickFunnelContract.test.ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchGuideFollowRows, fetchLinkClickRows } from "./runFunnel.js";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID().slice(0, 8).toUpperCase();
const ids = { resource: randomUUID(), keyword: randomUUID(), clicked: randomUUID(), botOnly: randomUUID() };
const window = { from: new Date(Date.now() - 60 * 60 * 1000), to: new Date(Date.now() + 60 * 60 * 1000) };
let db: PrismaClient;

beforeAll(async () => {
  if (!databaseUrl) return;
  expect(process.env.DATABASE_URL).toBe(databaseUrl);
  expect(process.env.MIGRATION_TEST_DATABASE_DISPOSABLE).toBe("true");
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.resource.create({
    data: {
      id: ids.resource,
      name: `Funnel link ${suffix}`,
      deliveryMode: "link",
      linkUrl: "https://mycuratedhaven.com/halloween",
      linkButtonLabel: "Open the recipes",
    },
  });
  await db.keyword.create({
    data: { id: ids.keyword, keyword: `FNL${suffix}`, resourceId: ids.resource, publicReply: "x", gateMessage: "x", mediaId: `reel-${suffix}` },
  });
  for (const [conversationId, state, humanClick] of [
    [ids.clicked, "completed", true],
    [ids.botOnly, "link_sent", false],
  ] as const) {
    await db.conversation.create({
      data: { id: conversationId, igUserId: `ig-${suffix}-${state}`, keywordId: ids.keyword, state },
    });
    await db.eventLog.create({
      data: {
        kind: "keyword_matched",
        payload: { conversationId, keyword: `FNL${suffix}`, mediaId: `reel-${suffix}`, deliveryMode: "link" },
      },
    });
    const send = await db.guideLinkSend.create({
      data: {
        token: randomUUID().replace(/-/g, "").slice(0, 11),
        conversationId,
        resourceId: ids.resource,
        keywordId: ids.keyword,
        mediaId: `reel-${suffix}`,
        igUserId: `ig-${suffix}-${state}`,
        channel: "private_reply",
        shape: "card",
        status: "sent",
        sentAt: new Date(),
      },
    });
    await db.guideLinkClick.create({
      data: { sendId: send.id, destinationUrl: "https://mycuratedhaven.com/halloween", isBot: true, uaFamily: "meta_preview" },
    });
    if (humanClick) {
      await db.guideLinkClick.create({
        data: { sendId: send.id, destinationUrl: "https://mycuratedhaven.com/halloween", isBot: false, uaFamily: "instagram_app" },
      });
    }
  }
});

afterAll(async () => {
  if (!databaseUrl) return;
  await db.eventLog.deleteMany({
    where: { kind: "keyword_matched", payload: { path: ["keyword"], equals: `FNL${suffix}` } },
  });
  await db.conversation.deleteMany({ where: { keywordId: ids.keyword } });
  await db.keyword.deleteMany({ where: { id: ids.keyword } });
  await db.resource.deleteMany({ where: { id: ids.resource } });
  await db.$disconnect();
});

describeWithDatabase("link click funnel SQL", () => {
  it("counts a human tap and ignores a send that only a bot opened", async () => {
    const rows = (await fetchLinkClickRows(db, window)).filter((row) =>
      [ids.clicked, ids.botOnly].includes(row.conversationId),
    );
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: ids.clicked, mediaId: `reel-${suffix}`, linkSent: true, clicked: true }),
        expect.objectContaining({ conversationId: ids.botOnly, mediaId: `reel-${suffix}`, linkSent: true, clicked: false }),
      ]),
    );
  });

  it("keeps link guides out of the guide → follow cohort", async () => {
    const conversationIds = (await fetchGuideFollowRows(db, window)).map((row) => row.conversationId);
    expect(conversationIds).not.toContain(ids.clicked);
    expect(conversationIds).not.toContain(ids.botOnly);
  });
});
```

- [ ] **Step 6: Document the funnel**

In `docs/funnels.md`:
- Change the read-only grant line to:

  ```sql
  GRANT SELECT ON event_log, conversations, ig_users, keywords, guide_link_send, guide_link_click TO funnel_readonly;
  ```

- Append this section:

```markdown
## Comment → link click (`link-click`)

The link-guide funnel. Its cohort is `keyword_matched` events carrying `deliveryMode: "link"`. Those same events are excluded from `guide-follow` and its drop-off lists, so the gated baseline is never diluted.

| Stage | Source |
|---|---|
| `entered` | First `keyword_matched` per conversation in the window |
| `linkSent` | A `guide_link_send` row with `status = 'sent'` (first try or retry) |
| `clicked` | A `guide_link_click` row with `is_bot = false` |
| `followingMeasured` | Clicked, rechecked by `followRecheckWorker` (~3 days after the tap completed the conversation), and following. Coverage only |

The headline is the click rate (`clicked / linkSent`). `followedAnyway` is following among rechecked clickers, the number that prices moving more recipes to links. Both writers are real code: `guide_link_send` is written by the link sender, and `guide_link_click` by `GET /r/:token`. `linkClickFunnelContract.test.ts` runs the SQL against rows from both.
```

- [ ] **Step 7: Run everything for this task**

```bash
npx vitest run src/services/funnels src/api/funnels.routes.test.ts
```

Expected: PASS. If `src/api/funnels.routes.test.ts` doesn't exist, vitest runs the funnels folder alone.

```bash
MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract npx vitest run src/services/funnels/linkClickFunnelContract.test.ts
```

Expected: PASS.

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/services/funnels src/api/funnels.routes.ts docs/funnels.md
git commit -m "feat: add link click funnel and exclude link guides from guide-follow"
```

---
### Task 14: Console: types and the "After they comment" switch

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/automationCopy.ts`
- Modify: `web/src/components/KeywordForm.tsx`
- Modify: `web/src/pages/Conversations.tsx` (the new state's label)
- Test: `web/src/components/KeywordForm.test.tsx`

**Interfaces:**
- Consumes: the Task 12 API.
- Produces:
  - Web types:
    - `DeliveryMode = "gated" | "link"`
    - optional `Resource.deliveryMode` and the link fields
    - `Keyword.resource.deliveryMode?`
    - `ConversationState` now includes `"link_sent"`
  - `DEFAULT_LINK_PUBLIC_REPLY`

- [ ] **Step 0: Make sure web dependencies resolve in this worktree**

```bash
ls web/node_modules/.bin/vitest
```

If that fails, link the main checkout's install (it is gitignored, so never delete it):

```bash
ln -s /Users/pratik.nandoskar/Documents/working/mch/insta-automation/web/node_modules web/node_modules
```

- [ ] **Step 1: Update the web types and copy**

In `web/src/lib/types.ts`, change `ConversationState` and `Resource`, and add `DeliveryMode`:

```ts
export type ConversationState = "awaiting_done" | "completed" | "expired" | "link_sent";
export type DeliveryMode = "gated" | "link";

export interface Resource {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  // Optional so fixtures written before link guides still type-check. Absent means gated.
  deliveryMode?: DeliveryMode;
  linkUrl?: string | null;
  linkButtonLabel?: string | null;
  linkCardTitle?: string | null;
  linkCardSubtitle?: string | null;
  _count?: { messages: number; keywords: number };
  invalidMessageCount?: number;
}
```

In the same file, change `Keyword.resource` to:

```ts
  resource?: { id: string; name: string; deliveryMode?: DeliveryMode; _count: { messages: number } };
```

In `web/src/lib/automationCopy.ts`, add:

```ts
export const DEFAULT_LINK_PUBLIC_REPLY = "Sent you the recipes 💛 Check your DMs (and Requests)!";
```

In `web/src/pages/Conversations.tsx`, `stateMeta` is a `Record<ConversationState, ...>`, so the new state must have an entry or the web typecheck fails. Add `Link2` to the file's existing `lucide-react` import, then add to `stateMeta`:

```tsx
  link_sent: { label: "Link sent", tone: "text-signal bg-signal-soft", Icon: Link2 },
```

Then read `summaryLine` (around lines 560–600). If its if/else chain falls through to the awaiting-reply wording for any state it doesn't name, add this branch before that fall-through:

```tsx
  if (c.state === "link_sent") return "Link sent — waiting for a tap";
```

- [ ] **Step 2: Write the failing form tests**

In `web/src/components/KeywordForm.test.tsx`:

(a) Change `renderForm` so it takes the guides list:

```tsx
function renderForm(resources: Resource[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <KeywordForm initial={null} resources={resources} onClose={vi.fn()} mediaContext={MEDIA} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
```

and add `import type { Resource } from "@/lib/types";`.

(b) Append:

```tsx
describe("KeywordForm link guides", () => {
  const URL_PLACEHOLDER = "https://mycuratedhaven.com/halloween";

  async function chooseLink() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Link to a page/ }));
    return user;
  }

  it("creates a link guide and its keyword, with no gate message field", async () => {
    apiMutation.mockImplementation((path: string) =>
      Promise.resolve(
        String(path) === "/resources" ? { id: "res-link" } : { id: "kw-1", resourceId: "res-link" },
      ),
    );
    renderForm();
    const user = await chooseLink();

    expect(screen.queryByPlaceholderText("Reply DONE and I'll send your guide!")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("RECIPE"), { target: { value: "GHOST" } });
    fireEvent.change(screen.getByPlaceholderText("Halloween collection"), {
      target: { value: "Halloween collection" },
    });
    fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), {
      target: { value: "https://mycuratedhaven.com/halloween" },
    });
    await user.click(screen.getByRole("button", { name: "Create keyword" }));

    await waitFor(() => expect(callsTo("/keywords").length).toBe(1));
    expect(bodyOf(callsTo("/resources")[0]!)).toMatchObject({
      name: "Halloween collection",
      deliveryMode: "link",
      linkUrl: "https://mycuratedhaven.com/halloween",
      linkButtonLabel: "Open the recipes",
    });
    expect(bodyOf(callsTo("/keywords")[0]!)).toMatchObject({
      keyword: "GHOST",
      resourceId: "res-link",
      publicReply: "Sent you the recipes 💛 Check your DMs (and Requests)!",
    });
  });

  it("blocks a link that is not https", async () => {
    renderForm();
    await chooseLink();
    fireEvent.change(screen.getByPlaceholderText("RECIPE"), { target: { value: "GHOST" } });
    fireEvent.change(screen.getByPlaceholderText("Halloween collection"), {
      target: { value: "Halloween collection" },
    });
    fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), {
      target: { value: "http://mycuratedhaven.com/halloween" },
    });

    expect(screen.getByRole("button", { name: "Create keyword" })).toBeDisabled();
  });

  it("only offers link guides once Link is chosen", async () => {
    const createdAt = "2026-10-01T00:00:00.000Z";
    renderForm([
      { id: "g1", name: "Sleep guide", description: null, createdAt, deliveryMode: "gated" },
      { id: "l1", name: "Halloween collection", description: null, createdAt, deliveryMode: "link" },
    ]);
    const user = await chooseLink();
    await user.click(screen.getByRole("button", { name: /Use existing/ }));

    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options.some((text) => text?.includes("Halloween collection"))).toBe(true);
    expect(options.some((text) => text?.includes("Sleep guide"))).toBe(false);
  });
});
```

Run: `cd web && npx vitest run src/components/KeywordForm.test.tsx`. Expected: the 3 new tests FAIL. The existing tests still pass.

- [ ] **Step 3: Edit `web/src/components/KeywordForm.tsx`**

(a) Imports. Replace the two existing lines:

```tsx
import { DEFAULT_LINK_PUBLIC_REPLY, DEFAULT_PUBLIC_REPLY } from "@/lib/automationCopy";
import type { DeliveryMode, Keyword, MediaKind, MediaPage, Resource } from "@/lib/types";
```

(b) Replace `interface KeywordFormState` and `emptyForm` with:

```tsx
interface KeywordFormState {
  keyword: string;
  deliveryMode: DeliveryMode;
  sequenceMode: SequenceMode;
  newSequenceName: string;
  newLinkUrl: string;
  newLinkButtonLabel: string;
  resourceId: string;
  publicReply: string;
  gateMessage: string;
  active: boolean;
}

/** Stored on a link keyword because the column is required. Link guides never send it. */
const LINK_GATE_MESSAGE_PLACEHOLDER = "Link guide: this keyword sends a link, not a gate message.";
const DEFAULT_LINK_BUTTON_LABEL = "Open the recipes";
const LINK_BUTTON_LABEL_MAX = 20;

function defaultPublicReply(mode: DeliveryMode): string {
  return mode === "link" ? DEFAULT_LINK_PUBLIC_REPLY : DEFAULT_PUBLIC_REPLY;
}

const emptyForm: KeywordFormState = {
  keyword: "",
  deliveryMode: "gated",
  sequenceMode: "new",
  newSequenceName: "",
  newLinkUrl: "",
  newLinkButtonLabel: DEFAULT_LINK_BUTTON_LABEL,
  resourceId: "",
  publicReply: DEFAULT_PUBLIC_REPLY,
  gateMessage: "Reply DONE to receive your guide.",
  active: true,
};
```

(c) In the `initial ? { ... }` state initializer, add after `keyword: initial.keyword,`:

```tsx
          deliveryMode: resources.find((r) => r.id === initial.resourceId)?.deliveryMode ?? "gated",
```

and after `newSequenceName: "",`:

```tsx
          newLinkUrl: "",
          newLinkButtonLabel: DEFAULT_LINK_BUTTON_LABEL,
```

(d) After the `useOperationId` lines, add:

```tsx
  const isLink = form.deliveryMode === "link";
  const modeResources = useMemo(
    () => resources.filter((r) => (r.deliveryMode ?? "gated") === form.deliveryMode),
    [resources, form.deliveryMode],
  );
  // Link guides never send this, but the column is required.
  const gateMessageToSave = isLink ? (initial?.gateMessage ?? LINK_GATE_MESSAGE_PLACEHOLDER) : form.gateMessage;
```

(e) In `mutationFn`, replace both `gateMessage: form.gateMessage,` with `gateMessage: gateMessageToSave,`. Replace the `/resources` POST body with:

```tsx
          body: JSON.stringify({
            id: newSequenceId,
            name: form.newSequenceName.trim(),
            description: null,
            ...(isLink && {
              deliveryMode: "link",
              linkUrl: form.newLinkUrl.trim(),
              linkButtonLabel: form.newLinkButtonLabel.trim(),
            }),
          }),
```

(f) In `onSuccess`, change `if (createdSequence) {` to `if (createdSequence && !isLink) {`. A new link guide has no steps to add.

(g) Replace the validation block (`const sequenceValid = ...` through `const canSave = ...`) with:

```tsx
  const linkLabelLength = [...form.newLinkButtonLabel.trim()].length;
  const newLinkValid =
    /^https:\/\/\S+$/.test(form.newLinkUrl.trim()) &&
    linkLabelLength >= 1 &&
    linkLabelLength <= LINK_BUTTON_LABEL_MAX;

  const sequenceValid = initial
    ? form.resourceId.length > 0
    : form.sequenceMode === "new"
      ? form.newSequenceName.trim().length > 0 && (!isLink || newLinkValid)
      : form.resourceId.length > 0;

  const keywordValid = KEYWORD_PHRASE.test(form.keyword.trim());

  const canSave =
    keywordValid &&
    sequenceValid &&
    form.publicReply.trim().length > 0 &&
    (isLink || form.gateMessage.trim().length > 0) &&
    !saveMutation.isPending;
```

(h) In the JSX, directly after the Keyword `<Field>`, add:

```tsx
        <DeliveryModeSwitch
          value={form.deliveryMode}
          onChange={(mode) =>
            setForm((f) => ({
              ...f,
              deliveryMode: mode,
              resourceId: "",
              // Swap the default reply only if it's still the other mode's default.
              publicReply:
                f.publicReply === defaultPublicReply(f.deliveryMode) ? defaultPublicReply(mode) : f.publicReply,
            }))
          }
        />
```

(i) In the guide section:
- Change `<Label>Guide</Label>` to `<Label>{isLink ? "Link guide" : "Guide"}</Label>`.
- Replace every `resources.map(` and every `resources.length` inside it with `modeResources.map(` and `modeResources.length`. There are two selects and the "Use existing" `ModeButton`.
- Replace the `form.sequenceMode === "new" ? (<Input ... placeholder="Toddler Activity Guide" .../>) : (` branch's first arm with:

```tsx
              {form.sequenceMode === "new" ? (
                isLink ? (
                  <div className="space-y-2">
                    <Input
                      value={form.newSequenceName}
                      onChange={(e) => setForm((f) => ({ ...f, newSequenceName: e.target.value }))}
                      placeholder="Halloween collection"
                      required
                      maxLength={120}
                    />
                    <Input
                      type="url"
                      value={form.newLinkUrl}
                      onChange={(e) => setForm((f) => ({ ...f, newLinkUrl: e.target.value }))}
                      placeholder="https://mycuratedhaven.com/halloween"
                      required
                    />
                    <Input
                      value={form.newLinkButtonLabel}
                      onChange={(e) => setForm((f) => ({ ...f, newLinkButtonLabel: e.target.value }))}
                      placeholder="Open the recipes"
                      required
                    />
                  </div>
                ) : (
                  <Input
                    value={form.newSequenceName}
                    onChange={(e) => setForm((f) => ({ ...f, newSequenceName: e.target.value }))}
                    placeholder="Toddler Activity Guide"
                    required
                    maxLength={120}
                  />
                )
              ) : (
```

- Replace the hint paragraph's text expression with:

```tsx
                {isLink
                  ? form.sequenceMode === "new"
                    ? `Name, page address and button text (up to ${LINK_BUTTON_LABEL_MAX} characters). Only approved site addresses are accepted.`
                    : "Reuse a link guide. Changing its address updates every post that uses it."
                  : form.sequenceMode === "new"
                    ? "We'll create the guide and drop you into the editor to add steps."
                    : "Reuse an existing guide — useful for spelling variations of the same trigger."}
```

(j) Wrap the "Gate DM" `<Field>` in `{!isLink && ( ... )}`.

(k) Change the submit label ternary's last two arms to:

```tsx
              : form.sequenceMode === "new" && !isLink
                ? "Create & add steps"
                : "Create keyword"}
```

(l) Add `aria-pressed={active}` to the `<button>` inside `ModeButton`, and add this component after `ModeButton`:

```tsx
function DeliveryModeSwitch({
  value,
  onChange,
}: {
  value: DeliveryMode;
  onChange: (mode: DeliveryMode) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>After they comment</Label>
      <div className="grid grid-cols-2 gap-2">
        <ModeButton
          active={value === "gated"}
          onClick={() => onChange("gated")}
          title="Gated guide"
          subtitle="Follow first, then the guide"
        />
        <ModeButton
          active={value === "link"}
          onClick={() => onChange("link")}
          title="Link to a page"
          subtitle="A button to our site, no follow"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the web tests, typecheck and lint**

```bash
cd web && npx vitest run src/components/KeywordForm.test.tsx
```

Expected: PASS, both old and new tests.

```bash
cd web && npx tsc -b
```

Expected: exit 0.

```bash
cd web && npm run lint
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/types.ts web/src/lib/automationCopy.ts web/src/components/KeywordForm.tsx web/src/components/KeywordForm.test.tsx web/src/pages/Conversations.tsx
git commit -m "feat: let the creator choose gated or link per post"
```

---
### Task 15: Console: guide page link panel and badges

**Files:**
- Create: `web/src/components/DeliveryBadge.tsx`
- Test: `web/src/components/DeliveryBadge.test.tsx`
- Create: `web/src/features/link-guides/linkGuideErrors.ts`
- Test: `web/src/features/link-guides/linkGuideErrors.test.ts`
- Create: `web/src/features/link-guides/LinkGuidePanel.tsx`
- Test: `web/src/features/link-guides/LinkGuidePanel.test.tsx`
- Modify:
  - `web/src/pages/SequenceEditor.tsx`
  - `web/src/pages/Sequences.tsx`
  - `web/src/pages/Content.tsx`

**Interfaces:**
- Consumes: Task 14's web types and the Task 12 API.
- Produces:
  - `DeliveryBadge({ mode })`
  - `linkSaveError(error): string`
  - `GuideTypeSwitch({ value, onChange, disabled })`
  - `LinkGuidePanel({ resource })`

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/DeliveryBadge.test.tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryBadge } from "./DeliveryBadge";

afterEach(cleanup);

describe("DeliveryBadge", () => {
  it("labels a link guide", () => {
    render(<DeliveryBadge mode="link" />);
    expect(screen.getByText("Link")).toBeInTheDocument();
  });

  it("treats a missing mode as gated", () => {
    render(<DeliveryBadge mode={undefined} />);
    expect(screen.getByText("Gated")).toBeInTheDocument();
  });
});
```

```ts
// web/src/features/link-guides/linkGuideErrors.test.ts
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { linkSaveError } from "./linkGuideErrors";

describe("linkSaveError", () => {
  it("names the rule a rejected link broke", () => {
    expect(linkSaveError(new ApiError(400, { error: "link_url_host_not_allowed" }, "Bad Request"))).toBe(
      "That site isn't on the allowed list.",
    );
    expect(linkSaveError(new ApiError(400, { error: "link_button_label_too_long" }, "Bad Request"))).toBe(
      "Button text can be up to 20 characters.",
    );
  });

  it("falls back to a plain retry message", () => {
    expect(linkSaveError(new Error("offline"))).toBe(
      "Couldn't save the link. Check your connection and try again.",
    );
  });
});
```

```tsx
// web/src/features/link-guides/LinkGuidePanel.test.tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Resource } from "@/lib/types";

const apiMutation = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiMutation: (...a: unknown[]) => apiMutation(...a),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { LinkGuidePanel } = await import("./LinkGuidePanel");

const RESOURCE: Resource = {
  id: "res-1",
  name: "Halloween collection",
  description: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  deliveryMode: "link",
  linkUrl: "https://mycuratedhaven.com/halloween",
  linkButtonLabel: "Open the recipes",
  linkCardTitle: null,
  linkCardSubtitle: null,
};

function renderPanel(resource: Resource = RESOURCE) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LinkGuidePanel resource={resource} />
    </QueryClientProvider>,
  );
}

beforeEach(() => apiMutation.mockReset().mockResolvedValue(RESOURCE));
afterEach(cleanup);

describe("LinkGuidePanel", () => {
  it("saves the link, switching the guide to Link in the same write", async () => {
    const user = userEvent.setup();
    renderPanel({ ...RESOURCE, deliveryMode: "gated", linkUrl: null });
    fireEvent.change(screen.getByPlaceholderText("https://mycuratedhaven.com/halloween"), {
      target: { value: "https://mycuratedhaven.com/thanksgiving" },
    });
    await user.click(screen.getByRole("button", { name: "Save link" }));

    await waitFor(() => expect(apiMutation).toHaveBeenCalledTimes(1));
    const [path, options] = apiMutation.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe("/resources/res-1");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual({
      deliveryMode: "link",
      linkUrl: "https://mycuratedhaven.com/thanksgiving",
      linkButtonLabel: "Open the recipes",
      linkCardTitle: null,
      linkCardSubtitle: null,
    });
  });

  it("won't save an address that isn't https", () => {
    renderPanel();
    fireEvent.change(screen.getByPlaceholderText("https://mycuratedhaven.com/halloween"), {
      target: { value: "http://mycuratedhaven.com/halloween" },
    });
    expect(screen.getByRole("button", { name: "Save link" })).toBeDisabled();
  });

  it("previews the card with the guide name when no title is set", () => {
    renderPanel();
    const preview = screen.getByRole("complementary", { name: "Card preview" });
    expect(preview).toHaveTextContent("Halloween collection");
    expect(preview).toHaveTextContent("Open the recipes");
    expect(preview).toHaveTextContent("Follow @tinysoho");
  });
});
```

Run: `cd web && npx vitest run src/components/DeliveryBadge.test.tsx src/features/link-guides`. Expected: FAIL, the modules are missing.

- [ ] **Step 2: Write the components**

```tsx
// web/src/components/DeliveryBadge.tsx
import { Link2, Lock } from "lucide-react";
import type { DeliveryMode } from "@/lib/types";

/** Gated or Link, wherever a guide is listed. A missing mode is a guide from before links. */
export function DeliveryBadge({ mode }: { mode: DeliveryMode | undefined }) {
  const isLink = mode === "link";
  const Icon = isLink ? Link2 : Lock;
  return (
    <span
      className={
        isLink
          ? "inline-flex items-center gap-1 rounded-full bg-signal-soft px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-signal"
          : "inline-flex items-center gap-1 rounded-full border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
      }
    >
      <Icon className="size-2.5" aria-hidden="true" />
      {isLink ? "Link" : "Gated"}
    </span>
  );
}
```

```ts
// web/src/features/link-guides/linkGuideErrors.ts
import { apiErrorCode } from "@/lib/api";

const LINK_ERRORS: Record<string, string> = {
  link_url_required: "Add the page address.",
  link_url_invalid: "That isn't a web address.",
  link_url_not_https: "Use an address that starts with https://.",
  link_url_host_not_allowed: "That site isn't on the allowed list.",
  link_button_label_required: "Add the button text.",
  link_button_label_too_long: "Button text can be up to 20 characters.",
  link_card_title_too_long: "The card title can be up to 80 characters.",
  link_card_subtitle_too_long: "The card subtitle can be up to 80 characters.",
};

export function linkSaveError(error: unknown): string {
  const code = apiErrorCode(error);
  return (code ? LINK_ERRORS[code] : undefined) ?? "Couldn't save the link. Check your connection and try again.";
}
```

```tsx
// web/src/features/link-guides/LinkGuidePanel.tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { apiMutation } from "@/lib/api";
import type { DeliveryMode, Resource } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { linkSaveError } from "./linkGuideErrors";

const BUTTON_LABEL_MAX = 20;
const CARD_TEXT_MAX = 80;
const FOLLOW_BUTTON_LABEL = "Follow @tinysoho";
const DEFAULT_SUBTITLE = "Tap below to open it.";

export function GuideTypeSwitch({
  value,
  onChange,
  disabled,
}: {
  value: DeliveryMode;
  onChange: (mode: DeliveryMode) => void;
  disabled?: boolean;
}) {
  const options: { mode: DeliveryMode; title: string; subtitle: string }[] = [
    { mode: "gated", title: "Gated", subtitle: "Follow first, then the steps below" },
    { mode: "link", title: "Link", subtitle: "One button to a page, no follow" },
  ];
  return (
    <div className="space-y-2">
      <Label>Guide type</Label>
      <div className="grid max-w-md grid-cols-2 gap-2">
        {options.map((option) => (
          <button
            key={option.mode}
            type="button"
            aria-pressed={value === option.mode}
            disabled={disabled}
            onClick={() => onChange(option.mode)}
            className={cn(
              "rounded-md border bg-card/40 p-3 text-left transition-colors",
              value === option.mode ? "border-foreground/40 bg-accent/40" : "hover:bg-accent/20",
            )}
          >
            <div className="text-sm font-medium">{option.title}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{option.subtitle}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The link guide's settings, with a preview of the card a parent receives. */
export function LinkGuidePanel({ resource }: { resource: Resource }) {
  const qc = useQueryClient();
  const [linkUrl, setLinkUrl] = useState(resource.linkUrl ?? "");
  const [buttonLabel, setButtonLabel] = useState(resource.linkButtonLabel ?? "Open the recipes");
  const [title, setTitle] = useState(resource.linkCardTitle ?? "");
  const [subtitle, setSubtitle] = useState(resource.linkCardSubtitle ?? "");

  const save = useMutation({
    mutationKey: ["sequence-save", resource.id],
    mutationFn: () =>
      apiMutation<Resource>(`/resources/${resource.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          deliveryMode: "link",
          linkUrl: linkUrl.trim(),
          linkButtonLabel: buttonLabel.trim(),
          linkCardTitle: title.trim() || null,
          linkCardSubtitle: subtitle.trim() || null,
        }),
      }),
    onSuccess: () => {
      toast.success("Link saved");
      qc.invalidateQueries({ queryKey: ["resource", resource.id] });
      qc.invalidateQueries({ queryKey: ["resources"] });
    },
    onError: (error) => toast.error(linkSaveError(error)),
  });

  const labelLength = [...buttonLabel.trim()].length;
  const canSave =
    /^https:\/\/\S+$/.test(linkUrl.trim()) &&
    labelLength >= 1 &&
    labelLength <= BUTTON_LABEL_MAX &&
    !save.isPending;
  const previewTitle = title.trim() || resource.name;
  const previewSubtitle = subtitle.trim() || resource.description?.trim() || DEFAULT_SUBTITLE;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        <Field
          label="Page address"
          hint="Parents land here after tapping the button. Changing it also updates links already sent."
        >
          <Input
            type="url"
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.target.value)}
            placeholder="https://mycuratedhaven.com/halloween"
          />
        </Field>
        <Field label="Button text" hint={`${labelLength}/${BUTTON_LABEL_MAX} characters.`}>
          <Input
            value={buttonLabel}
            onChange={(event) => setButtonLabel(event.target.value)}
            placeholder="Open the recipes"
          />
        </Field>
        <Field label="Card title" hint="Optional. Uses the guide name when empty.">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={resource.name}
            maxLength={CARD_TEXT_MAX}
          />
        </Field>
        <Field label="Card subtitle" hint="Optional. Uses the guide description when empty.">
          <Input
            value={subtitle}
            onChange={(event) => setSubtitle(event.target.value)}
            placeholder="8 toddler-friendly recipes, ready to cook"
            maxLength={CARD_TEXT_MAX}
          />
        </Field>
        <Button type="submit" variant="brand" disabled={!canSave}>
          {save.isPending ? "Saving…" : "Save link"}
        </Button>
      </form>

      <aside aria-label="Card preview" className="rounded-lg border border-line bg-card/40 p-4">
        <p className="label-caps">What the parent gets</p>
        <div className="mt-3 overflow-hidden rounded-lg border border-line bg-background">
          <div className="p-3">
            <p className="text-sm font-medium">{previewTitle}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{previewSubtitle}</p>
          </div>
          <div className="border-t border-t-line px-3 py-2 text-center text-sm text-signal">
            {buttonLabel.trim() || "Open the recipes"}
          </div>
          <div className="border-t border-t-line px-3 py-2 text-center text-sm text-signal">
            {FOLLOW_BUTTON_LABEL}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          With the card switch on and a published cover, the cover image sits on top.
          Otherwise parents get the title and the link as plain text.
        </p>
      </aside>
    </div>
  );
}
```

Run the Step 1 tests again. Expected: PASS.

- [ ] **Step 3: Wire the guide page**

In `web/src/pages/SequenceEditor.tsx`:

(a) Add imports:

```tsx
import { GuideTypeSwitch, LinkGuidePanel } from "@/features/link-guides/LinkGuidePanel";
import type { DeliveryMode } from "@/lib/types";
```

(If `@/lib/types` is already imported, add `DeliveryMode` to that import instead.)

(b) In `SequenceEditorForm`, after `const saveKey = ["sequence-save", id];`, add:

```tsx
  // Local until the link is saved: choosing Link shows the panel, and the panel's save
  // is what switches the guide on the server, so a half-filled link never goes live.
  const [mode, setMode] = useState<DeliveryMode>(resource.deliveryMode ?? "gated");

  const toGated = useMutation({
    mutationKey: saveKey,
    mutationFn: () =>
      apiMutation<Resource>(`/resources/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ deliveryMode: "gated" }),
      }),
    onSuccess: () => {
      setMode("gated");
      qc.invalidateQueries({ queryKey: ["resource", id] });
      qc.invalidateQueries({ queryKey: ["resources"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Save failed"),
  });
```

(c) Directly after `<GuideCoverPanel resourceId={id} resourceName={name} />`, add:

```tsx
      <GuideTypeSwitch
        value={mode}
        disabled={toGated.isPending}
        onChange={(next) => {
          if (next === "gated" && resource.deliveryMode === "link") toGated.mutate();
          else setMode(next);
        }}
      />
```

(d) Wrap the steps grid. It is the element that opens with `<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">` and closes with the `</div>` right after its `</aside>`. Wrap it as:

```tsx
      {mode === "link" ? (
        <LinkGuidePanel resource={resource} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* ...the existing steps column and phone preview, unchanged... */}
        </div>
      )}
```

The inner content stays exactly as it is; only the wrapper is new.

- [ ] **Step 4: Badges in the guides list and on posts**

In `web/src/pages/Sequences.tsx`:
- Add `import { DeliveryBadge } from "@/components/DeliveryBadge";`.
- In `SequenceCard`, make `<DeliveryBadge mode={r.deliveryMode} />` the first child of the bottom row `<div className="mt-auto flex items-center gap-4 text-xs text-muted-foreground">`.
- In `deleteRefusal`, add before the `resource_still_referenced` branch:

```tsx
  if (code === "resource_has_link_history") {
    return "This link guide has already been sent to someone, so it is kept as a record. Remove its keywords instead.";
  }
```

In `web/src/pages/Content.tsx`:
- Add `import { DeliveryBadge } from "@/components/DeliveryBadge";`.
- In `MediaDrawer`'s keyword row, inside `<div className="flex items-center gap-2">`, after the `{!k.active && ( ... Paused ... )}` element, add:

```tsx
                    <DeliveryBadge mode={k.resource?.deliveryMode} />
```

- [ ] **Step 5: Run the web tests, typecheck and lint**

```bash
cd web && npx vitest run
```

Expected: PASS, the whole web suite. `SequenceEditor.test.tsx`, `Sequences.test.tsx` and `Content.test.tsx` use resources without `deliveryMode`, which renders as gated, so they're unchanged. If a `Content.test.tsx` assertion pins the exact keyword-row text, update it to allow the badge.

```bash
cd web && npx tsc -b
```

```bash
cd web && npm run lint
```

Expected: exit 0, no new lint errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/DeliveryBadge.tsx web/src/components/DeliveryBadge.test.tsx web/src/features/link-guides web/src/pages/SequenceEditor.tsx web/src/pages/Sequences.tsx web/src/pages/Content.tsx
git commit -m "feat: link guide panel and gated/link badges in the console"
```

---
### Task 16: Console: link clicks on the Funnels page

**Files:**
- Modify: `web/src/lib/types.ts`
- Create: `web/src/components/funnels/LinkClickPanel.tsx`
- Test: `web/src/components/funnels/LinkClickPanel.test.tsx`
- Modify: `web/src/pages/Funnels.tsx`

**Interfaces:**
- Consumes: `GET /api/funnels/link-click` from Task 13. The existing web types `GuardedRate`, `FunnelStageCount` and `FunnelHeadline`.
- Produces:
  - `LinkClickResult`
  - `LinkClickReelBreakdown`
  - `LinkClickPanel({ data, isLoading, isError })`

- [ ] **Step 1: Add the web types**

Append to `web/src/lib/types.ts`, next to `GuideFollowResult`:

```ts
export interface LinkClickReelBreakdown {
  mediaId: string | null;
  entered: number;
  linkSent: number;
  clicked: number;
  clickRate: GuardedRate;
}

/** GET /api/funnels/link-click. Mirrors src/services/funnels/linkClickFunnel.ts. */
export interface LinkClickResult {
  key: string;
  name: string;
  question: string;
  window: { from: string; to: string };
  cohortSize: number;
  stages: FunnelStageCount[];
  headline: FunnelHeadline & { rate: GuardedRate };
  followedAnyway: GuardedRate;
  byReel: LinkClickReelBreakdown[];
}
```

- [ ] **Step 2: Write the failing panel test**

```tsx
// web/src/components/funnels/LinkClickPanel.test.tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LinkClickResult } from "@/lib/types";
import { LinkClickPanel } from "./LinkClickPanel";

afterEach(cleanup);

const rate = (numerator: number, denominator: number, pct: number | null) => ({
  numerator,
  denominator,
  pct,
  belowMinSample: pct === null,
});

const DATA: LinkClickResult = {
  key: "link-click",
  name: "Comment → link click",
  question: "q",
  window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" },
  cohortSize: 412,
  stages: [
    { key: "entered", label: "Asked for a link guide", definition: "d", count: 412, ofEntryPct: 100, ofPrevPct: null },
    { key: "linkSent", label: "Got the link", definition: "d", count: 398, ofEntryPct: 96.6, ofPrevPct: 96.6 },
    { key: "clicked", label: "Opened the page", definition: "d", count: 171, ofEntryPct: 41.5, ofPrevPct: 43 },
  ],
  headline: { fromStage: "linkSent", toStage: "clicked", label: "Click rate", rationale: "r", rate: rate(171, 398, 43) },
  followedAnyway: rate(20, 80, 25),
  byReel: [{ mediaId: "reel-9", entered: 412, linkSent: 398, clicked: 171, clickRate: rate(171, 398, 43) }],
};

describe("LinkClickPanel", () => {
  it("shows links sent, click rate, follows and each reel", () => {
    render(<LinkClickPanel data={DATA} isLoading={false} isError={false} />);
    expect(screen.getByText("Click rate")).toBeInTheDocument();
    expect(screen.getAllByText("43%").length).toBeGreaterThan(0);
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("398")).toBeInTheDocument();
    expect(screen.getByText("reel-9")).toBeInTheDocument();
  });

  it("says so when no link guide was asked for", () => {
    render(<LinkClickPanel data={{ ...DATA, cohortSize: 0, byReel: [] }} isLoading={false} isError={false} />);
    expect(screen.getByText("No link guide has been asked for in this window.")).toBeInTheDocument();
  });

  it("keeps an error inside its own panel", () => {
    render(<LinkClickPanel data={undefined} isLoading={false} isError />);
    expect(screen.getByText("Couldn't load link clicks. The rest of this page is unaffected.")).toBeInTheDocument();
  });

  it("shows a dash for a rate withheld for want of sample", () => {
    render(
      <LinkClickPanel
        data={{ ...DATA, headline: { ...DATA.headline, rate: rate(1, 2, null) } }}
        isLoading={false}
        isError={false}
      />,
    );
    expect(screen.getByText("Too few to say")).toBeInTheDocument();
  });
});
```

Run: `cd web && npx vitest run src/components/funnels/LinkClickPanel.test.tsx`. Expected: FAIL, the module is missing.

- [ ] **Step 3: Write the panel**

```tsx
// web/src/components/funnels/LinkClickPanel.tsx
import type { GuardedRate, LinkClickResult } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";

function pct(rate: GuardedRate): string {
  return rate.pct === null ? "—" : `${rate.pct}%`;
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-md bg-card/40 p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-medium tabular-nums">{value}</dd>
      <dd className="mt-0.5 text-xs text-muted-foreground">{sub}</dd>
    </div>
  );
}

function rateSub(rate: GuardedRate, noun: string): string {
  return rate.belowMinSample ? "Too few to say" : `${rate.numerator} of ${rate.denominator} ${noun}`;
}

/** Link guides only. A separate panel so a failure here can't take the gated funnel down. */
export function LinkClickPanel({
  data,
  isLoading,
  isError,
}: {
  data: LinkClickResult | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  const sent = data?.stages.find((stage) => stage.key === "linkSent")?.count ?? 0;

  return (
    <section className="space-y-4 border-t border-t-line pt-8">
      <div>
        <p className="label-caps">Link guides · Comment → link click</p>
        <h2 className="mt-1 text-lg font-medium">Who opened the page</h2>
      </div>

      {isError ? (
        <p className="text-sm text-muted-foreground">
          Couldn't load link clicks. The rest of this page is unaffected.
        </p>
      ) : isLoading || !data ? (
        <Skeleton className="h-32 w-full rounded-lg" />
      ) : data.cohortSize === 0 ? (
        <p className="text-sm text-muted-foreground">No link guide has been asked for in this window.</p>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-3">
            <Stat label="Links sent" value={String(sent)} sub={`${data.cohortSize} asked`} />
            <Stat label={data.headline.label} value={pct(data.headline.rate)} sub={rateSub(data.headline.rate, "links")} />
            <Stat
              label="Following ~3 days after tapping"
              value={pct(data.followedAnyway)}
              sub={rateSub(data.followedAnyway, "rechecked")}
            />
          </dl>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-2 font-medium">Post</th>
                <th className="py-2 text-right font-medium">Asked</th>
                <th className="py-2 text-right font-medium">Sent</th>
                <th className="py-2 text-right font-medium">Opened</th>
                <th className="py-2 text-right font-medium">Click rate</th>
              </tr>
            </thead>
            <tbody>
              {data.byReel.map((reel) => (
                <tr key={reel.mediaId ?? "unknown"} className="border-t border-t-line">
                  <td className="py-2 font-mono text-xs">{reel.mediaId ?? "Unknown post"}</td>
                  <td className="py-2 text-right tabular-nums">{reel.entered}</td>
                  <td className="py-2 text-right tabular-nums">{reel.linkSent}</td>
                  <td className="py-2 text-right tabular-nums">{reel.clicked}</td>
                  <td className="py-2 text-right tabular-nums">{pct(reel.clickRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
```

Run the Step 2 test again. Expected: PASS.

- [ ] **Step 4: Add it to the Funnels page**

In `web/src/pages/Funnels.tsx`:
- Import `LinkClickPanel` from `@/components/funnels/LinkClickPanel` and the type `LinkClickResult` from `@/lib/types`.
- After the `coverQ` query, add:

```tsx
  // Its own query, like the cover panel: the link funnel must not be able to take the
  // gated funnel down.
  const linkQ = useQuery<LinkClickResult>({
    queryKey: ["funnels", "link-click", range.from, range.to],
    queryFn: ({ signal }) => apiRead<LinkClickResult>(`/funnels/link-click${query}`, { signal }),
  });
```

- Directly after the `<CoverPanel ... />` element, add:

```tsx
      <LinkClickPanel data={linkQ.data} isLoading={linkQ.isLoading} isError={linkQ.isError} />
```

- [ ] **Step 5: Run the web suite, typecheck and lint**

```bash
cd web && npx vitest run
```

Expected: PASS. If `Funnels.test.tsx` mocks `apiRead` per path and fails on the unknown `/funnels/link-click` path, add a branch to that mock returning `undefined` for it. The panel then shows its loading state, and the existing assertions are untouched.

```bash
cd web && npx tsc -b
```

```bash
cd web && npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/types.ts web/src/components/funnels/LinkClickPanel.tsx web/src/components/funnels/LinkClickPanel.test.tsx web/src/pages/Funnels.tsx web/src/pages/Funnels.test.tsx
git commit -m "feat: show link-guide clicks on the Funnels page"
```

---

### Task 17: Full verification and launch checklist

**Files:**
- Modify: `docs/superpowers/specs/2026-10-12-link-guide-delivery-design.md` (status line only)
- Regenerate: `graphify-out/`

- [ ] **Step 1: Run the whole backend suite**

```bash
npm test
```

Expected: PASS. Contract suites skip without the DB variables.

- [ ] **Step 2: Run every link contract suite against the disposable DB**

```bash
MIGRATION_TEST_DATABASE_DISPOSABLE=true MIGRATION_TEST_DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract DATABASE_URL=postgresql://postgres:disposable@127.0.0.1:5433/contract npx vitest run src/services/linkGuideMigrationContract.test.ts src/services/linkGuideRepositoryContract.test.ts src/api/linkRedirectContract.test.ts src/services/funnels/linkClickFunnelContract.test.ts
```

Expected: PASS. If an unrelated contract suite fails on leftover rows, re-run that file alone before suspecting this branch. Leftover rows in the shared disposable DB are a known cause.

- [ ] **Step 3: Typecheck, the bypass check, and the graph**

```bash
npx tsc --noEmit
```

```bash
npm run check:guide-delivery-bypasses
```

```bash
graphify update .
```

Expected: exit 0 for all three.

- [ ] **Step 4: Build the console the way production does, and prove the bundle has code**

A local `web` build without the Supabase variables exits 0 but emits a bundle with no app code. Build with them set, then grep:

```bash
cd web && VITE_SUPABASE_URL=https://example.supabase.co VITE_SUPABASE_ANON_KEY=build-check npm run build
```

```bash
grep -l "Link to a page" web/dist/assets/*.js
```

Expected: one or more file paths printed. Empty output means the bundle is hollow, so investigate before continuing.

- [ ] **Step 5: Update the spec status**

In `docs/superpowers/specs/2026-10-12-link-guide-delivery-design.md`, change the `**Status:**` line to:

```
**Status:** Implemented on `claude/gated-flow-redesign-9d3c92`; awaiting real-phone check and launch
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-10-12-link-guide-delivery-design.md graphify-out
git commit -m "docs: mark link guides implemented"
```

- [ ] **Step 7: Hand the owner the launch checklist (not agent work)**

Report this list to the owner verbatim. Every item sends real messages or changes production, so each needs their go-ahead:

1. **Redirect origin.** Set `LINK_GUIDE_REDIRECT_BASE_URL` in Railway to the API's public https origin. If only the text shape passed the launch test, first add `go.mycuratedhaven.com` (one DNS record plus a Railway custom domain) and use that.
2. **Real-phone check, on a test reel with a link guide and both flags on in a non-production setup or for a test account:**
   - Comment → public reply → card (or text) in Message Requests → tap → page opens with `utm_source=instagram`.
   - A `guide_link_click` row with `is_bot = false`.
   - The conversation shows `completed`.
   - Reply "yes" → the link again, never the follow gate.
   - DM the keyword → the card in the thread.
   - `LINK_GUIDE_ENABLED` off → no reply, no DM.
3. **Merge** to `main`. Both flags stay off, so nothing changes for parents.
4. **Oct 19:**
   - Set `LINK_GUIDE_ENABLED=true`, and `LINK_GUIDE_CARD_ENABLED=true` only if the card case was `supported`.
   - Attach one Halloween reel's keyword to the "Halloween collection" link guide.
   - Watch the first ~50 sends: Graph error codes in `dm_failed`, bot share in `guide_link_click`, and click rate on the Funnels page.
5. **Oct 20–31:** move the remaining Halloween reels to the link guide.
6. **Nov 1–7:** read clicks per reel and "Following ~3 days after tapping" against the gated baseline, then decide whether most recipes move to link guides.
