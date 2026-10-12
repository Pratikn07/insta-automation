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

  it("reports a 2xx send as accepted even when the response has no body", async () => {
    const result = await runLinkGuideSpikeCase(
      { send: async () => ({ status: 200 } as { status: number; data: { message_id?: string } }), now },
      { case: "private_link_text", confirmedControlledSend: true, payload },
    );
    expect(result).toEqual({
      case: "private_link_text",
      accepted: true,
      httpStatus: 200,
      graphCode: null,
      graphSubcode: null,
      providerMessageIdPresent: false,
      checkedAt: "2026-10-13T15:00:00.000Z",
    });
  });

  it("reports a transport error with no Graph response as unknown, not as a code", async () => {
    const result = await runLinkGuideSpikeCase(
      { send: async () => { throw new Error("timeout of 15000ms exceeded"); }, now },
      { case: "private_link_text", confirmedControlledSend: true, payload },
    );
    expect(result).toEqual({
      case: "private_link_text",
      accepted: false,
      httpStatus: null,
      graphCode: null,
      graphSubcode: null,
      providerMessageIdPresent: false,
      checkedAt: "2026-10-13T15:00:00.000Z",
    });
  });
});
