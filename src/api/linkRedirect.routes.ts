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

    // Railway's edge puts the visitor's address in X-Real-IP.
    const click = classifyClick({
      userAgent: req.get("user-agent") ?? "",
      method: req.method,
      ip: req.get("x-real-ip") ?? req.socket.remoteAddress,
    });
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
