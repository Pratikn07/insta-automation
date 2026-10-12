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
