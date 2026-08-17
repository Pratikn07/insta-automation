import { describe, it, expect, vi, beforeEach } from "vitest";
import { CURRENT_ORIGIN_METHOD } from "./historicalRecoveryOriginPolicy.js";

// ── Mocks ────────────────────────────────────────────────────────────────

const upsert = vi.fn();
const reminderFindUnique = vi.fn();
const updateMany = vi.fn();
const findMany = vi.fn();
const update = vi.fn();
const $transaction = vi.fn();
const loggerInfo = vi.fn();
const loggerError = vi.fn();
const assignRecoveryCohortMock = vi.fn();
const assignRecoveryTimingArmMock = vi.fn();
const igUserFindUnique = vi.fn();
const lockAndValidateSettingsBlockedVerificationEvidence = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    dmRecoveryReminder: { upsert, findUnique: reminderFindUnique, updateMany, findMany, update },
    igUser: { findUnique: igUserFindUnique },
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
  DM_RECOVERY_WESTERN_ONLY: false,
};

vi.mock("../config/env.js", () => ({ env: envMock }));

vi.mock("./dmRecoveryPolicy.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./dmRecoveryPolicy.js")>();
  return {
    ...original,
    assignRecoveryCohort: assignRecoveryCohortMock,
  };
});

vi.mock("./dmRecoveryTimingExperiment.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./dmRecoveryTimingExperiment.js")>();
  return {
    ...original,
    assignRecoveryTimingArm: assignRecoveryTimingArmMock,
  };
});

vi.mock("./settingsBlockedVerificationService.js", () => ({
  lockAndValidateSettingsBlockedVerificationEvidence,
}));

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
  verification: {
    verificationId: "10000000-0000-4000-8000-000000000017",
    verificationVersion: "settings-proof-2026-08-08-v1",
    graphCode: 10,
    graphSubcode: 12345,
    classifiedAt: new Date("2026-08-06T08:00:00Z"),
    verifiedAt: new Date("2026-08-06T07:00:00Z"),
    validUntil: new Date("2026-09-06T07:00:00Z"),
    evidenceReference: "meta-sandbox/settings-proof-2026-08-08-v1",
    evidenceSha256: "a".repeat(64),
  },
};

const TRACKING_INPUT = {
  conversationId: "conversation-3",
  igUserId: "ig-3",
  keywordId: "keyword-1",
  keywordSnapshot: "PROTEIN",
  commentId: "comment-3",
  mediaId: "media-1",
  observedAt: new Date("2026-08-06T08:30:00Z"),
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
  reminderFindUnique.mockReset();
  updateMany.mockReset();
  findMany.mockReset();
  update.mockReset();
  $transaction.mockReset();
  loggerInfo.mockReset();
  loggerError.mockReset();
  assignRecoveryCohortMock.mockReset();
  assignRecoveryTimingArmMock.mockReset();
  igUserFindUnique.mockReset();
  lockAndValidateSettingsBlockedVerificationEvidence.mockReset();
  // Default: an unclassified person, so the name screen decides.
  igUserFindUnique.mockResolvedValue({
    username: "someone",
    name: null,
    inferredOrigin: null,
    originConfidence: null,
    originMethod: null,
  });

  // Default: treatment assignment
  assignRecoveryCohortMock.mockReturnValue("treatment");
  assignRecoveryTimingArmMock.mockReturnValue("two_hour");

  // Default upsert returns the created data
  upsert.mockImplementation(async ({ create }) => ({
    id: "row-1",
    ...create,
  }));
  reminderFindUnique.mockResolvedValue(null);
  lockAndValidateSettingsBlockedVerificationEvidence.mockImplementation(
    async (_tx, evidence) => evidence,
  );

  // Default $transaction passes through
  $transaction.mockImplementation(async (fn: Function) =>
    fn({ dmRecoveryReminder: { findUnique: reminderFindUnique, upsert, findMany, update } }),
  );

  // Restore env defaults
  envMock.DM_RECOVERY_DELAY_HOURS = 10;
  envMock.DM_RECOVERY_HOLDOUT_PERCENT = 10;
  envMock.DM_RECOVERY_EXPERIMENT_VERSION = "read-recovery-v1";
  envMock.DM_RECOVERY_EXPERIMENT_START_AT = "2026-08-01T00:00:00Z";
  envMock.DM_RECOVERY_EXPERIMENT_END_AT = "2026-08-15T00:00:00Z";
  envMock.DM_RECOVERY_POST_EXPERIMENT_ENABLED = false;
  envMock.DM_RECOVERY_WESTERN_ONLY = false;
});

