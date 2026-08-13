import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExpandedRecoveryRolloutOperator,
  RolloutStateStore,
  type OperatorCommandRunner,
  type OperatorStateRepository,
  type RunOptions,
} from "../../scripts/expanded-recovery-rollout.js";
import {
  parseOperatorConfig,
  parseRolloutState,
  type OperatorConfig,
  type OperatorState,
} from "../../scripts/expanded-recovery-rollout-core.js";

const ROOT = "/operator-test-root";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const ENVIRONMENT_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const INSTANCE_ID = "55555555-5555-4555-8555-555555555555";
const GROUP_ID = "66666666-6666-4666-8666-666666666666";
const CAMPAIGN_ID = "77777777-7777-4777-8777-777777777777";
const ROLLBACK_DEPLOYMENT_ID = "88888888-8888-4888-8888-888888888888";
const RELEASE_SHA = "a".repeat(40);
const SELECTOR_SHA = "b".repeat(64);
const SOURCE_TREE_SHA = "c".repeat(64);
const DECISION_HASH = "d".repeat(64);

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    API_BASE: "https://api.example.test",
    EXPECTED_API_HOST: "api.example.test",
    EXPECTED_DATABASE_HOST: "db.example.test",
    EXPECTED_DATABASE_NAME: "app",
    PGURL: "postgresql://audit-user:database-secret@db.example.test:5432/app?sslmode=require",
    RAILWAY_PROJECT_ID: PROJECT_ID,
    RAILWAY_SERVICE_ID: SERVICE_ID,
    RAILWAY_ENVIRONMENT_ID: ENVIRONMENT_ID,
    RAILWAY_ENVIRONMENT: "production",
    API_SERVICE: "api",
    OWNER_EMAIL: "owner@example.test",
    OWNER_TOKEN: "owner-token-secret",
    META_ACCESS_TOKEN: "meta-token-secret",
    SELECTOR_PHASE: "unknown_read_pilot",
    DEPLOYMENT_INSTANCE_ID: INSTANCE_ID,
    ...overrides,
  };
}

function config(env = environment()): OperatorConfig {
  return parseOperatorConfig(env, {
    releaseSha: RELEASE_SHA,
    selectorSha256: SELECTOR_SHA,
    sourceTreeSha256: SOURCE_TREE_SHA,
  });
}

function selectionJson(phase: "confirmed_failure" | "unknown_read_pilot" = "unknown_read_pilot"): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "expanded-recovery-selection",
    rolloutGroupId: GROUP_ID,
    phase,
    groupHourlyCap: 10,
    dailyCap: 1000,
    holdoutPercent: 0,
    eligibilityPolicyVersion: "eligibility-v4-expanded-audience",
    selectionVersion: "v1-canonical-intents-expanded-audience",
    copyVersion: "recovery-v2",
    onePersonAcrossRollout: true,
    campaigns: [
      { segment: "other", campaignId: CAMPAIGN_ID, candidateCount: 1, excludedPeople: 2, decisionHash: DECISION_HASH },
      { segment: "unknown_cue", campaignId: null, candidateCount: 0, excludedPeople: 3, decisionHash: "1".repeat(64) },
      { segment: "unknown_generic", campaignId: null, candidateCount: 0, excludedPeople: 4, decisionHash: "2".repeat(64) },
      { segment: "unknown_no_name", campaignId: null, candidateCount: 0, excludedPeople: 5, decisionHash: "3".repeat(64) },
    ],
  });
}

