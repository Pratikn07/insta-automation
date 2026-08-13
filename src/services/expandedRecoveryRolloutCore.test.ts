import { describe, expect, it, vi } from "vitest";
import {
  CleanupCoordinator,
  assertActiveDeploymentBinding,
  assertCommandAllowed,
  assertOperatorIdentity,
  assertRemoteSelectorBinding,
  parseOperatorConfig,
  parseApiAttestation,
  parseDeploymentList,
  parseDeploymentStartOutput,
  parseFirstSendOutput,
  parseHistoricalFlag,
  parseRemoteAttestation,
  parseRolloutState,
  parseSelectionOutput,
  performFailClosedCleanup,
  type OperatorState,
} from "../../scripts/expanded-recovery-rollout-core.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const ENVIRONMENT_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const INSTANCE_ID = "55555555-5555-4555-8555-555555555555";
const GROUP_ID = "66666666-6666-4666-8666-666666666666";
const CAMPAIGN_IDS = [
  "77777777-7777-4777-8777-777777777771",
  "77777777-7777-4777-8777-777777777772",
  "77777777-7777-4777-8777-777777777773",
  "77777777-7777-4777-8777-777777777774",
] as const;
const SOURCE_TREE_SHA = "c".repeat(64);

function environment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    API_BASE: "https://api.example.test",
    EXPECTED_API_HOST: "api.example.test",
    EXPECTED_DATABASE_HOST: "db.example.test",
    EXPECTED_DATABASE_NAME: "app",
    PGURL: "postgresql://audit-user:secret@db.example.test:5432/app?sslmode=require",
    RAILWAY_PROJECT_ID: PROJECT_ID,
    RAILWAY_SERVICE_ID: SERVICE_ID,
    RAILWAY_ENVIRONMENT_ID: ENVIRONMENT_ID,
    RAILWAY_ENVIRONMENT: "production",
    API_SERVICE: "api",
    OWNER_EMAIL: "owner@example.test",
    ...overrides,
  };
}

function state(phase: OperatorState["phase"] = "selected"): OperatorState {
  const config = parseOperatorConfig(environment(), {
    releaseSha: "a".repeat(40),
    selectorSha256: "b".repeat(64),
    sourceTreeSha256: SOURCE_TREE_SHA,
  });
  return {
    version: 3,
    revision: 1,
    phase,
    identity: config.identity,
    historicalPrior: false,
    selectorDeployment: {
      id: DEPLOYMENT_ID,
      instanceId: INSTANCE_ID,
    },
    activeDeploymentId: DEPLOYMENT_ID,
    rollout: {
      groupId: GROUP_ID,
      selectorPhase: "unknown_read_pilot",
      campaigns: [
        { segment: "other", campaignId: CAMPAIGN_IDS[0], candidateCount: 2, decisionHash: "1".repeat(64) },
        { segment: "unknown_cue", campaignId: CAMPAIGN_IDS[1], candidateCount: 3, decisionHash: "2".repeat(64) },
        { segment: "unknown_generic", campaignId: CAMPAIGN_IDS[2], candidateCount: 4, decisionHash: "3".repeat(64) },
        { segment: "unknown_no_name", campaignId: CAMPAIGN_IDS[3], candidateCount: 5, decisionHash: "4".repeat(64) },
      ],
    },
    operation: null,
    cleanup: null,
  };
}

function selectionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "expanded-recovery-selection",
    rolloutGroupId: GROUP_ID,
    phase: "unknown_read_pilot",
    groupHourlyCap: 10,
    dailyCap: 1000,
    holdoutPercent: 0,
    eligibilityPolicyVersion: "eligibility-v4-expanded-audience",
    selectionVersion: "v1-canonical-intents-expanded-audience",
    copyVersion: "recovery-v2",
    onePersonAcrossRollout: true,
    campaigns: [
      { segment: "other", campaignId: CAMPAIGN_IDS[0], candidateCount: 2, excludedPeople: 1, decisionHash: "1".repeat(64) },
      { segment: "unknown_cue", campaignId: CAMPAIGN_IDS[1], candidateCount: 3, excludedPeople: 2, decisionHash: "2".repeat(64) },
      { segment: "unknown_generic", campaignId: CAMPAIGN_IDS[2], candidateCount: 4, excludedPeople: 3, decisionHash: "3".repeat(64) },
      { segment: "unknown_no_name", campaignId: CAMPAIGN_IDS[3], candidateCount: 5, excludedPeople: 4, decisionHash: "4".repeat(64) },
    ],
    ...overrides,
  });
}

