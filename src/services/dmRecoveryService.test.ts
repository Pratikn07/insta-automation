import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

const upsert = vi.fn();
const updateMany = vi.fn();
const findMany = vi.fn();
const update = vi.fn();
const $transaction = vi.fn();
const loggerInfo = vi.fn();
const loggerError = vi.fn();
const assignRecoveryCohortMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    dmRecoveryReminder: { upsert, updateMany, findMany, update },
    $transaction,
  },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: loggerInfo, error: loggerError },
}));

const envMock = {
  DM_RECOVERY_DELAY_HOURS: 10,
  DM_RECOVERY_HOLDOUT_PERCENT: 10,
  DM_RECOVERY_EXPERIMENT_VERSION: "read-recovery-v1",
  DM_RECOVERY_EXPERIMENT_START_AT: "2026-08-01T00:00:00Z",
  DM_RECOVERY_EXPERIMENT_END_AT: "2026-08-15T00:00:00Z",
  DM_RECOVERY_POST_EXPERIMENT_ENABLED: false,
};

vi.mock("../config/env.js", () => ({ env: envMock }));

vi.mock("./dmRecoveryPolicy.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./dmRecoveryPolicy.js")>();
  return {
    ...original,
    assignRecoveryCohort: assignRecoveryCohortMock,
  };
});

const {
  scheduleAcceptedGateRecovery,
  scheduleSettingsBlockedRecovery,
  scheduleTrackingUnavailableRecovery,
  recordRecoverySeen,
  recordRecoveryReaction,
  recordRecoveryPostback,
  recordRecoveryInbound,
} = await import("./dmRecoveryService.js");

// ── Fixtures ─────────────────────────────────────────────────────────────

const ACCEPTED_INPUT = {
  conversationId: "conversation-1",
  igUserId: "ig-1",
  keywordId: "keyword-1",
  keywordSnapshot: "PROTEIN",
  commentId: "comment-1",
  mediaId: "media-1",
  gateDmMessageId: "dm-1",
  instagramGateMessageId: "mid-1",
  acceptedAt: new Date("2026-08-06T08:00:00Z"),
};

const SETTINGS_INPUT = {
  conversationId: "conversation-2",
  igUserId: "ig-2",
  keywordId: "keyword-1",
  keywordSnapshot: "PROTEIN",
  commentId: "comment-2",
  mediaId: "media-1",
  rejectedAt: new Date("2026-08-06T08:00:00Z"),
};

const TRACKING_INPUT = {
  conversationId: "conversation-3",
  igUserId: "ig-3",
  keywordId: "keyword-1",
  keywordSnapshot: "PROTEIN",
  commentId: "comment-3",
  mediaId: "media-1",
};

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    conversationId: "conversation-1",
    igUserId: "ig-1",
    commentId: "comment-1",
    triggerKind: "no_confirmed_read",
    status: "waiting",
    cohort: "treatment",
    acceptedAt: new Date("2026-08-06T08:00:00Z"),
    eligibleAt: new Date("2026-08-06T18:00:00Z"),
    seenAt: null,
    seenReceivedAt: null,
    engagedAt: null,
    engagedReceivedAt: null,
    firstEngagementKind: null,
    repliedAt: null,
    repliedReceivedAt: null,
    reactedAt: null,
    postbackAt: null,
    suppressedAt: null,
    suppressionReason: null,
    instagramGateMessageId: "mid-1",
    ...overrides,
  };
}