function rolloutState(
  phase: OperatorState["phase"],
  identity = config().identity,
): OperatorState {
  const selecting = phase === "selecting";
  const inert = phase === "inert";
  const cleanup = phase === "cleanup_required";
  const operation = phase === "approving"
    ? { kind: "approve", startedAt: "2026-08-12T00:00:00.000Z" }
    : phase === "enabling"
      ? { kind: "enable", startedAt: "2026-08-12T00:00:00.000Z" }
      : phase === "resuming"
        ? { kind: "resume", startedAt: "2026-08-12T00:00:00.000Z" }
        : phase === "verifying"
          ? { kind: "verify", startedAt: "2026-08-12T00:00:00.000Z" }
          : selecting
            ? { kind: "select", selectorPhase: "unknown_read_pilot", startedAt: "2026-08-12T00:00:00.000Z" }
            : null;
  return parseRolloutState(JSON.stringify({
    version: 3,
    revision: 1,
    phase,
    identity,
    historicalPrior: false,
    selectorDeployment: { id: DEPLOYMENT_ID, instanceId: selecting ? INSTANCE_ID : null },
    activeDeploymentId: DEPLOYMENT_ID,
    rollout: inert || selecting ? null : {
      groupId: GROUP_ID,
      selectorPhase: "unknown_read_pilot",
      campaigns: [
        { segment: "other", campaignId: CAMPAIGN_ID, candidateCount: 1, decisionHash: DECISION_HASH },
        { segment: "unknown_cue", campaignId: null, candidateCount: 0, decisionHash: "1".repeat(64) },
        { segment: "unknown_generic", campaignId: null, candidateCount: 0, decisionHash: "2".repeat(64) },
        { segment: "unknown_no_name", campaignId: null, candidateCount: 0, decisionHash: "3".repeat(64) },
      ],
    },
    operation,
    cleanup: cleanup ? {
      required: true,
      reason: "prior cleanup failure",
      requestedAt: "2026-08-12T00:00:00.000Z",
      pauseVerified: true,
      historicalVerified: true,
    } : null,
  }));
}

function remoteAttestation(): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "expanded-recovery-remote-attestation",
    railway: {
      projectId: PROJECT_ID,
      serviceId: SERVICE_ID,
      environmentId: ENVIRONMENT_ID,
      deploymentId: DEPLOYMENT_ID,
    },
    releaseSha: RELEASE_SHA,
    sourceTreeSha256: SOURCE_TREE_SHA,
    selectorSha256: SELECTOR_SHA,
    database: { protocol: "postgresql:", host: "db.example.test", port: "5432", name: "app" },
    historicalEnabled: false,
  });
}

function health(deploymentId: string, historicalEnabled: boolean) {
  return {
    ok: true,
    env: "production",
    deployment: {
      projectId: PROJECT_ID,
      serviceId: SERVICE_ID,
      environmentId: ENVIRONMENT_ID,
      deploymentId,
      releaseSha: RELEASE_SHA,
      sourceTreeSha256: SOURCE_TREE_SHA,
      selectorSha256: SELECTOR_SHA,
      historicalEnabled,
    },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

class MemoryStore implements OperatorStateRepository {
  readonly writes: OperatorState[] = [];
  constructor(public current: OperatorState | null) {}
  async read(): Promise<OperatorState | null> { return this.current && structuredClone(this.current); }
  async write(value: OperatorState): Promise<OperatorState> {
    if ((this.current?.revision ?? 0) !== value.revision) {
      throw new Error("rollout_state_stale_write");
    }
    this.current = parseRolloutState(JSON.stringify({ ...value, revision: value.revision + 1 }));
    this.writes.push(structuredClone(this.current));
    return structuredClone(this.current);
  }
}

function runnerWith(
  implementation: (command: string, args: string[], options?: RunOptions) => Promise<string>,
): OperatorCommandRunner & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn(implementation) } as OperatorCommandRunner & { run: ReturnType<typeof vi.fn> };
}

function successfulRunner(deploymentId = ROLLBACK_DEPLOYMENT_ID) {
  return runnerWith(async (command, args) => {
    if (command === "railway" && args[0] === "variable") return "";
    if (command === "railway" && args[0] === "up") return JSON.stringify({ id: deploymentId });
    if (command === "railway" && args[0] === "deployment") {
      return JSON.stringify([{ id: deploymentId, status: "SUCCESS" }]);
    }
    if (command === "railway" && args[0] === "ssh" && args.includes("--eval")) {
      return remoteAttestation();
    }
    if (command === "railway" && args[0] === "ssh") return selectionJson();
    if (command.endsWith("tsx") && args[1] === "first-send") {
      return JSON.stringify({
        schemaVersion: 1,
        kind: "expanded-recovery-first-send",
        replyId: "reply-1",
        parentCommentId: "comment-1",
        text: "DM @tinysoho SLEEP",
      });
    }
    if (command.endsWith("tsx")) return JSON.stringify({ ok: true });
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  });
}

