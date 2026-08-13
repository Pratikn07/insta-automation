import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  controlUpsert,
  queryRaw,
  observationCreateMany,
  campaignUpdateMany,
  eventLogCreate,
  logEvent,
} = vi.hoisted(() => ({
  controlUpsert: vi.fn(),
  queryRaw: vi.fn(),
  observationCreateMany: vi.fn(),
  campaignUpdateMany: vi.fn(),
  eventLogCreate: vi.fn(),
  logEvent: vi.fn(),
}));

const tx = {
  dmRecoveryControl: { upsert: controlUpsert },
  recoveryCampaignHealthObservation: { createMany: observationCreateMany },
  recoveryCampaign: { updateMany: campaignUpdateMany },
  eventLog: { create: eventLogCreate },
  $queryRaw: queryRaw,
};

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  },
}));
vi.mock("./eventLogger.js", () => ({ logEvent }));

const {
  classifyInboundHealthSignal,
  recordCampaignHealthObservation,
} = await import("./campaignHealthObservation.js");

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const SIBLING_ID = "22222222-2222-4222-8222-222222222222";
const ROLLOUT_GROUP_ID = "33333333-3333-4333-8333-333333333333";
const OBSERVED_AT = new Date("2026-08-08T20:00:00.000Z");

function sqlAt(index: number): string {
  return (queryRaw.mock.calls[index]?.[0] as readonly string[]).join(" ");
}

beforeEach(() => {
  vi.clearAllMocks();
  controlUpsert.mockResolvedValue({ id: 1 });
  queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes('WHERE "id" =') && sql.includes('"rollout_group_id"')) {
      return [{ id: CAMPAIGN_ID, rolloutGroupId: ROLLOUT_GROUP_ID }];
    }
    if (sql.includes('WHERE "rollout_group_id" =')) {
      return [
        { id: CAMPAIGN_ID, state: "running" },
        { id: SIBLING_ID, state: "running" },
      ];
    }
    return [];
  });
  observationCreateMany.mockResolvedValue({ count: 1 });
  campaignUpdateMany.mockResolvedValue({ count: 2 });
  eventLogCreate.mockResolvedValue({ id: "event-1" });
  logEvent.mockResolvedValue(undefined);
});

describe("classifyInboundHealthSignal", () => {
  it.each([
    ["STOP", "opt_out"],
    ["unsubscribe please", "opt_out"],
    ["do not contact me", "opt_out"],
    ["  Stop!  ", "opt_out"],
    ["leave me alone", "negative_reply"],
    ["go away!", "negative_reply"],
  ] as const)("classifies %p as %s", (text, expected) => {
    expect(classifyInboundHealthSignal(text)).toBe(expected);
  });

  it.each([
    "please stop by tomorrow",
    "I cannot stop thinking about this",
    "unstoppable",
    "please leave me alone with the details for now",
    "",
  ])("does not classify the substring case %p", (text) => {
    expect(classifyInboundHealthSignal(text)).toBeNull();
  });
});

describe("recordCampaignHealthObservation", () => {
  const input = {
    campaignId: CAMPAIGN_ID,
    kind: "opt_out" as const,
    sourceKey: "inbound:mid-1",
    observedAt: OBSERVED_AT,
  };

  it("locks control, then the target row carrying group identity, then the group in ID order", async () => {
    await expect(recordCampaignHealthObservation(input)).resolves.toEqual({ created: true });

    expect(sqlAt(0)).toContain('FROM "dm_recovery_control"');
    expect(sqlAt(1)).toContain('FROM "recovery_campaign"');
    expect(sqlAt(1)).toContain('"rollout_group_id" AS "rolloutGroupId"');
    expect(sqlAt(1)).toContain('WHERE "id" =');
    expect(queryRaw.mock.calls[1]?.[1]).toBe(CAMPAIGN_ID);
    expect(sqlAt(2)).toContain('WHERE "rollout_group_id" =');
    expect(sqlAt(2)).toContain('ORDER BY "id"');
    expect(queryRaw.mock.calls[2]?.[1]).toBe(ROLLOUT_GROUP_ID);
    expect(eventLogCreate).toHaveBeenCalledWith({
      data: {
        kind: "historical_campaign_group_paused",
        payload: {
          rolloutGroupId: ROLLOUT_GROUP_ID,
          reason: "auto:opt_out",
          pausedCampaignIds: [CAMPAIGN_ID, SIBLING_ID],
          skipped: [],
        },
      },
    });
  });

  it("does not pause or audit when duplicate observation insertion loses", async () => {
    observationCreateMany.mockResolvedValue({ count: 0 });

    await expect(recordCampaignHealthObservation(input)).resolves.toEqual({ created: false });

    expect(campaignUpdateMany).not.toHaveBeenCalled();
    expect(eventLogCreate).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("propagates grouped audit failure from the observation transaction", async () => {
    eventLogCreate.mockRejectedValue(new Error("audit unavailable"));

    await expect(recordCampaignHealthObservation(input)).rejects.toThrow("audit unavailable");

    expect(observationCreateMany).toHaveBeenCalledOnce();
    expect(campaignUpdateMany).toHaveBeenCalledOnce();
    expect(eventLogCreate).toHaveBeenCalledOnce();
    expect(logEvent).not.toHaveBeenCalled();
  });
});