beforeEach(() => {
  upsert.mockReset();
  updateMany.mockReset();
  findMany.mockReset();
  update.mockReset();
  $transaction.mockReset();
  loggerInfo.mockReset();
  loggerError.mockReset();
  assignRecoveryCohortMock.mockReset();

  // Default: treatment assignment
  assignRecoveryCohortMock.mockReturnValue("treatment");

  // Default upsert returns the created data
  upsert.mockImplementation(async ({ create }) => ({
    id: "row-1",
    ...create,
  }));

  // Default $transaction passes through
  $transaction.mockImplementation(async (fn: Function) =>
    fn({ dmRecoveryReminder: { findMany, update } }),
  );

  // Restore env defaults
  envMock.DM_RECOVERY_DELAY_HOURS = 10;
  envMock.DM_RECOVERY_HOLDOUT_PERCENT = 10;
  envMock.DM_RECOVERY_EXPERIMENT_VERSION = "read-recovery-v1";
  envMock.DM_RECOVERY_EXPERIMENT_START_AT = "2026-08-01T00:00:00Z";
  envMock.DM_RECOVERY_EXPERIMENT_END_AT = "2026-08-15T00:00:00Z";
  envMock.DM_RECOVERY_POST_EXPERIMENT_ENABLED = false;
});

// ── scheduleAcceptedGateRecovery ─────────────────────────────────────────

describe("scheduleAcceptedGateRecovery", () => {
  it("creates a treatment row with correct eligibleAt, copy, cohort, and template", async () => {
    await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { commentId: "comment-1" },
        create: expect.objectContaining({
          triggerKind: "no_confirmed_read",
          status: "waiting",
          cohort: "treatment",
          eligibleAt: new Date("2026-08-06T18:00:00Z"),
          instagramGateMessageId: "mid-1",
          publicReplyText:
            'I sent your guide 💛 Check your DMs/Requests. If you don\u2019t see it, DM @tinysoho \u201cPROTEIN\u201d.',
          templateVersion: "v1",
        }),
        update: {},
      }),
    );
  });

  it("returns the created row id and status", async () => {
    const result = await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);
    expect(result).toEqual({ id: "row-1", status: "waiting" });
  });

  it("replays of the same commentId return the existing row without mutation", async () => {
    upsert.mockResolvedValue({
      id: "existing-row",
      status: "sent",
      triggerKind: "no_confirmed_read",
      cohort: "treatment",
    });

    const result = await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);

    expect(result).toEqual({ id: "existing-row", status: "sent" });
    // The update clause is empty, so existing rows are not mutated.
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} }),
    );
  });

  it("assigns holdout (control) with status 'control', not 'waiting'", async () => {
    assignRecoveryCohortMock.mockReturnValue("control");

    const result = await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "control",
          cohort: "control",
        }),
      }),
    );
    expect(result.status).toBe("control");
  });

  it("creates 'control' with 'experiment_not_configured' when no experiment window", async () => {
    envMock.DM_RECOVERY_EXPERIMENT_START_AT = undefined as any;
    envMock.DM_RECOVERY_EXPERIMENT_END_AT = undefined as any;

    await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "control",
          cohort: "control",
          lastErrorCategory: "experiment_not_configured",
        }),
      }),
    );
    expect(assignRecoveryCohortMock).not.toHaveBeenCalled();
  });

  it("creates 'control' with 'experiment_not_started' when accepted before experiment start", async () => {
    const earlyInput = {
      ...ACCEPTED_INPUT,
      acceptedAt: new Date("2026-07-15T08:00:00Z"),
    };

    await scheduleAcceptedGateRecovery(earlyInput);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "control",
          cohort: "control",
          lastErrorCategory: "experiment_not_started",
        }),
      }),
    );
    expect(assignRecoveryCohortMock).not.toHaveBeenCalled();
  });

  it("creates 'control' with 'experiment_awaiting_review' when accepted after experiment end", async () => {
    const lateInput = {
      ...ACCEPTED_INPUT,
      acceptedAt: new Date("2026-08-20T08:00:00Z"),
    };

    await scheduleAcceptedGateRecovery(lateInput);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "control",
          cohort: "control",
          lastErrorCategory: "experiment_awaiting_review",
        }),
      }),
    );
  });

  it("creates treatment after experiment end when post-experiment is enabled", async () => {
    envMock.DM_RECOVERY_POST_EXPERIMENT_ENABLED = true as any;
    const lateInput = {
      ...ACCEPTED_INPUT,
      acceptedAt: new Date("2026-08-20T08:00:00Z"),
    };

    await scheduleAcceptedGateRecovery(lateInput);

    expect(assignRecoveryCohortMock).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "waiting",
          cohort: "treatment",
        }),
      }),
    );
  });

  it("routes to tracking_unavailable when instagramGateMessageId is null", async () => {
    const noMidInput = {
      ...ACCEPTED_INPUT,
      instagramGateMessageId: null,
    };

    const result = await scheduleAcceptedGateRecovery(noMidInput);

    expect(result.status).toBe("tracking_unavailable");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "tracking_unavailable",
          cohort: "not_applicable",
          lastErrorCategory: "private_send_outcome_unknown",
        }),
      }),
    );
  });

  it("uses stable cohort assignment for same user and experiment version", async () => {
    assignRecoveryCohortMock.mockReturnValue("treatment");

    await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);
    expect(assignRecoveryCohortMock).toHaveBeenCalledWith(
      "ig-1",
      "read-recovery-v1",
      10,
    );

    // Second call with same igUserId
    upsert.mockImplementation(async ({ create }) => ({
      id: "row-2",
      ...create,
    }));
    await scheduleAcceptedGateRecovery({
      ...ACCEPTED_INPUT,
      commentId: "comment-99",
    });
    expect(assignRecoveryCohortMock).toHaveBeenCalledWith(
      "ig-1",
      "read-recovery-v1",
      10,
    );
  });

  it("logs dm_recovery_created on success", async () => {
    await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);

    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: "dm_recovery_created",
        id: "row-1",
        triggerKind: "no_confirmed_read",
        status: "waiting",
        cohort: "treatment",
      }),
      expect.any(String),
    );
  });
});