function operator(
  store: MemoryStore,
  runner: OperatorCommandRunner,
  fetchImpl: typeof fetch,
  env = environment(),
  currentConfig = config(env),
) {
  return new ExpandedRecoveryRolloutOperator(ROOT, currentConfig, store, runner, {
    environment: env,
    fetch: fetchImpl,
    sleep: async (_milliseconds, signal) => {
      if (signal?.aborted) throw new Error("operator_interrupted");
    },
    now: () => new Date("2026-08-12T03:00:00.000Z"),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("expanded recovery operator cleanup", () => {
  it("retries a failed rollback deployment three times, durably locks cleanup_required, and exits 75", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const store = new MemoryStore(rolloutState("running"));
    const runner = runnerWith(async (command, args) => {
      if (command.endsWith("tsx")) return JSON.stringify({ ok: true });
      if (command === "railway" && args[0] === "variable") return "";
      if (command === "railway" && args[0] === "up") throw new Error("deployment failed");
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });
    let paused = false;
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = urlOf(input);
      if (url.pathname === "/api/me") return json({ email: "wrong-owner@example.test" });
      if (url.pathname.endsWith("/pause") && init?.method === "POST") {
        paused = true;
        return json({ pausedCampaignIds: [CAMPAIGN_ID] });
      }
      if (url.pathname === "/api/historical-recovery/campaigns") {
        return json({ campaigns: [{ id: CAMPAIGN_ID, rolloutGroupId: GROUP_ID, state: paused ? "paused" : "running" }] });
      }
      return json({});
    }) as unknown as typeof fetch;

    await expect(operator(store, runner, fetchImpl).execute("verify")).resolves.toBe(75);

    expect(runner.run.mock.calls.filter(([, args]) => args[0] === "up")).toHaveLength(3);
    expect(store.current).toMatchObject({
      phase: "cleanup_required",
      cleanup: { required: true, pauseVerified: true, historicalVerified: false },
    });
    expect(store.writes[0]).toMatchObject({ phase: "cleanup_required" });
    const childArguments = JSON.stringify(runner.run.mock.calls.map(([command, args]) => [command, args]));
    expect(childArguments).not.toContain("owner-token-secret");
    expect(childArguments).not.toContain("database-secret");
    expect(JSON.stringify(store.current)).not.toContain("database-secret");
  });

  it("retries three successful rollback deployments whose serving identity cannot be verified", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const store = new MemoryStore(rolloutState("running"));
    const runner = successfulRunner();
    let healthCalls = 0;
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = urlOf(input);
      if (url.pathname === "/api/me") return json({ email: "wrong-owner@example.test" });
      if (url.pathname.endsWith("/pause") && init?.method === "POST") {
        return json({ pausedCampaignIds: [CAMPAIGN_ID] });
      }
      if (url.pathname === "/api/historical-recovery/campaigns") {
        return json({ campaigns: [{ id: CAMPAIGN_ID, rolloutGroupId: GROUP_ID, state: "paused" }] });
      }
      if (url.pathname === "/health") {
        healthCalls += 1;
        return json(health(DEPLOYMENT_ID, false));
      }
      return json({});
    }) as unknown as typeof fetch;

    await expect(operator(store, runner, fetchImpl).execute("verify")).resolves.toBe(75);

    expect(runner.run.mock.calls.filter(([, args]) => args[0] === "up")).toHaveLength(3);
    expect(healthCalls).toBe(90);
    expect(store.current).toMatchObject({
      phase: "cleanup_required",
      cleanup: { pauseVerified: true, historicalVerified: false },
    });
  });

  it("rejects saved/current identity drift before any API or Railway mutation", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const saved = rolloutState("selected");
    const driftedEnvironment = environment({
      RAILWAY_SERVICE_ID: "99999999-9999-4999-8999-999999999999",
    });
    const store = new MemoryStore(saved);
    const runner = runnerWith(async () => "");
    const fetchImpl = vi.fn(async () => json({})) as unknown as typeof fetch;

    await expect(operator(
      store,
      runner,
      fetchImpl,
      driftedEnvironment,
      config(driftedEnvironment),
    ).execute("approve-start")).resolves.toBe(75);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(store.current).toMatchObject({ phase: "cleanup_required" });
  });

  it("re-runs both safety proofs on retry and clears the global lock only after exact verification", async () => {
    const store = new MemoryStore(rolloutState("cleanup_required"));
    const runner = successfulRunner();
    let pauseCalls = 0;
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/pause") && init?.method === "POST") {
        pauseCalls += 1;
        return json({ pausedCampaignIds: [CAMPAIGN_ID] });
      }
      if (url.pathname === "/api/historical-recovery/campaigns") {
        return json({ campaigns: [{ id: CAMPAIGN_ID, rolloutGroupId: GROUP_ID, state: "paused" }] });
      }
      if (url.pathname === "/health") return json(health(ROLLBACK_DEPLOYMENT_ID, false));
      return json({});
    }) as unknown as typeof fetch;

    await expect(operator(store, runner, fetchImpl).execute("retry-cleanup")).resolves.toBe(0);

    expect(pauseCalls).toBe(1);
    expect(runner.run.mock.calls.filter(([, args]) => args[0] === "up")).toHaveLength(1);
    expect(store.current).toMatchObject({
      phase: "recovery_ready",
      activeDeploymentId: ROLLBACK_DEPLOYMENT_ID,
      cleanup: null,
    });
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)("handles %s with one fail-closed cleanup and its conventional status", async (signal, status) => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const store = new MemoryStore(rolloutState("running"));
    const runner = successfulRunner();
    let ownerStarted!: () => void;
    const started = new Promise<void>((resolve) => { ownerStarted = resolve; });
    const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.pathname === "/api/me") {
        ownerStarted();
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
        });
      }
      if (url.pathname.endsWith("/pause") && init?.method === "POST") {
        return Promise.resolve(json({ pausedCampaignIds: [CAMPAIGN_ID] }));
      }
      if (url.pathname === "/api/historical-recovery/campaigns") {
        return Promise.resolve(json({ campaigns: [{ id: CAMPAIGN_ID, rolloutGroupId: GROUP_ID, state: "paused" }] }));
      }
      if (url.pathname === "/health") return Promise.resolve(json(health(ROLLBACK_DEPLOYMENT_ID, false)));
      return Promise.resolve(json({}));
    }) as unknown as typeof fetch;
    const instance = operator(store, runner, fetchImpl);

    const execution = instance.execute("verify");
    await started;
    instance.requestSignal(signal);
    instance.requestSignal(signal === "SIGINT" ? "SIGTERM" : "SIGINT");

    await expect(execution).resolves.toBe(status);
    expect(runner.run.mock.calls.filter(([, args]) => args[0] === "up")).toHaveLength(1);
    expect(store.current).toMatchObject({ phase: "recovery_ready", cleanup: null });
  });
});