// ── scheduleAcceptedGateRecovery ─────────────────────────────────────────

describe("scheduleAcceptedGateRecovery", () => {
  describe("read-recovery-timing-v2 assignment", () => {
    beforeEach(() => {
      envMock.DM_RECOVERY_EXPERIMENT_VERSION = "read-recovery-timing-v2";
    });

    it.each([
      ["two_hour", "waiting", "treatment", "2026-08-06T10:00:00.000Z"],
      ["six_hour", "waiting", "treatment", "2026-08-06T14:00:00.000Z"],
      ["no_reminder", "control", "control", "2026-08-06T08:00:00.000Z"],
    ] as const)(
      "persists the frozen %s assignment and schedule",
      async (timingArm, status, cohort, eligibleAt) => {
        assignRecoveryTimingArmMock.mockReturnValue(timingArm);

        await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);

        expect(assignRecoveryTimingArmMock).toHaveBeenCalledWith("ig-1");
        expect(upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { commentId: "comment-1" },
            create: expect.objectContaining({
              experimentVersionSnapshot: "read-recovery-timing-v2",
              timingArm,
              status,
              cohort,
              acceptedAt: ACCEPTED_INPUT.acceptedAt,
              eligibleAt: new Date(eligibleAt),
            }),
            update: {},
          }),
        );
      },
    );

    it("excludes an untrackable accepted DM before timing assignment", async () => {
      await scheduleAcceptedGateRecovery({
        ...ACCEPTED_INPUT,
        instagramGateMessageId: null,
      });

      expect(assignRecoveryTimingArmMock).not.toHaveBeenCalled();
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: "tracking_unavailable",
            cohort: "not_applicable",
            experimentVersionSnapshot: null,
            timingArm: null,
          }),
        }),
      );
    });

    it("stores an out-of-market exclusion without randomizing it", async () => {
      envMock.DM_RECOVERY_WESTERN_ONLY = true;
      igUserFindUnique.mockResolvedValue({
        username: "priya_m",
        name: "Priya M",
        inferredOrigin: "south_asian",
        originConfidence: "high",
        originMethod: CURRENT_ORIGIN_METHOD,
      });

      const result = await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);

      expect(result.status).toBe("suppressed");
      expect(assignRecoveryTimingArmMock).not.toHaveBeenCalled();
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: "suppressed",
            cohort: "not_applicable",
            suppressionReason: "audience_out_of_market",
            suppressedAt: ACCEPTED_INPUT.acceptedAt,
            experimentVersionSnapshot: null,
            timingArm: null,
          }),
        }),
      );
    });

    it.each([
      ["before enrollment", "2026-07-31T23:59:59.999Z", "experiment_not_started"],
      ["at the end boundary", "2026-08-15T00:00:00.000Z", "experiment_awaiting_review"],
      ["after enrollment", "2026-08-20T08:00:00.000Z", "experiment_awaiting_review"],
    ] as const)(
      "does not randomize a DM accepted %s",
      async (_label, acceptedAt, lastErrorCategory) => {
        await scheduleAcceptedGateRecovery({
          ...ACCEPTED_INPUT,
          acceptedAt: new Date(acceptedAt),
        });

        expect(assignRecoveryTimingArmMock).not.toHaveBeenCalled();
        expect(upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({
              status: "control",
              experimentVersionSnapshot: null,
              timingArm: null,
              lastErrorCategory,
            }),
          }),
        );
      },
    );

    it("keeps the first persisted assignment on a duplicate scheduling call", async () => {
      assignRecoveryTimingArmMock.mockReturnValue("six_hour");
      upsert.mockResolvedValue({
        id: "existing-row",
        status: "waiting",
        cohort: "treatment",
        experimentVersionSnapshot: "read-recovery-timing-v2",
        timingArm: "two_hour",
      });

      await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);

      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    });

    it("qualifies a captured comment even when mediaId is null", async () => {
      await scheduleAcceptedGateRecovery({ ...ACCEPTED_INPUT, mediaId: null });

      expect(assignRecoveryTimingArmMock).toHaveBeenCalledWith("ig-1");
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            commentId: "comment-1",
            mediaId: null,
            experimentVersionSnapshot: "read-recovery-timing-v2",
            timingArm: "two_hour",
          }),
        }),
      );
    });

    it("logs the persisted version and arm without follower data", async () => {
      await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);

      const creationLog = loggerInfo.mock.calls.find(
        ([fields]) => fields.eventCode === "dm_recovery_created",
      )?.[0];
      expect(creationLog).toMatchObject({
        experimentVersion: "read-recovery-timing-v2",
        timingArm: "two_hour",
      });
      expect(creationLog).not.toHaveProperty("igUserId");
      expect(creationLog).not.toHaveProperty("publicReplyText");
    });
  });

  it("creates a treatment row with correct eligibleAt, copy, cohort, and template", async () => {
    await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { commentId: "comment-1" },
        create: expect.objectContaining({
          triggerKind: "no_confirmed_read",
          status: "waiting",
          cohort: "treatment",
          experimentVersionSnapshot: null,
          timingArm: null,
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

  // The send-time check reads origin live from ig_users, which is rewritten
  // continuously and retires a verdict when the name behind it changes. Freezing
  // it on the row is what lets the experiment be measured afterwards.
  describe("audience origin snapshot", () => {
    it("freezes the stored verdict onto the row", async () => {
      igUserFindUnique.mockResolvedValue({
        username: "priya_m",
        name: "Priya M",
        inferredOrigin: "south_asian",
        originConfidence: "high",
        originMethod: CURRENT_ORIGIN_METHOD,
      });

      await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            audienceOrigin: "south_asian",
            audienceOriginConfidence: "high",
          }),
        }),
      );
    });

    // The asymmetry this whole column exists to fix: a control row is stamped
    // terminal at creation and never runs the origin check, so without the
    // snapshot there is no record of which population it belonged to.
    it("snapshots a control row too, not just treatment", async () => {
      assignRecoveryCohortMock.mockReturnValue("control");
      igUserFindUnique.mockResolvedValue({
        username: "priya_m",
        name: "Priya M",
        inferredOrigin: "south_asian",
        originConfidence: "high",
        originMethod: CURRENT_ORIGIN_METHOD,
      });

      await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            cohort: "control",
            audienceOrigin: "south_asian",
            audienceOriginConfidence: "high",
          }),
        }),
      );
    });

    // Measurement must never cost a reminder. A null reads as "not known at
    // creation" and stays recoverable from ig_users.
    it("still records the reminder when the lookup fails", async () => {
      igUserFindUnique.mockRejectedValue(new Error("connection terminated"));

      const result = await scheduleAcceptedGateRecovery(ACCEPTED_INPUT);

      expect(result.status).toBe("waiting");
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            audienceOrigin: null,
            audienceOriginConfidence: null,
          }),
        }),
      );
      expect(loggerError).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: "audience_origin_snapshot_failed" }),
        expect.any(String),
      );
    });
  });

  // Recovery posts its reply on the source comment, so a journey that began in
  // the DMs has nowhere to post. Such a request must be rejected outright
  // rather than persisted with a blank comment id.
  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
  ])("rejects a DM-origin request whose commentId is %s", async (_label, commentId) => {
    await expect(
      scheduleAcceptedGateRecovery({ ...ACCEPTED_INPUT, commentId }),
    ).rejects.toThrow("invalid_comment_origin");
    expect(upsert).not.toHaveBeenCalled();
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

  // Enabling post-experiment treatment applies to newly created rows only. A
  // person already stored as control stays control forever, otherwise flipping
  // the flag would retroactively rewrite the holdout and destroy the
  // experiment's counterfactual.
  it("does not release an already stored control row when post-experiment is enabled", async () => {
    envMock.DM_RECOVERY_POST_EXPERIMENT_ENABLED = true as any;
    assignRecoveryCohortMock.mockReturnValue("treatment");
    upsert.mockResolvedValue({
      id: "stored-control-row",
      status: "control",
      cohort: "control",
    });

    const result = await scheduleAcceptedGateRecovery({
      ...ACCEPTED_INPUT,
      acceptedAt: new Date("2026-08-20T08:00:00Z"),
    });

    expect(result).toEqual({ id: "stored-control-row", status: "control" });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
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
          experimentVersionSnapshot: null,
          timingArm: null,
          acceptedAt: null,
          eligibleAt: new Date("2026-08-06T08:00:00Z"),
          instagramGateMessageId: null,
          gateDmMessageId: null,
          publicReplyText:
            'I couldn\u2019t send your DM 💛 Your message-request settings blocked it. DM @tinysoho \u201cPROTEIN\u201d.',
          settingsEvidenceLegacy: false,
          settingsVerificationId: SETTINGS_INPUT.verification.verificationId,
          settingsVerificationVersion: SETTINGS_INPUT.verification.verificationVersion,
          settingsGraphCode: 10,
          settingsGraphSubcode: 12345,
          settingsClassifiedAt: SETTINGS_INPUT.verification.classifiedAt,
          settingsEvidenceReference: SETTINGS_INPUT.verification.evidenceReference,
          settingsEvidenceSha256: SETTINGS_INPUT.verification.evidenceSha256,
        }),
        update: {},
      }),
    );
  });

  it("rejects a DM-origin request with no commentId", async () => {
    await expect(
      scheduleSettingsBlockedRecovery({ ...SETTINGS_INPUT, commentId: "" }),
    ).rejects.toThrow("invalid_comment_origin");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("never enters control — cohort is always not_applicable", async () => {
    envMock.DM_RECOVERY_EXPERIMENT_VERSION = "read-recovery-timing-v2";
    await scheduleSettingsBlockedRecovery(SETTINGS_INPUT);

    expect(assignRecoveryCohortMock).not.toHaveBeenCalled();
    expect(assignRecoveryTimingArmMock).not.toHaveBeenCalled();
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
    reminderFindUnique.mockResolvedValue({
      id: "existing-settings",
      status: "sent",
      triggerKind: "settings_blocked",
      cohort: "not_applicable",
    });

    const result = await scheduleSettingsBlockedRecovery(SETTINGS_INPUT);
    expect(result).toEqual({ id: "existing-settings", status: "sent" });
    expect(lockAndValidateSettingsBlockedVerificationEvidence).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("fails closed when the evidence is retired between classification and persistence", async () => {
    lockAndValidateSettingsBlockedVerificationEvidence.mockRejectedValue(
      Object.assign(new Error("retired"), { reason: "verification_retired" }),
    );

    await expect(scheduleSettingsBlockedRecovery(SETTINGS_INPUT)).rejects.toMatchObject({
      reason: "verification_retired",
    });
    expect(upsert).not.toHaveBeenCalled();
  });
});

// ── scheduleTrackingUnavailableRecovery ──────────────────────────────────

describe("scheduleTrackingUnavailableRecovery", () => {
  it("rejects a DM-origin request with no commentId", async () => {
    await expect(
      scheduleTrackingUnavailableRecovery({ ...TRACKING_INPUT, commentId: "" }),
    ).rejects.toThrow("invalid_comment_origin");
    expect(upsert).not.toHaveBeenCalled();
  });

  // eligibleAt records when the untrackable outcome was observed. The row is
  // kept away from the worker by its status, not by a sentinel date — a
  // year-2099 placeholder is not a time and would surface as one on the
  // dashboard this row exists to populate.
  it("creates tracking_unavailable stamped with the observation time", async () => {
    const observedAt = new Date("2026-08-06T08:30:00Z");
    const result = await scheduleTrackingUnavailableRecovery({ ...TRACKING_INPUT, observedAt });

    expect(result.status).toBe("tracking_unavailable");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "tracking_unavailable",
          cohort: "not_applicable",
          acceptedAt: null,
          eligibleAt: observedAt,
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
      where: {
        instagramGateMessageId: "mid-1",
        status: { in: ["waiting", "control", "sending", "sent"] },
      },
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

    expect(findMany).toHaveBeenCalledWith({
      where: { igUserId: "ig-1", status: { in: ["waiting", "control", "sending", "sent"] } },
    });
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

  // Verified against Postgres: without the status filter one inbound webhook
  // rewrote engagedAt onto every row for the user, including a cancelled one.
  // A finished row is not evidence for the experiment and the owner's
  // cancellation must not be quietly annotated after the fact.
  it("never rewrites evidence onto a finished row", async () => {
    findMany.mockResolvedValue([]);

    await recordRecoveryInbound({
      igUserId: "ig-1",
      eventAt: new Date(),
      receivedAt: new Date(),
      kind: "inbound_reply",
    });

    const where = findMany.mock.calls[0]![0].where;
    for (const finished of [
      "suppressed",
      "send_failed",
      "send_uncertain",
      "tracking_unavailable",
      "cancelled",
    ]) {
      expect(where.status.in).not.toContain(finished);
    }
    expect(update).not.toHaveBeenCalled();
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

// ── suppressRecoveriesForCompletion ──────────────────────────────────────

describe("suppressRecoveriesForCompletion", () => {
  // Runs in its own transaction, so it must be bulk statements rather than a
  // read plus a per-row update loop: an N+1 here holds that transaction open
  // for as long as the person has history.
  function txWith(updateManyFn: ReturnType<typeof vi.fn>) {
    return { dmRecoveryReminder: { updateMany: updateManyFn } } as any;
  }

  const completedAt = new Date("2026-08-06T15:00:00Z");

  async function run(updateManyFn: ReturnType<typeof vi.fn>) {
    const { suppressRecoveriesForCompletion } = await import("./dmRecoveryService.js");
    await suppressRecoveriesForCompletion(txWith(updateManyFn), {
      conversationId: "convo-1",
      igUserId: "ig-1",
      keywordId: "kw-1",
      completedAt,
    });
  }

  it("suppresses the source waiting row as 'completed'", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    await run(updateMany);

    expect(updateMany).toHaveBeenCalledWith({
      where: { conversationId: "convo-1", status: "waiting" },
      data: {
        status: "suppressed",
        suppressedAt: completedAt,
        suppressionReason: "completed",
      },
    });
  });

  it("suppresses this person's other waiting rows for the keyword as 'completed_elsewhere'", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    await run(updateMany);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        igUserId: "ig-1",
        keywordId: "kw-1",
        conversationId: { not: "convo-1" },
        status: "waiting",
      },
      data: {
        status: "suppressed",
        suppressedAt: completedAt,
        suppressionReason: "completed_elsewhere",
      },
    });
  });

  it("records completion on control rows without changing their status", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    await run(updateMany);

    const controlCalls = updateMany.mock.calls.filter(
      ([args]) => args.where.status === "control",
    );
    expect(controlCalls).toHaveLength(2);
    for (const [args] of controlCalls) {
      expect(args.data).not.toHaveProperty("status");
      expect(args.data).toMatchObject({ suppressedAt: completedAt });
    }
  });

  // A row mid-send must not be forced terminal here; the worker's final
  // pre-send transaction re-reads the conversation and suppresses it there.
  it("never touches a sending row", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    await run(updateMany);

    for (const [args] of updateMany.mock.calls) {
      expect(["waiting", "control"]).toContain(args.where.status);
    }
  });

  it("issues only bulk statements — no per-row read or update", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findManyFn = vi.fn();
    const updateFn = vi.fn();
    const { suppressRecoveriesForCompletion } = await import("./dmRecoveryService.js");

    await suppressRecoveriesForCompletion(
      { dmRecoveryReminder: { updateMany, findMany: findManyFn, update: updateFn } } as any,
      { conversationId: "convo-1", igUserId: "ig-1", keywordId: "kw-1", completedAt },
    );

    expect(findManyFn).not.toHaveBeenCalled();
    expect(updateFn).not.toHaveBeenCalled();
  });
});