// ── scheduleSettingsBlockedRecovery ───────────────────────────────────────

describe("scheduleSettingsBlockedRecovery", () => {
  it("creates with immediate eligibleAt, no acceptedAt, not_applicable cohort", async () => {
    await scheduleSettingsBlockedRecovery(SETTINGS_INPUT);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { commentId: "comment-2" },
        create: expect.objectContaining({
          triggerKind: "settings_blocked",
          status: "waiting",
          cohort: "not_applicable",
          acceptedAt: null,
          eligibleAt: new Date("2026-08-06T08:00:00Z"),
          instagramGateMessageId: null,
          gateDmMessageId: null,
          publicReplyText:
            'I couldn\u2019t send your DM 💛 Your message-request settings blocked it. DM @tinysoho \u201cPROTEIN\u201d.',
        }),
        update: {},
      }),
    );
  });

  it("never enters control — cohort is always not_applicable", async () => {
    await scheduleSettingsBlockedRecovery(SETTINGS_INPUT);

    expect(assignRecoveryCohortMock).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          cohort: "not_applicable",
          status: "waiting",
        }),
      }),
    );
  });

  it("replays of same commentId return existing row", async () => {
    upsert.mockResolvedValue({
      id: "existing-settings",
      status: "sent",
      triggerKind: "settings_blocked",
      cohort: "not_applicable",
    });

    const result = await scheduleSettingsBlockedRecovery(SETTINGS_INPUT);
    expect(result).toEqual({ id: "existing-settings", status: "sent" });
  });
});

// ── scheduleTrackingUnavailableRecovery ──────────────────────────────────

