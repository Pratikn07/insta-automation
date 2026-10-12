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