describe("expanded recovery operator resumability", () => {
  it("leaves malformed selector output in selecting and adopts only the saved selector phase", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const store = new MemoryStore(rolloutState("inert"));
    let selectorRuns = 0;
    const runner = runnerWith(async (command, args) => {
      if (command.endsWith("tsx")) return JSON.stringify({ ok: true });
      if (command === "railway" && args[0] === "ssh" && args.includes("--eval")) return remoteAttestation();
      if (command === "railway" && args[0] === "ssh") {
        selectorRuns += 1;
        return "selector may have written drafts\nnot-json";
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = urlOf(input);
      if (url.pathname === "/health") return json(health(DEPLOYMENT_ID, false));
      if (url.pathname === "/api/me") return json({ email: "owner@example.test" });
      if (url.pathname === "/api/recovery-reminders/metrics") return json({ health: { circuitOpen: false } });
      return json({});
    }) as unknown as typeof fetch;

    await expect(operator(store, runner, fetchImpl).execute("select")).resolves.toBe(1);
    expect(store.current).toMatchObject({
      phase: "selecting",
      selectorDeployment: { instanceId: INSTANCE_ID },
      operation: { kind: "select", selectorPhase: "unknown_read_pilot" },
    });

    const wrongEnv = environment({ ADOPT_SELECTION_JSON: selectionJson("confirmed_failure") });
    await expect(operator(store, runner, fetchImpl, wrongEnv).execute("adopt")).resolves.toBe(1);
    expect(store.current?.phase).toBe("selecting");

    const validEnv = environment({ ADOPT_SELECTION_JSON: selectionJson() });
    await expect(operator(store, runner, fetchImpl, validEnv).execute("adopt")).resolves.toBe(0);
    expect(selectorRuns).toBe(1);
    expect(store.current).toMatchObject({
      phase: "selected",
      rollout: { groupId: GROUP_ID, selectorPhase: "unknown_read_pilot" },
      operation: null,
    });
  });

  it("resumes safely from approved, binds the exact enabled deployment, and sends the decision hash", async () => {
    const store = new MemoryStore(rolloutState("approved"));
    let deploymentStarted = false;
    const runner = runnerWith(async (command, args) => {
      if (command.endsWith("tsx")) return JSON.stringify({ ok: true });
      if (command === "railway" && args[0] === "variable") return "";
      if (command === "railway" && args[0] === "up") {
        deploymentStarted = true;
        return JSON.stringify({ id: ROLLBACK_DEPLOYMENT_ID });
      }
      if (command === "railway" && args[0] === "deployment") {
        return JSON.stringify([{ id: ROLLBACK_DEPLOYMENT_ID, status: "SUCCESS" }]);
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    });
    const resumeBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = urlOf(input);
      if (url.pathname === "/api/me") return json({ email: "owner@example.test" });
      if (url.pathname === "/api/recovery-reminders/metrics") return json({ health: { circuitOpen: false } });
      if (url.pathname === "/health") {
        return json(health(deploymentStarted ? ROLLBACK_DEPLOYMENT_ID : DEPLOYMENT_ID, deploymentStarted));
      }
      if (url.pathname === "/api/historical-recovery/campaigns") return json({ sendingEnabled: true });
      if (url.pathname.endsWith("/resume") && init?.method === "POST") {
        resumeBodies.push(JSON.parse(String(init.body)));
        return json({ ok: true, state: "running", campaignIds: [CAMPAIGN_ID] });
      }
      return json({});
    }) as unknown as typeof fetch;

    await expect(operator(store, runner, fetchImpl).execute("approve-start")).resolves.toBe(0);

    expect(fetchImpl.mock.calls.some(([input]) => urlOf(input).pathname.endsWith("/approve"))).toBe(false);
    expect(resumeBodies).toEqual([{
      selectorPhase: "unknown_read_pilot",
      campaigns: [{ id: CAMPAIGN_ID, segment: "other", decisionHash: DECISION_HASH }],
    }]);
    expect(store.current).toMatchObject({
      phase: "running",
      activeDeploymentId: ROLLBACK_DEPLOYMENT_ID,
      operation: null,
    });
  });

  it("accepts completed campaigns during exact first-send and Meta verification", async () => {
    const store = new MemoryStore(rolloutState("completed"));
    const runner = successfulRunner(DEPLOYMENT_ID);
    const metaHeaders: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = urlOf(input);
      if (url.hostname === "graph.instagram.com") {
        metaHeaders.push(new Headers(init?.headers).get("Authorization") ?? "");
        return json({ id: "reply-1", parent_id: "comment-1", text: "DM @tinysoho SLEEP" });
      }
      if (url.pathname === "/api/me") return json({ email: "owner@example.test" });
      if (url.pathname === "/health") return json(health(DEPLOYMENT_ID, true));
      if (url.pathname === "/api/recovery-reminders/metrics") return json({ health: { circuitOpen: false } });
      return json({});
    }) as unknown as typeof fetch;

    await expect(operator(store, runner, fetchImpl).execute("verify")).resolves.toBe(0);

    expect(metaHeaders).toEqual(["Bearer meta-token-secret"]);
    expect(store.current).toMatchObject({ phase: "verified", operation: null });
    const childArguments = JSON.stringify(runner.run.mock.calls.map(([command, args]) => [command, args]));
    expect(childArguments).not.toContain("meta-token-secret");
  });
});