describe("scheduleTrackingUnavailableRecovery", () => {
  it("creates tracking_unavailable with far-future eligibleAt and no acceptedAt", async () => {
    const result = await scheduleTrackingUnavailableRecovery(TRACKING_INPUT);

    expect(result.status).toBe("tracking_unavailable");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "tracking_unavailable",
          cohort: "not_applicable",
          acceptedAt: null,
          lastErrorCategory: "private_send_outcome_unknown",
          instagramGateMessageId: null,
        }),
      }),
    );
  });

  it("logs dm_recovery_tracking_unavailable", async () => {
    await scheduleTrackingUnavailableRecovery(TRACKING_INPUT);

    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: "dm_recovery_tracking_unavailable",
        id: "row-1",
        commentId: "comment-3",
      }),
      expect.any(String),
    );
  });
});

// ── recordRecoverySeen ───────────────────────────────────────────────────

describe("recordRecoverySeen", () => {
  it("sets seenAt/seenReceivedAt and transitions waiting → suppressed", async () => {
    findMany.mockResolvedValue([makeRow()]);

    await recordRecoverySeen({
      instagramMessageId: "mid-1",
      eventAt: new Date("2026-08-06T09:00:00Z"),
      receivedAt: new Date("2026-08-06T09:00:03Z"),
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { instagramGateMessageId: "mid-1" },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: expect.objectContaining({
        seenAt: new Date("2026-08-06T09:00:00Z"),
        seenReceivedAt: new Date("2026-08-06T09:00:03Z"),
        status: "suppressed",
        suppressionReason: "seen",
      }),
    });
  });

  it("keeps earliest timestamp on replayed evidence", async () => {
    const existingRow = makeRow({
      seenAt: new Date("2026-08-06T08:30:00Z"),
      seenReceivedAt: new Date("2026-08-06T08:30:02Z"),
    });
    findMany.mockResolvedValue([existingRow]);

    await recordRecoverySeen({
      instagramMessageId: "mid-1",
      eventAt: new Date("2026-08-06T09:00:00Z"), // later
      receivedAt: new Date("2026-08-06T09:00:03Z"),
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: expect.objectContaining({
        seenAt: new Date("2026-08-06T08:30:00Z"), // kept earlier
        seenReceivedAt: new Date("2026-08-06T08:30:02Z"),
      }),
    });
  });

  it("preserves status on sending/sent/control rows", async () => {
    findMany.mockResolvedValue([makeRow({ status: "sent" })]);

    await recordRecoverySeen({
      instagramMessageId: "mid-1",
      eventAt: new Date("2026-08-06T09:00:00Z"),
      receivedAt: new Date("2026-08-06T09:00:03Z"),
    });

    const updateCall = update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty("status");
    expect(updateCall.data).not.toHaveProperty("suppressionReason");
  });

  it("swallows errors", async () => {
    $transaction.mockRejectedValue(new Error("database unavailable"));

    await expect(
      recordRecoverySeen({
        instagramMessageId: "mid-1",
        eventAt: new Date("2026-08-06T09:00:00Z"),
        receivedAt: new Date("2026-08-06T09:00:03Z"),
      }),
    ).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "dm_recovery_evidence_failed",
        evidenceKind: "seen",
      }),
      expect.any(String),
    );
  });
});

// ── recordRecoveryReaction ───────────────────────────────────────────────