describe("operator identity", () => {
  it("accepts only an exact HTTPS API host and exact database host/name", () => {
    const config = parseOperatorConfig(environment(), {
      releaseSha: "a".repeat(40),
      selectorSha256: "b".repeat(64),
      sourceTreeSha256: SOURCE_TREE_SHA,
    });

    expect(config.identity.api).toMatchObject({
      origin: "https://api.example.test",
      host: "api.example.test",
    });
    expect(config.identity.database).toMatchObject({
      protocol: "postgresql:",
      host: "db.example.test",
      port: "5432",
      name: "app",
    });
    expect(config.identity.api.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(config.identity.database.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(config.identity.sourceTreeSha256).toBe(SOURCE_TREE_SHA);
  });

  it.each([
    ["API suffix host", { API_BASE: "https://api.example.test.evil/" }],
    ["API username", { API_BASE: "https://owner@api.example.test/" }],
    ["database suffix host", { PGURL: "postgresql://u:p@db.example.test.evil/app" }],
    ["database name", { PGURL: "postgresql://u:p@db.example.test/not-app" }],
    ["database protocol", { PGURL: "https://u:p@db.example.test/app" }],
  ])("rejects %s", (_label, override) => {
    expect(() => parseOperatorConfig(environment(override), {
      releaseSha: "a".repeat(40),
      selectorSha256: "b".repeat(64),
      sourceTreeSha256: SOURCE_TREE_SHA,
    })).toThrow();
  });

  it("rejects persisted identity drift before a mutation can begin", () => {
    const saved = state();
    const current = parseOperatorConfig(environment({ RAILWAY_SERVICE_ID: "88888888-8888-4888-8888-888888888888" }), {
      releaseSha: "a".repeat(40),
      selectorSha256: "b".repeat(64),
      sourceTreeSha256: SOURCE_TREE_SHA,
    });

    expect(() => assertOperatorIdentity(saved, current.identity)).toThrow("operator_identity_drift");
  });

  it("refuses a persisted state missing any bound identity field", () => {
    const serialized = JSON.parse(JSON.stringify(state())) as Record<string, unknown>;
    const identity = serialized.identity as Record<string, unknown>;
    delete identity.releaseSha;

    expect(() => parseRolloutState(JSON.stringify(serialized))).toThrow();
  });

  it("persists the original historical flag before an inert deployment ID exists", () => {
    const bootstrap = {
      ...state("inert"),
      phase: "deploying_inert",
      historicalPrior: true,
      selectorDeployment: null,
      activeDeploymentId: null,
      rollout: null,
    };
    expect(parseRolloutState(JSON.stringify(bootstrap))).toMatchObject({
      phase: "deploying_inert",
      historicalPrior: true,
      selectorDeployment: null,
      activeDeploymentId: null,
    });
  });

  it("requires an exact durable operation record for an uncertain selector run", () => {
    const selecting = JSON.parse(JSON.stringify(state("selecting"))) as Record<string, unknown>;
    selecting.rollout = null;
    selecting.operation = {
      kind: "select",
      selectorPhase: "unknown_read_pilot",
      startedAt: "2026-08-12T00:00:00.000Z",
    };
    expect(parseRolloutState(JSON.stringify(selecting))).toMatchObject({
      phase: "selecting",
      operation: { kind: "select", selectorPhase: "unknown_read_pilot" },
    });

    selecting.operation = null;
    expect(() => parseRolloutState(JSON.stringify(selecting))).toThrow();
  });

  it("rejects a post-selection phase without its frozen rollout manifest", () => {
    const invalid = { ...state("selected"), rollout: null };
    expect(() => parseRolloutState(JSON.stringify(invalid))).toThrow();
  });
});

describe("machine-readable selector output", () => {
  it("accepts the exact four-segment contract in canonical order", () => {
    const result = parseSelectionOutput(selectionJson());
    expect(result.campaigns.map(({ segment }) => segment)).toEqual([
      "other", "unknown_cue", "unknown_generic", "unknown_no_name",
    ]);
    expect(result.campaigns.map(({ campaignId }) => campaignId)).toEqual(CAMPAIGN_IDS);
  });

  it.each([
    ["human prefix", `drafts created\n${selectionJson()}`],
    ["wrong cap", selectionJson({ groupHourlyCap: 11 })],
    ["wrong order", selectionJson({ campaigns: JSON.parse(selectionJson()).campaigns.reverse() })],
    ["duplicate campaign", selectionJson({ campaigns: JSON.parse(selectionJson()).campaigns.map((row: Record<string, unknown>, index: number) => index === 1 ? { ...row, campaignId: CAMPAIGN_IDS[0] } : row) })],
    ["zero candidates with id", selectionJson({ campaigns: JSON.parse(selectionJson()).campaigns.map((row: Record<string, unknown>, index: number) => index === 0 ? { ...row, candidateCount: 0 } : row) })],
  ])("rejects %s", (_label, output) => {
    expect(() => parseSelectionOutput(output)).toThrow();
  });
});

describe("remote selector binding", () => {
  const attestation = () => JSON.stringify({
    schemaVersion: 1,
    kind: "expanded-recovery-remote-attestation",
    railway: {
      projectId: PROJECT_ID,
      serviceId: SERVICE_ID,
      environmentId: ENVIRONMENT_ID,
      deploymentId: DEPLOYMENT_ID,
    },
    releaseSha: "a".repeat(40),
    sourceTreeSha256: SOURCE_TREE_SHA,
    selectorSha256: "b".repeat(64),
    database: { protocol: "postgresql:", host: "db.example.test", port: "5432", name: "app" },
    historicalEnabled: false,
  });

  it("binds the requested SSH instance to the saved deployment, release, selector, and database", () => {
    const saved = state("inert");
    saved.selectorDeployment.instanceId = null;
    const parsed = parseRemoteAttestation(attestation());

    expect(() => assertRemoteSelectorBinding(saved, INSTANCE_ID, parsed)).not.toThrow();
  });

  it.each([
    ["deployment", { railway: { projectId: PROJECT_ID, serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, deploymentId: "99999999-9999-4999-8999-999999999999" } }],
    ["source tree", { sourceTreeSha256: "e".repeat(64) }],
    ["selector", { selectorSha256: "f".repeat(64) }],
    ["database", { database: { protocol: "postgresql:", host: "other.example.test", port: "5432", name: "app" } }],
    ["database protocol", { database: { protocol: "postgres:", host: "db.example.test", port: "5432", name: "app" } }],
    ["historical flag", { historicalEnabled: true }],
  ])("rejects a mismatched %s", (_label, override) => {
    const value = { ...JSON.parse(attestation()), ...override };
    expect(() => assertRemoteSelectorBinding(state("inert"), INSTANCE_ID, parseRemoteAttestation(JSON.stringify(value)))).toThrow("remote_selector_identity_mismatch");
  });

  it("rejects log text wrapped around the attestation", () => {
    expect(() => parseRemoteAttestation(`connected\n${attestation()}`)).toThrow();
  });
});

describe("active API deployment binding", () => {
  const apiAttestation = () => ({
    ok: true,
    env: "production",
    deployment: {
      projectId: PROJECT_ID,
      serviceId: SERVICE_ID,
      environmentId: ENVIRONMENT_ID,
      deploymentId: DEPLOYMENT_ID,
      releaseSha: "a".repeat(40),
      sourceTreeSha256: SOURCE_TREE_SHA,
      selectorSha256: "b".repeat(64),
      historicalEnabled: false,
    },
  });

  it("proves the public API is serving the exact saved deployment and flag", () => {
    const parsed = parseApiAttestation(apiAttestation());
    expect(() => assertActiveDeploymentBinding(state("inert"), parsed, false)).not.toThrow();
  });

  it.each([
    ["deployment", { deploymentId: "99999999-9999-4999-8999-999999999999" }],
    ["release", { releaseSha: "c".repeat(40) }],
    ["source tree", { sourceTreeSha256: "e".repeat(64) }],
    ["selector", { selectorSha256: "e".repeat(64) }],
    ["historical flag", { historicalEnabled: true }],
  ])("rejects a mismatched %s", (_label, deploymentOverride) => {
    const value = apiAttestation();
    value.deployment = { ...value.deployment, ...deploymentOverride };
    expect(() => assertActiveDeploymentBinding(state("inert"), parseApiAttestation(value), false)).toThrow("active_api_identity_mismatch");
  });
});

describe("fail-closed cleanup", () => {
  it("durably locks first, retries independent pause and deployment restoration, and exits 75 when either remains unverified", async () => {
    const writes: OperatorState[] = [];
    const pauseAndVerify = vi.fn()
      .mockRejectedValueOnce(new Error("pause unavailable"))
      .mockResolvedValueOnce(undefined);
    const restoreHistoricalFlag = vi.fn()
      .mockRejectedValue(new Error("rollback deployment failed"));

    const result = await performFailClosedCleanup({
      state: state("running"),
      originalExitCode: 1,
      reason: "verification failed",
      writeState: async (next) => { writes.push(structuredClone(next)); },
      pauseAndVerify,
      restoreHistoricalFlag,
      sleep: async () => undefined,
    });

    expect(writes[0]).toMatchObject({
      phase: "cleanup_required",
      cleanup: { required: true, pauseVerified: false, historicalVerified: false },
    });
    expect(pauseAndVerify).toHaveBeenCalledTimes(2);
    expect(restoreHistoricalFlag).toHaveBeenCalledTimes(3);
    expect(result.exitCode).toBe(75);
    expect(result.state).toMatchObject({
      phase: "cleanup_required",
      cleanup: { required: true, pauseVerified: true, historicalVerified: false },
    });
    expect(writes.at(-1)).toEqual(result.state);
  });

  it("keeps cleanup total and durably records the lock after initial state-write retries fail", async () => {
    const writes: OperatorState[] = [];
    let attempts = 0;
    const result = await performFailClosedCleanup({
      state: state("running"),
      originalExitCode: 1,
      reason: "state storage was briefly unavailable",
      writeState: async (next) => {
        attempts += 1;
        if (attempts <= 3) throw new Error("disk unavailable");
        writes.push(structuredClone(next));
      },
      pauseAndVerify: vi.fn().mockResolvedValue(undefined),
      restoreHistoricalFlag: vi.fn().mockResolvedValue(undefined),
      sleep: async () => undefined,
    });

    expect(result.exitCode).toBe(75);
    expect(result.state).toMatchObject({
      phase: "cleanup_required",
      cleanup: { pauseVerified: true, historicalVerified: true },
    });
    expect(writes.at(-1)).toEqual(result.state);
  });

  it("returns a recoverable phase only after both safety proofs succeed", async () => {
    const writes: OperatorState[] = [];
    const result = await performFailClosedCleanup({
      state: state("deployed"),
      originalExitCode: 143,
      reason: "SIGTERM",
      writeState: async (next) => { writes.push(structuredClone(next)); },
      pauseAndVerify: vi.fn().mockResolvedValue(undefined),
      restoreHistoricalFlag: vi.fn().mockResolvedValue({ activeDeploymentId: "99999999-9999-4999-8999-999999999999" }),
      sleep: async () => undefined,
    });

    expect(result.exitCode).toBe(143);
    expect(result.state).toMatchObject({
      phase: "recovery_ready",
      cleanup: null,
      operation: null,
      activeDeploymentId: "99999999-9999-4999-8999-999999999999",
    });
    expect(writes.at(-1)).toEqual(result.state);
  });

  it("re-verifies both safety conditions during retry instead of trusting stale partial flags", async () => {
    const prior = state("cleanup_required");
    prior.cleanup = {
      required: true,
      reason: "prior failure",
      requestedAt: "2026-08-12T00:00:00.000Z",
      pauseVerified: true,
      historicalVerified: true,
    };
    const pauseAndVerify = vi.fn().mockRejectedValue(new Error("campaign resumed externally"));
    const restoreHistoricalFlag = vi.fn().mockResolvedValue(undefined);

    const result = await performFailClosedCleanup({
      state: prior,
      originalExitCode: 0,
      reason: "retry cleanup",
      writeState: async () => undefined,
      pauseAndVerify,
      restoreHistoricalFlag,
      sleep: async () => undefined,
    });

    expect(pauseAndVerify).toHaveBeenCalledTimes(3);
    expect(restoreHistoricalFlag).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      exitCode: 75,
      state: {
        phase: "cleanup_required",
        cleanup: { pauseVerified: false, historicalVerified: true },
      },
    });
  });

  it("coalesces repeated INT/TERM/HUP cleanup requests into one signal-safe run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cleanup = vi.fn(async () => { await gate; return 75; });
    const coordinator = new CleanupCoordinator(cleanup);

    const first = coordinator.request("SIGINT", 130);
    const second = coordinator.request("SIGTERM", 143);
    const third = coordinator.request("SIGHUP", 129);
    release();

    await expect(Promise.all([first, second, third])).resolves.toEqual([75, 75, 75]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith("SIGINT", 130);
  });
});