// The completion path must never be able to fail because of this bookkeeping.
// Dropping the suppression is safe: the worker re-runs the full policy in its
// final pre-send transaction, where conversationCompletedAt suppresses the row
// before any public comment is posted.
describe("suppressRecoveriesForCompletionSafely", () => {
  const input = {
    conversationId: "convo-1",
    igUserId: "ig-1",
    keywordId: "kw-1",
    completedAt: new Date("2026-08-06T15:00:00Z"),
  };

  it("swallows a database failure instead of propagating it", async () => {
    $transaction.mockRejectedValueOnce(new Error("relation does not exist"));
    const { suppressRecoveriesForCompletionSafely } = await import("./dmRecoveryService.js");

    await expect(suppressRecoveriesForCompletionSafely(input)).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "dm_recovery_completion_suppression_failed" }),
      expect.any(String),
    );
  });

  it("opens its own transaction rather than joining the caller's", async () => {
    $transaction.mockImplementationOnce(async (fn: Function) =>
      fn({ dmRecoveryReminder: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } }),
    );
    const { suppressRecoveriesForCompletionSafely } = await import("./dmRecoveryService.js");

    await suppressRecoveriesForCompletionSafely(input);

    expect($transaction).toHaveBeenCalledTimes(1);
  });
});

// The final pre-send authorization reads engagedAt, not reactedAt/postbackAt.
// A recorder that writes only its dedicated timestamp is invisible to it, so a
// reaction arriving during the lease window would not stop the public comment.
describe("reaction and postback feed the shared engagement fields", () => {
  it.each([
    ["reaction", () => recordRecoveryReaction, "reactedAt"],
    ["postback", () => recordRecoveryPostback, "postbackAt"],
  ])("%s records shared engagement alongside its own timestamp", async (kind, getFn, ownField) => {
    findMany.mockResolvedValue([makeRow()]);

    await getFn()({
      instagramMessageId: "mid-1",
      eventAt: new Date("2026-08-06T09:00:00Z"),
      receivedAt: new Date("2026-08-06T09:00:05Z"),
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: expect.objectContaining({
        [ownField]: new Date("2026-08-06T09:00:00Z"),
        engagedAt: new Date("2026-08-06T09:00:00Z"),
        engagedReceivedAt: new Date("2026-08-06T09:00:05Z"),
        firstEngagementKind: kind,
      }),
    });
  });

  it("does not overwrite an engagement kind that arrived first", async () => {
    findMany.mockResolvedValue([
      makeRow({ firstEngagementKind: "inbound_reply", engagedAt: new Date("2026-08-06T08:00:00Z") }),
    ]);

    await recordRecoveryReaction({
      instagramMessageId: "mid-1",
      eventAt: new Date("2026-08-06T09:00:00Z"),
      receivedAt: new Date("2026-08-06T09:00:05Z"),
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: expect.objectContaining({
        firstEngagementKind: "inbound_reply",
        engagedAt: new Date("2026-08-06T08:00:00Z"),
      }),
    });
  });
});