describe("rollout state durability", () => {
  it("atomically writes a strict mode-0600 state file without secret URLs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "expanded-recovery-state-"));
    const file = path.join(directory, "state.json");
    try {
      const store = new RolloutStateStore(file);
      const initial = rolloutState("running");
      initial.revision = 0;
      await store.write(initial);

      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await store.read()).toMatchObject({ phase: "running" });
      const serialized = await readFile(file, "utf8");
      expect(serialized).not.toContain("database-secret");
      expect(serialized).not.toContain("owner-token-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a stale writer instead of overwriting a newer cleanup lock", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "expanded-recovery-cas-"));
    const file = path.join(directory, "state.json");
    try {
      const store = new RolloutStateStore(file);
      const initial = rolloutState("running");
      initial.revision = 0;
      const persisted = await store.write(initial);
      const stale = structuredClone(persisted);
      await store.write({
        ...persisted,
        phase: "cleanup_required",
        cleanup: {
          required: true,
          reason: "safety lock",
          requestedAt: "2026-08-12T00:00:00.000Z",
          pauseVerified: false,
          historicalVerified: false,
        },
      });
      await expect(store.write({ ...stale, phase: "verified" })).rejects.toThrow(
        "rollout_state_stale_write",
      );
      expect(await store.read()).toMatchObject({ phase: "cleanup_required" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