describe("durable phase gates", () => {
  it("allows only retry-cleanup while cleanup_required is set", () => {
    expect(() => assertCommandAllowed(state("cleanup_required"), "pause")).toThrow("cleanup_required_lock");
    expect(() => assertCommandAllowed(state("cleanup_required"), "approve-start")).toThrow("cleanup_required_lock");
    expect(() => assertCommandAllowed(state("cleanup_required"), "retry-cleanup")).not.toThrow();
  });

  it("allows adoption after an uncertain selecting phase and safe approval resume phases", () => {
    expect(() => assertCommandAllowed(state("selecting"), "adopt")).not.toThrow();
    for (const phase of ["selected", "recovery_ready", "approved", "deployed"] as const) {
      expect(() => assertCommandAllowed(state(phase), "approve-start")).not.toThrow();
    }
  });
});

describe("external machine contracts", () => {
  it("extracts one exact deployment start and one exact listed status", () => {
    expect(parseDeploymentStartOutput(JSON.stringify({ id: DEPLOYMENT_ID }))).toBe(DEPLOYMENT_ID);
    expect(parseDeploymentList(JSON.stringify([
      { id: DEPLOYMENT_ID, status: "SUCCESS" },
      { id: "99999999-9999-4999-8999-999999999999", status: "FAILED" },
    ]), DEPLOYMENT_ID)).toEqual({ id: DEPLOYMENT_ID, status: "SUCCESS" });
  });

  it("rejects missing, duplicate, or malformed deployment records", () => {
    expect(() => parseDeploymentList("[]", DEPLOYMENT_ID)).toThrow();
    expect(() => parseDeploymentList(JSON.stringify([
      { id: DEPLOYMENT_ID, status: "SUCCESS" },
      { id: DEPLOYMENT_ID, status: "SUCCESS" },
    ]), DEPLOYMENT_ID)).toThrow();
    expect(() => parseDeploymentStartOutput(`log\n${JSON.stringify({ id: DEPLOYMENT_ID })}`)).toThrow();
  });

  it.each([
    [{ DM_RECOVERY_HISTORICAL_ENABLED: "true" }, true],
    [{ DM_RECOVERY_HISTORICAL_ENABLED: "false", ANOTHER_SECRET: "not-logged" }, false],
  ])("parses the exact variable-list key without accepting another value", (value, expected) => {
    expect(parseHistoricalFlag(JSON.stringify(value))).toBe(expected);
  });

  it.each([
    { value: true },
    { dm_recovery_historical_enabled: "false" },
    { DM_RECOVERY_HISTORICAL_ENABLED: "maybe" },
    [],
  ])("rejects an unsupported or ambiguous variable-list record %#", (value) => {
    expect(() => parseHistoricalFlag(JSON.stringify(value))).toThrow();
  });

  it("parses a strict first-send record", () => {
    expect(parseFirstSendOutput(JSON.stringify({
      schemaVersion: 1,
      kind: "expanded-recovery-first-send",
      replyId: "reply-1",
      parentCommentId: "comment-1",
      text: "DM @tinysoho SLEEP",
    }))).toEqual({
      schemaVersion: 1,
      kind: "expanded-recovery-first-send",
      replyId: "reply-1",
      parentCommentId: "comment-1",
      text: "DM @tinysoho SLEEP",
    });
    expect(() => parseFirstSendOutput("prefix\n{}")).toThrow();
  });
});