describe("recordRecoveryReaction", () => {
  it("sets reactedAt and transitions waiting → suppressed", async () => {
    findMany.mockResolvedValue([makeRow()]);

    await recordRecoveryReaction({
      instagramMessageId: "mid-1",
      eventAt: new Date("2026-08-06T10:00:00Z"),
      receivedAt: new Date("2026-08-06T10:00:02Z"),
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: expect.objectContaining({
        reactedAt: new Date("2026-08-06T10:00:00Z"),
        status: "suppressed",
        suppressionReason: "reaction",
      }),
    });
  });

  it("preserves status on control rows", async () => {
    findMany.mockResolvedValue([makeRow({ status: "control" })]);

    await recordRecoveryReaction({
      instagramMessageId: "mid-1",
      eventAt: new Date("2026-08-06T10:00:00Z"),
      receivedAt: new Date("2026-08-06T10:00:02Z"),
    });

    const updateCall = update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty("status");
  });

  it("swallows errors", async () => {
    $transaction.mockRejectedValue(new Error("fail"));
    await expect(
      recordRecoveryReaction({
        instagramMessageId: "mid-1",
        eventAt: new Date(),
        receivedAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });
});

// ── recordRecoveryPostback ───────────────────────────────────────────────

describe("recordRecoveryPostback", () => {
  it("sets postbackAt and transitions waiting → suppressed", async () => {
    findMany.mockResolvedValue([makeRow()]);

    await recordRecoveryPostback({
      instagramMessageId: "mid-1",
      eventAt: new Date("2026-08-06T11:00:00Z"),
      receivedAt: new Date("2026-08-06T11:00:01Z"),
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: expect.objectContaining({
        postbackAt: new Date("2026-08-06T11:00:00Z"),
        status: "suppressed",
        suppressionReason: "postback",
      }),
    });
  });

  it("swallows errors", async () => {
    $transaction.mockRejectedValue(new Error("fail"));
    await expect(
      recordRecoveryPostback({
        instagramMessageId: "mid-1",
        eventAt: new Date(),
        receivedAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });
});

// ── recordRecoveryInbound ────────────────────────────────────────────────

describe("recordRecoveryInbound", () => {
  it("sets repliedAt/engagedAt/firstEngagementKind and suppresses all waiting rows for igUserId", async () => {
    findMany.mockResolvedValue([
      makeRow({ id: "row-1" }),
      makeRow({ id: "row-2", commentId: "comment-2" }),
    ]);

    await recordRecoveryInbound({
      igUserId: "ig-1",
      eventAt: new Date("2026-08-06T12:00:00Z"),
      receivedAt: new Date("2026-08-06T12:00:01Z"),
      kind: "inbound_reply",
    });

    expect(findMany).toHaveBeenCalledWith({ where: { igUserId: "ig-1" } });
    expect(update).toHaveBeenCalledTimes(2);

    for (const call of update.mock.calls) {
      expect(call[0].data).toMatchObject({
        repliedAt: new Date("2026-08-06T12:00:00Z"),
        repliedReceivedAt: new Date("2026-08-06T12:00:01Z"),
        engagedAt: new Date("2026-08-06T12:00:00Z"),
        engagedReceivedAt: new Date("2026-08-06T12:00:01Z"),
        firstEngagementKind: "inbound_reply",
        status: "suppressed",
        suppressionReason: "inbound_reply",
      });
    }
  });

  it("preserves firstEngagementKind when already set", async () => {
    findMany.mockResolvedValue([
      makeRow({ firstEngagementKind: "quick_reply" }),
    ]);

    await recordRecoveryInbound({
      igUserId: "ig-1",
      eventAt: new Date("2026-08-06T13:00:00Z"),
      receivedAt: new Date("2026-08-06T13:00:01Z"),
      kind: "inbound_reply",
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          firstEngagementKind: "quick_reply", // preserved
        }),
      }),
    );
  });

  it("preserves status on sending rows", async () => {
    findMany.mockResolvedValue([makeRow({ status: "sending" })]);

    await recordRecoveryInbound({
      igUserId: "ig-1",
      eventAt: new Date("2026-08-06T12:00:00Z"),
      receivedAt: new Date("2026-08-06T12:00:01Z"),
      kind: "attachment",
    });

    const updateCall = update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty("status");
    expect(updateCall.data).toHaveProperty("repliedAt");
  });

  it("swallows errors", async () => {
    $transaction.mockRejectedValue(new Error("fail"));
    await expect(
      recordRecoveryInbound({
        igUserId: "ig-1",
        eventAt: new Date(),
        receivedAt: new Date(),
        kind: "quick_reply",
      }),
    ).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "dm_recovery_evidence_failed",
        evidenceKind: "quick_reply",
      }),
      expect.any(String),
    );
  });
});
