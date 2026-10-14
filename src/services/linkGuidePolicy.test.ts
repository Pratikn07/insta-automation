// src/services/linkGuidePolicy.test.ts
import { describe, expect, it } from "vitest";
import {
  buildDestinationUrl,
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

describe("validateLinkGuideFields with absent card fields", () => {
  it("treats a missing card title or subtitle as empty rather than throwing", () => {
    const fields = {
      deliveryMode: "link" as const,
      linkUrl: "https://mycuratedhaven.com/halloween",
      linkButtonLabel: "Open the recipes",
    } as unknown as Parameters<typeof validateLinkGuideFields>[0];
    expect(validateLinkGuideFields(fields, new Set(["mycuratedhaven.com"]))).toBeNull();
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

describe("buildDestinationUrl", () => {
  it("adds the tags mycuratedhaven.com keeps for an automatic DM, with the reel", () => {
    expect(
      buildDestinationUrl({ linkUrl: "https://mycuratedhaven.com/halloween", mediaId: "17912345678901234" }),
    ).toBe(
      "https://mycuratedhaven.com/halloween?utm_source=instagram&utm_medium=organic_social&utm_campaign=comment_dm&utm_content=17912345678901234",
    );
  });

  it("keeps the page's own query and overwrites stale UTM tags", () => {
    expect(
      buildDestinationUrl({
        linkUrl: "https://mycuratedhaven.com/halloween?ref=x&utm_source=old&utm_medium=dm&utm_campaign=hallowen",
        mediaId: "reel-1",
      }),
    ).toBe(
      "https://mycuratedhaven.com/halloween?ref=x&utm_source=instagram&utm_medium=organic_social&utm_campaign=comment_dm&utm_content=reel-1",
    );
  });

  it("omits utm_content when the reel is unknown", () => {
    expect(
      buildDestinationUrl({ linkUrl: "https://mycuratedhaven.com/halloween?utm_content=old", mediaId: null }),
    ).toBe("https://mycuratedhaven.com/halloween?utm_source=instagram&utm_medium=organic_social&utm_campaign=comment_dm");
  });

  it("lowercases the reel, and leaves out one the site would reject", () => {
    expect(buildDestinationUrl({ linkUrl: "https://mycuratedhaven.com/", mediaId: "REEL-9" })).toBe(
      "https://mycuratedhaven.com/?utm_source=instagram&utm_medium=organic_social&utm_campaign=comment_dm&utm_content=reel-9",
    );
    for (const mediaId of ["reel 9", "reel.9", "-reel", "x".repeat(41)]) {
      expect(buildDestinationUrl({ linkUrl: "https://mycuratedhaven.com/", mediaId })).toBe(
        "https://mycuratedhaven.com/?utm_source=instagram&utm_medium=organic_social&utm_campaign=comment_dm",
      );
    }
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
    // Meta's other fetchers are previews too, never a parent's tap.
    [{ method: "GET", userAgent: "Facebot" }, { isBot: true, uaFamily: "meta_preview" }],
    [{ method: "GET", userAgent: "meta-externalfetcher/1.1" }, { isBot: true, uaFamily: "meta_preview" }],
    [{ method: "GET", userAgent: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)" }, { isBot: true, uaFamily: "bot" }],
    [{ method: "GET", userAgent: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" }, { isBot: true, uaFamily: "bot" }],
    [{ method: "GET", userAgent: "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)" }, { isBot: true, uaFamily: "bot" }],
    // Cubot is a phone brand. Its model names contain "bot", and its owners are parents.
    [
      {
        method: "GET",
        userAgent:
          "Mozilla/5.0 (Linux; Android 10; CUBOT X30 Build/QP1A.190711.020) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      },
      { isBot: false, uaFamily: "browser" },
    ],
    [
      {
        method: "GET",
        userAgent:
          "Mozilla/5.0 (Linux; Android 11; CUBOT_X50 Build/RP1A.200720.011) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 312.0.0.0.0 Android",
      },
      { isBot: false, uaFamily: "instagram_app" },
    ],
  ])("%o", (input, expected) => {
    expect(classifyClick(input)).toEqual(expected);
  });
});

describe("classifyClick from Meta's network", () => {
  // Seen in production: seconds after each DM, Meta's link scanner fetched the link
  // from 57.141.2.x posing as an ordinary browser, and completed the conversation.
  it.each([
    ["57.141.2.1", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.131 Safari/537.36"],
    ["57.141.2.44", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1"],
    ["173.252.79.116", INSTAGRAM_UA],
    ["::ffff:157.240.1.10", INSTAGRAM_UA],
    ["2a03:2880:f000::1", INSTAGRAM_UA],
  ])("treats %s as Meta's scanner, whatever it claims to be", (ip, userAgent) => {
    expect(classifyClick({ method: "GET", userAgent, ip })).toEqual({ isBot: true, uaFamily: "meta_scanner" });
  });

  it("keeps the preview label for Meta's declared crawler", () => {
    expect(
      classifyClick({ method: "GET", userAgent: "facebookexternalhit/1.1", ip: "173.252.79.116" }),
    ).toEqual({ isBot: true, uaFamily: "meta_preview" });
  });

  it.each([["67.180.186.42"], [""], ["not an ip"], [undefined]])(
    "classifies by user agent when the address %s is not Meta's",
    (ip) => {
      expect(classifyClick({ method: "GET", userAgent: INSTAGRAM_UA, ip })).toEqual({
        isBot: false,
        uaFamily: "instagram_app",
      });
    },
  );
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
