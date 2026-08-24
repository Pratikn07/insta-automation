import {
  guideAccessCardTitle,
  guideAccessOpeningCardTitle,
} from "../services/guideAccessCopy.js";
import { describeGraphError } from "../services/eventLogger.js";
import {
  GUIDE_GATE_CAPABILITY_CASES,
  buildGuideGateCapabilityPayload,
  parseGuideGateCapabilityInput,
  type GuideGateCapabilityCase,
  type GuideGateCapabilityPayload,
} from "./guideGatePayloads.js";

type SendResponse = {
  status: number;
  data: unknown;
};

export type GuideGateCapabilityDependencies = {
  send(payload: GuideGateCapabilityPayload): Promise<SendResponse>;
  graphVersion: string;
  now(): Date;
};

export type SanitizedCapabilityResult = {
  case: GuideGateCapabilityCase;
  graphVersion: string;
  accepted: boolean;
  httpStatus: number | null;
  graphCode: number | null;
  graphSubcode: number | null;
  providerMessageIdPresent: boolean;
  checkedAt: string;
};

export type RunGuideGateCapabilityInput = {
  confirmedControlledSend: boolean;
  payloadInput: unknown;
};

export type ParsedGuideGateCapabilityCli = {
  case: GuideGateCapabilityCase;
  confirmedControlledSend: true;
};

const CAPABILITY_CASES = new Set<string>(GUIDE_GATE_CAPABILITY_CASES);

function acceptedResult(
  capabilityCase: GuideGateCapabilityCase,
  dependencies: GuideGateCapabilityDependencies,
  response: SendResponse,
): SanitizedCapabilityResult {
  const data = response.data as { message_id?: unknown } | null;
  return {
    case: capabilityCase,
    graphVersion: dependencies.graphVersion,
    accepted: response.status >= 200 && response.status < 300,
    httpStatus: Number.isFinite(response.status) ? response.status : null,
    graphCode: null,
    graphSubcode: null,
    providerMessageIdPresent:
      !!data && typeof data.message_id === "string" && data.message_id.length > 0,
    checkedAt: dependencies.now().toISOString(),
  };
}

export async function runGuideGateCapabilityCase(
  dependencies: GuideGateCapabilityDependencies,
  input: RunGuideGateCapabilityInput,
): Promise<SanitizedCapabilityResult> {
  if (input.confirmedControlledSend !== true) {
    throw new Error("controlled_send_confirmation_required");
  }

  const parsed = parseGuideGateCapabilityInput(input.payloadInput);
  const payload = buildGuideGateCapabilityPayload(parsed);

  try {
    const response = await dependencies.send(payload);
    return acceptedResult(parsed.case, dependencies, response);
  } catch (error) {
    const metadata = describeGraphError(error);
    return {
      case: parsed.case,
      graphVersion: dependencies.graphVersion,
      accepted: false,
      httpStatus: metadata.httpStatus,
      graphCode: metadata.graphCode,
      graphSubcode: metadata.graphSubcode,
      providerMessageIdPresent: false,
      checkedAt: dependencies.now().toISOString(),
    };
  }
}

export function parseGuideGateCapabilityCli(args: string[]): ParsedGuideGateCapabilityCli {
  let capabilityCase: string | null = null;
  let confirmedControlledSend = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--confirm-controlled-send" && !confirmedControlledSend) {
      confirmedControlledSend = true;
      continue;
    }
    if (argument === "--case" && capabilityCase === null) {
      capabilityCase = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error("invalid_capability_spike_arguments");
  }

  if (!confirmedControlledSend) throw new Error("controlled_send_confirmation_required");
  if (!capabilityCase || !CAPABILITY_CASES.has(capabilityCase)) {
    throw new Error("invalid_capability_spike_arguments");
  }

  return {
    case: capabilityCase as GuideGateCapabilityCase,
    confirmedControlledSend: true,
  };
}

type CapabilityEnvironment = Record<string, string | undefined>;

export function buildCapabilityInputFromEnvironment(
  capabilityCase: GuideGateCapabilityCase,
  environment: CapabilityEnvironment,
): unknown {
  const guideName = environment.META_SPIKE_GUIDE_NAME;
  const actionToken = environment.META_SPIKE_ACTION_TOKEN;
  const profileUrl = environment.META_SPIKE_PROFILE_URL;
  const coverUrl = environment.META_SPIKE_COVER_URL;

  switch (capabilityCase) {
    case "private_text":
      return {
        case: capabilityCase,
        commentId: environment.META_SPIKE_COMMENT_ID,
        guideName,
      };
    case "private_quick_reply":
      return {
        case: capabilityCase,
        commentId: environment.META_SPIKE_COMMENT_ID,
        guideName,
        actionToken,
      };
    case "private_generic":
      return {
        case: capabilityCase,
        commentId: environment.META_SPIKE_COMMENT_ID,
        // The same literal the real sender uses, so the spike exercises the shipped card
        // rather than a variant of it.
        title: guideAccessOpeningCardTitle,
        guideName,
        actionToken,
        profileUrl,
        coverUrl,
      };
    case "dm_quick_reply":
      return {
        case: capabilityCase,
        recipientId: environment.META_SPIKE_RECIPIENT_IG_USER_ID,
        guideName,
        actionToken,
      };
    case "dm_generic_gate":
      return {
        case: capabilityCase,
        recipientId: environment.META_SPIKE_RECIPIENT_IG_USER_ID,
        title: guideAccessCardTitle,
        guideName,
        actionToken,
        profileUrl,
        coverUrl,
      };
  }
}
