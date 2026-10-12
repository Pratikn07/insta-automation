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
