import { AxiosError, AxiosHeaders } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCapabilityInputFromEnvironment,
  parseGuideGateCapabilityCli,
  runGuideGateCapabilityCase,
  type GuideGateCapabilityDependencies,
} from "./guideGateCapabilitySpike.js";

const COMMENT_ID = "17890000000000001";
const RECIPIENT_ID = "17890000000000002";
const ACTION_TOKEN = "3f05a514-1f04-4b14-9df4-7730c7c39af4";
const PROFILE_URL = "https://www.instagram.com/tinysoho/";
const COVER_URL = "https://cdn.example.com/guide-cover/sleep/dm.png";
const CHECKED_AT = new Date("2026-08-22T18:30:00.000Z");

const send = vi.fn();
const dependencies: GuideGateCapabilityDependencies = {
  send,
  graphVersion: "v21.0",
  now: () => CHECKED_AT,
};

const privateTextInput = {
  case: "private_text",
  commentId: COMMENT_ID,
  guideName: "toddler sleep guide",
} as const;

beforeEach(() => {
  send.mockReset();
});

describe("controlled Meta guide-gate capability runner", () => {
  it("stops before the sender when controlled-send confirmation is missing", async () => {
    await expect(
      runGuideGateCapabilityCase(dependencies, {
        confirmedControlledSend: false,
        payloadInput: privateTextInput,
      }),
    ).rejects.toThrow("controlled_send_confirmation_required");

    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["missing controlled input", { case: "private_text", guideName: "sleep guide" }],
    ["unknown case", { case: "send_everything", commentId: COMMENT_ID }],
    [
      "non-HTTPS URL",
      {
        case: "private_generic",
        commentId: COMMENT_ID,
        guideName: "sleep guide",
        profileUrl: "http://www.instagram.com/tinysoho/",
        coverUrl: COVER_URL,
        actionToken: ACTION_TOKEN,
      },
    ],
    [
      "non-UUID action token",
      {
        case: "dm_quick_reply",
        recipientId: RECIPIENT_ID,
        guideName: "sleep guide",
        actionToken: "send-guide-now",
      },
    ],
  ])("stops before the sender for %s", async (_label, payloadInput) => {
    await expect(
      runGuideGateCapabilityCase(dependencies, {
        confirmedControlledSend: true,
        payloadInput,
      }),
    ).rejects.toThrow("invalid_guide_gate_payload");

    expect(send).not.toHaveBeenCalled();
  });

  it("returns only a sanitized accepted result", async () => {
    send.mockResolvedValue({
      status: 200,
      data: {
        message_id: "PROVIDER-MESSAGE-ID-SECRET",
        recipient_id: "PROVIDER-RECIPIENT-ID-SECRET",
        raw: "PRIVATE-RESPONSE-BODY-SECRET",
      },
    });

    const result = await runGuideGateCapabilityCase(dependencies, {
      confirmedControlledSend: true,
      payloadInput: {
        case: "dm_generic_gate",
        recipientId: RECIPIENT_ID,
        title: "Your guide is waiting ✨",
        guideName: privateTextInput.guideName,
        actionToken: ACTION_TOKEN,
        profileUrl: PROFILE_URL,
        coverUrl: COVER_URL,
      },
    });

    expect(result).toEqual({
      case: "dm_generic_gate",
      graphVersion: "v21.0",
      accepted: true,
      httpStatus: 200,
      graphCode: null,
      graphSubcode: null,
      providerMessageIdPresent: true,
      checkedAt: "2026-08-22T18:30:00.000Z",
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      COMMENT_ID,
      RECIPIENT_ID,
      ACTION_TOKEN,
      PROFILE_URL,
      COVER_URL,
      "PROVIDER-MESSAGE-ID-SECRET",
      "PROVIDER-RECIPIENT-ID-SECRET",
      "PRIVATE-RESPONSE-BODY-SECRET",
      privateTextInput.guideName,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("returns only allowlisted numeric metadata for a Graph rejection", async () => {
    const providerMessage = "PROVIDER-ERROR-MESSAGE-SECRET";
    const requestBody = "PRIVATE-REQUEST-BODY-SECRET";
    const error = new AxiosError(
      providerMessage,
      "ERR_BAD_RESPONSE",
      { headers: new AxiosHeaders(), data: requestBody },
      undefined,
      {
        data: {
          error: {
            code: 100,
            error_subcode: 2534025,
            message: providerMessage,
            fbtrace_id: "TRACE-ID-MUST-NOT-BE-RETURNED",
          },
        },
        status: 400,
        statusText: "Bad Request",
        headers: new AxiosHeaders(),
        config: { headers: new AxiosHeaders(), data: requestBody },
      },
    );
    send.mockRejectedValue(error);

    const result = await runGuideGateCapabilityCase(dependencies, {
      confirmedControlledSend: true,
      payloadInput: privateTextInput,
    });

    expect(result).toEqual({
      case: "private_text",
      graphVersion: "v21.0",
      accepted: false,
      httpStatus: 400,
      graphCode: 100,
      graphSubcode: 2534025,
      providerMessageIdPresent: false,
      checkedAt: "2026-08-22T18:30:00.000Z",
    });
    const serialized = JSON.stringify(result);
    for (const secret of [providerMessage, requestBody, "TRACE-ID-MUST-NOT-BE-RETURNED"] as const) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("reports an unknown transport outcome without copying the transport error", async () => {
    send.mockRejectedValue(
      new AxiosError("socket failed with ACCESS-TOKEN-SECRET", "ECONNRESET"),
    );

    await expect(
      runGuideGateCapabilityCase(dependencies, {
        confirmedControlledSend: true,
        payloadInput: privateTextInput,
      }),
    ).resolves.toEqual({
      case: "private_text",
      graphVersion: "v21.0",
      accepted: false,
      httpStatus: null,
      graphCode: null,
      graphSubcode: null,
      providerMessageIdPresent: false,
      checkedAt: "2026-08-22T18:30:00.000Z",
    });
  });
});

describe("guide-gate capability CLI boundary", () => {
  it("requires exactly one known case and explicit confirmation", () => {
    expect(
      parseGuideGateCapabilityCli([
        "--case",
        "private_text",
        "--confirm-controlled-send",
      ]),
    ).toEqual({ case: "private_text", confirmedControlledSend: true });

    expect(() => parseGuideGateCapabilityCli(["--case", "private_text"]))
      .toThrow("controlled_send_confirmation_required");
    expect(() =>
      parseGuideGateCapabilityCli([
        "--case",
        "private_text",
        "--confirm-controlled-send",
        "--all",
      ]),
    ).toThrow("invalid_capability_spike_arguments");
    expect(() =>
      parseGuideGateCapabilityCli([
        "--case",
        "unknown_case",
        "--confirm-controlled-send",
      ]),
    ).toThrow("invalid_capability_spike_arguments");
  });

  it("maps only the selected case's controlled environment inputs", () => {
    const common = {
      META_SPIKE_GUIDE_NAME: "toddler sleep guide",
      META_SPIKE_COMMENT_ID: COMMENT_ID,
      META_SPIKE_RECIPIENT_IG_USER_ID: RECIPIENT_ID,
      META_SPIKE_ACTION_TOKEN: ACTION_TOKEN,
      META_SPIKE_PROFILE_URL: PROFILE_URL,
      META_SPIKE_COVER_URL: COVER_URL,
      UNRELATED_SECRET: "MUST-NOT-ENTER-THE-PAYLOAD",
    };

    expect(buildCapabilityInputFromEnvironment("private_text", common)).toEqual({
      case: "private_text",
      commentId: COMMENT_ID,
      guideName: "toddler sleep guide",
    });
    expect(buildCapabilityInputFromEnvironment("dm_generic_gate", common)).toEqual({
      case: "dm_generic_gate",
      // The card title is a shipped literal, not an environment input — the spike must send
      // the same string the real gate sends or it is testing a different message.
      title: "Your guide is waiting ✨",
      recipientId: RECIPIENT_ID,
      guideName: "toddler sleep guide",
      actionToken: ACTION_TOKEN,
      profileUrl: PROFILE_URL,
      coverUrl: COVER_URL,
    });
  });
});
