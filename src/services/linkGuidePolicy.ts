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

  if (fields.linkCardTitle != null && codePoints(fields.linkCardTitle.trim()) > LINK_CARD_TEXT_MAX) {
    return "link_card_title_too_long";
  }
  if (
    fields.linkCardSubtitle != null &&
    codePoints(fields.linkCardSubtitle.trim()) > LINK_CARD_TEXT_MAX
  ) {
    return "link_card_subtitle_too_long";
  }
  return null;
}

export function campaignSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
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

const META_PREVIEW_AGENTS = /facebookexternalhit|meta-externalagent|meta-externalfetcher|facebookcatalog|facebot/i;
// "bot" only as a crawler name ("Googlebot/2.1", "Slackbot-…", "bot;"), never inside a word:
// Cubot is a phone brand, and its model names ("CUBOT X30") come from parents. A "+http"
// contact URL is a crawler convention no browser follows.
const GENERIC_BOTS =
  /bot[/;-]|\bbot\b|\+https?:|crawler|spider|preview|slurp|curl|wget|python-requests|headless/i;
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
