#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CleanupCoordinator,
  assertActiveDeploymentBinding,
  assertCommandAllowed,
  assertOperatorIdentity,
  assertRemoteSelectorBinding,
  parseApiAttestation,
  parseDeploymentList,
  parseDeploymentStartOutput,
  parseFirstSendOutput,
  parseHistoricalFlag,
  parseOperatorConfig,
  parseRemoteAttestation,
  parseRolloutState,
  parseSelectionOutput,
  performFailClosedCleanup,
  type OperatorCommand,
  type OperatorConfig,
  type OperatorState,
  type SelectionOutput,
} from "./expanded-recovery-rollout-core.js";

const TERMINAL_DEPLOYMENT_FAILURES = new Set([
  "FAILED", "CRASHED", "REMOVED", "CANCELLED", "CANCELED", "ERROR",
]);
const PENDING_DEPLOYMENT_STATES = new Set([
  "WAITING", "QUEUED", "BUILDING", "DEPLOYING", "INITIALIZING", "PENDING", "IN_PROGRESS",
]);
const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
const ARTIFACT_FILE = ".expanded-recovery-artifact.json";
const REMOTE_ATTESTATION_PROGRAM = String.raw`
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const database = new URL(process.env.DATABASE_URL ?? "");
const historical = process.env.DM_RECOVERY_HISTORICAL_ENABLED;
const artifact = JSON.parse(readFileSync(".expanded-recovery-artifact.json", "utf8"));
const sourceTree = createHash("sha256");
for (const relative of artifact.files) {
  sourceTree.update(relative).update("\0").update(readFileSync(relative)).update("\0");
}
const record = {
  schemaVersion: 1,
  kind: "expanded-recovery-remote-attestation",
  railway: {
    projectId: process.env.RAILWAY_PROJECT_ID,
    serviceId: process.env.RAILWAY_SERVICE_ID,
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID,
  },
  releaseSha: artifact.releaseSha,
  sourceTreeSha256: sourceTree.digest("hex"),
  selectorSha256: createHash("sha256").update(readFileSync("scripts/select-expanded-historical-recovery.ts")).digest("hex"),
  database: { protocol: database.protocol, host: database.hostname, port: database.port || "5432", name: decodeURIComponent(database.pathname.replace(/^\//, "")) },
  historicalEnabled: historical === "true" ? true : historical === "false" ? false : null,
};
process.stdout.write(JSON.stringify(record));
`;

export type RunOptions = {
  input?: string;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
};

export type OperatorCommandRunner = {
  run(command: string, args: string[], options?: RunOptions): Promise<string>;
};

export type OperatorStateRepository = {
  read(): Promise<OperatorState | null>;
  write(state: OperatorState): Promise<OperatorState>;
};

export type OperatorRuntimeOverrides = {
  environment: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now: () => Date;
};

type SourceIdentity = {
  releaseSha: string;
  sourceTreeSha256: string;
  selectorSha256: string;
  files: string[];
};

export class SafeCommandRunner implements OperatorCommandRunner {
  constructor(private readonly cwd: string) {}

  run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.cwd,
        env: options.environment ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const rejectSafely = (message: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      };
      const onAbort = () => {
        child.kill("SIGTERM");
        rejectSafely(`command_aborted:${path.basename(command)}`);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 8 * 1024 * 1024) {
          child.kill("SIGTERM");
          rejectSafely(`command_output_too_large:${path.basename(command)}`);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 8 * 1024 * 1024) {
          child.kill("SIGTERM");
          rejectSafely(`command_error_output_too_large:${path.basename(command)}`);
        }
      });
      child.on("error", () => rejectSafely(`command_start_failed:${path.basename(command)}`));
      child.on("close", (code, signal) => {
        options.signal?.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        if (code === 0) resolve(stdout);
        else reject(new Error(`command_failed:${path.basename(command)}:${code ?? signal ?? "unknown"}`));
      });
      child.stdin.end(options.input ?? "");
    });
  }
}

export class RolloutStateStore implements OperatorStateRepository {
  constructor(private readonly file: string) {}

  async read(): Promise<OperatorState | null> {
    try {
      return parseRolloutState(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(state: OperatorState): Promise<OperatorState> {
    const validated = parseRolloutState(JSON.stringify(state));
    await mkdir(path.dirname(this.file), { recursive: true });
    let current: OperatorState | null = null;
    try {
      current = parseRolloutState(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if ((current?.revision ?? 0) !== validated.revision) {
      throw new Error("rollout_state_stale_write");
    }
    const next = parseRolloutState(JSON.stringify({
      ...validated,
      revision: validated.revision + 1,
    }));
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.file);
    const directory = await open(path.dirname(this.file), fsConstants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return next;
  }
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("operator_interrupted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("operator_interrupted"));
    }, { once: true });
  });
}

function safeReason(error: unknown): string {
  if (!(error instanceof Error)) return "operator_failed";
  return error.message.replace(/[\r\n]+/g, " ").slice(0, 300) || "operator_failed";
}

function nonEmptyCampaigns(state: OperatorState) {
  if (!state.rollout) throw new Error("rollout_manifest_missing");
  return state.rollout.campaigns.flatMap((campaign) => campaign.campaignId
    ? [{ id: campaign.campaignId, segment: campaign.segment, decisionHash: campaign.decisionHash }]
    : []);
}

function campaignTransitionBody(state: OperatorState) {
  if (!state.rollout) throw new Error("rollout_manifest_missing");
  return {
    selectorPhase: state.rollout.selectorPhase,
    campaigns: nonEmptyCampaigns(state),
  };
}

export class ExpandedRecoveryRolloutOperator {
  private state: OperatorState | null = null;
  private actionAbort = new AbortController();
  private signalCode: number | null = null;
  private cleanupArmed = false;
  private readonly cleanupCoordinator: CleanupCoordinator;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: OperatorRuntimeOverrides["sleep"];
  private readonly now: OperatorRuntimeOverrides["now"];

  constructor(
    private readonly root: string,
    private readonly config: OperatorConfig,
    private readonly store: OperatorStateRepository,
    private readonly runner: OperatorCommandRunner,
    runtime: Partial<OperatorRuntimeOverrides> = {},
    private readonly sourceFiles: string[] = [],
  ) {
    this.environment = runtime.environment ?? process.env;
    this.fetchImpl = runtime.fetch ?? fetch;
    this.sleepImpl = runtime.sleep ?? defaultSleep;
    this.now = runtime.now ?? (() => new Date());
    this.cleanupCoordinator = new CleanupCoordinator(async (reason, exitCode) => {
      if (!this.state) return 75;
      const result = await performFailClosedCleanup({
        state: this.state,
        originalExitCode: exitCode,
        reason,
        writeState: async (next) => {
          const persisted = await this.store.write(next);
          Object.assign(next, persisted);
          this.state = persisted;
        },
        pauseAndVerify: () => this.pauseAndVerify(),
        restoreHistoricalFlag: () => this.restoreHistoricalFlag(),
        sleep: (milliseconds) => this.sleepImpl(milliseconds),
      });
      this.state = result.state;
      return result.exitCode;
    });
  }

  requestSignal(signal: keyof typeof SIGNAL_CODES): void {
    if (this.signalCode !== null) return;
    this.signalCode = SIGNAL_CODES[signal];
    this.actionAbort.abort();
  }

  private throwIfSignalled(): void {
    if (this.signalCode !== null) throw new Error("operator_interrupted");
  }

  private railwayScope(state = this.requireState()): string[] {
    return [
      "--project", state.identity.railway.projectId,
      "--service", state.identity.railway.serviceId,
      "--environment", state.identity.railway.environmentId,
    ];
  }

  private requireState(): OperatorState {
    if (!this.state) throw new Error("rollout_state_missing");
    return this.state;
  }

  private requireBoundState(): OperatorState & {
    selectorDeployment: NonNullable<OperatorState["selectorDeployment"]>;
    activeDeploymentId: string;
  } {
    const state = this.requireState();
    if (!state.selectorDeployment || !state.activeDeploymentId) {
      throw new Error("deployment_identity_unbound");
    }
    return state as OperatorState & {
      selectorDeployment: NonNullable<OperatorState["selectorDeployment"]>;
      activeDeploymentId: string;
    };
  }

  private async persist(next: OperatorState): Promise<void> {
    this.state = await this.store.write(next);
  }

  private async apiJson(
    method: "GET" | "POST",
    endpoint: string,
    options: { body?: unknown; token?: string; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const url = new URL(endpoint, this.config.apiBase);
    const response = await this.fetchImpl(url, {
      method,
      signal: options.signal,
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) throw new Error(`api_request_failed:${method}:${url.pathname}:${response.status}`);
    return response.json();
  }

  private ownerToken(): string {
    return requiredEnvironment(this.environment, "OWNER_TOKEN");
  }

  private async verifyOwner(signal?: AbortSignal): Promise<void> {
    const value = await this.apiJson("GET", "/api/me", { token: this.ownerToken(), signal }) as { email?: unknown };
    if (value.email !== this.requireState().identity.api.ownerEmail) {
      throw new Error("authenticated_owner_identity_mismatch");
    }
  }

  private async assertCircuitClosed(signal?: AbortSignal): Promise<void> {
    const value = await this.apiJson("GET", "/api/recovery-reminders/metrics", {
      token: this.ownerToken(),
      signal,
    }) as { health?: { circuitOpen?: unknown } };
    if (value.health?.circuitOpen !== false) throw new Error("shared_recovery_circuit_open_or_unknown");
  }

  private async verifyApiDeployment(
    state: OperatorState,
    historicalEnabled: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    let lastError: unknown = new Error("api_attestation_unavailable");
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      try {
        const value = await this.apiJson("GET", "/health", { signal });
        assertActiveDeploymentBinding(state, parseApiAttestation(value), historicalEnabled);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 30) await this.sleep(2000, signal);
      }
    }
    throw lastError;
  }

  private async verifySendingEnabled(expected: boolean, signal?: AbortSignal): Promise<void> {
    const value = await this.apiJson("GET", "/api/historical-recovery/campaigns", {
      token: this.ownerToken(),
      signal,
    }) as { sendingEnabled?: unknown };
    if (value.sendingEnabled !== expected) throw new Error("historical_sending_flag_mismatch");
  }

  private async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    await this.sleepImpl(milliseconds, signal);
  }

  private async waitForDeployment(deploymentId: string, signal?: AbortSignal): Promise<void> {
    const state = this.requireState();
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      const output = await this.runner.run("railway", [
        "deployment", "list",
        "--service", state.identity.railway.serviceId,
        "--environment", state.identity.railway.environmentId,
        "--limit", "100", "--json",
      ], { signal });
      const deployment = parseDeploymentList(output, deploymentId);
      if (deployment.status === "SUCCESS") return;
      if (TERMINAL_DEPLOYMENT_FAILURES.has(deployment.status)) {
        throw new Error(`deployment_terminal_failure:${deployment.status}`);
      }
      if (!PENDING_DEPLOYMENT_STATES.has(deployment.status)) {
        throw new Error(`deployment_unknown_status:${deployment.status}`);
      }
      await this.sleep(10_000, signal);
    }
    throw new Error("deployment_wait_timeout");
  }

  private async deployRelease(
    historicalEnabled: boolean,
    message: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const state = this.requireState();
    const scope = this.railwayScope(state);
    const artifactPath = path.join(this.root, ARTIFACT_FILE);
    const artifact = {
      schemaVersion: 1,
      kind: "expanded-recovery-deployment-artifact",
      releaseSha: state.identity.releaseSha,
      sourceTreeSha256: state.identity.sourceTreeSha256,
      selectorSha256: state.identity.selectorSha256,
      files: this.sourceFiles,
    };
    if (this.sourceFiles.length > 0) {
      const handle = await open(artifactPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(artifact)}\n`, "utf8");
      } finally {
        await handle.close();
      }
    }
    try {
      await this.runner.run("railway", [
        "variable", "set", "--skip-deploys", ...scope,
        `DM_RECOVERY_HISTORICAL_ENABLED=${historicalEnabled}`,
      ], { signal });
      const started = await this.runner.run("railway", [
        "up", "--detach", "--json", ...scope, "--message", message,
      ], { signal });
      const deploymentId = parseDeploymentStartOutput(started);
      await this.waitForDeployment(deploymentId, signal);
      return deploymentId;
    } finally {
      if (this.sourceFiles.length > 0) await rm(artifactPath, { force: true });
    }
  }

  private auditEnvironment(): NodeJS.ProcessEnv {
    const { OWNER_TOKEN: _ownerToken, META_ACCESS_TOKEN: _metaToken, ...environment } = this.environment;
    return environment;
  }

  private async runAudit(command: string, args: string[], signal?: AbortSignal): Promise<unknown> {
    const output = await this.runner.run(path.join(this.root, "node_modules/.bin/tsx"), [
      path.join(this.root, "scripts/expanded-recovery-audit.ts"), command, ...args,
    ], { signal, environment: this.auditEnvironment() });
    return JSON.parse(output.trim());
  }

  private async assertGroup(states: string, signal?: AbortSignal): Promise<void> {
    const state = this.requireState();
    if (!state.rollout) throw new Error("rollout_manifest_missing");
    const campaigns = nonEmptyCampaigns(state);
    await this.runAudit("assert-group", [
      "--group", state.rollout.groupId,
      "--campaigns", campaigns.map(({ id }) => id).join(","),
      "--phase", states,
    ], signal);
  }

  private async auditGroup(states: string, signal?: AbortSignal): Promise<void> {
    const state = this.requireState();
    if (!state.rollout) throw new Error("rollout_manifest_missing");
    await this.runAudit("audit-group", [
      "--group", state.rollout.groupId,
      "--phase", states,
      "--selector-phase", state.rollout.selectorPhase,
      "--campaigns-json", JSON.stringify(nonEmptyCampaigns(state)),
    ], signal);
  }

  private async verifyGroupViaApi(states: string[], signal?: AbortSignal): Promise<void> {
    const state = this.requireState();
    if (!state.rollout) throw new Error("rollout_manifest_missing");
    const expected = nonEmptyCampaigns(state).map(({ id }) => id).sort();
    const value = await this.apiJson("GET", "/api/historical-recovery/campaigns", {
      token: this.ownerToken(),
      signal,
    }) as { campaigns?: Array<{ id?: unknown; state?: unknown; rolloutGroupId?: unknown }> };
    if (!Array.isArray(value.campaigns)) throw new Error("campaign_api_shape_invalid");
    const actual = value.campaigns
      .filter(({ rolloutGroupId }) => rolloutGroupId === state.rollout!.groupId)
      .map((campaign) => ({ id: campaign.id, state: campaign.state }));
    if (
      actual.length !== expected.length
      || actual.map(({ id }) => id).sort().some((id, index) => id !== expected[index])
      || actual.some(({ state: campaignState }) =>
        typeof campaignState !== "string" || !states.includes(campaignState))
    ) throw new Error("campaign_api_group_mismatch");
  }

  private async pauseAndVerify(): Promise<void> {
    const state = this.requireState();
    assertOperatorIdentity(state, this.config.identity);
    if (!state.rollout) return;
    await this.apiJson("POST", `/api/historical-recovery/rollout-groups/${state.rollout.groupId}/pause`, {
      token: this.ownerToken(),
      body: { reason: "emergency: fail-closed expanded recovery operator cleanup" },
    });
    await this.verifyGroupViaApi(["draft", "awaiting_approval", "paused", "completed", "cancelled"]);
    await this.assertGroup("draft|awaiting_approval|paused|completed|cancelled");
  }

  private async restoreHistoricalFlag(): Promise<{ activeDeploymentId: string }> {
    const state = this.requireState();
    assertOperatorIdentity(state, this.config.identity);
    const deploymentId = await this.deployRelease(
      state.historicalPrior,
      "expanded recovery fail-closed historical rollback",
    );
    const next = { ...state, activeDeploymentId: deploymentId };
    await this.verifyApiDeployment(next, state.historicalPrior);
    return { activeDeploymentId: deploymentId };
  }

  private async captureHistoricalPrior(): Promise<boolean> {
    const state = this.requireState();
    const output = await this.runner.run("railway", [
      "variable", "list", ...this.railwayScope(state), "--json",
    ], { signal: this.actionAbort.signal });
    return parseHistoricalFlag(output);
  }

  private async deployInert(): Promise<void> {
    if (this.state && this.state.phase === "inert") {
      assertOperatorIdentity(this.state, this.config.identity);
      await this.verifyApiDeployment(this.state, false, this.actionAbort.signal);
      return;
    }
    if (this.state && this.state.phase !== "deploying_inert") {
      throw new Error(`deploy_inert_not_allowed_from_${this.state.phase}`);
    }
    if (!this.state) {
      const provisional: OperatorState = {
        version: 3,
        revision: 0,
        phase: "deploying_inert",
        identity: this.config.identity,
        historicalPrior: false,
        selectorDeployment: null,
        activeDeploymentId: null,
        rollout: null,
        operation: null,
        cleanup: null,
      };
      this.state = provisional;
      const historicalPrior = await this.captureHistoricalPrior();
      await this.persist({ ...provisional, historicalPrior });
    } else {
      assertOperatorIdentity(this.state, this.config.identity);
    }
    const deploymentId = await this.deployRelease(false, "expanded recovery inert", this.actionAbort.signal);
    const next: OperatorState = {
      ...this.requireState(),
      phase: "inert",
      selectorDeployment: { id: deploymentId, instanceId: null },
      activeDeploymentId: deploymentId,
    };
    await this.persist(next);
    await this.verifyApiDeployment(next, false, this.actionAbort.signal);
  }

  private async remoteAttestation(instanceId: string): Promise<void> {
    const state = this.requireBoundState();
    const output = await this.runner.run("railway", [
      "ssh", ...this.railwayScope(state), "--deployment-instance", instanceId,
      "--", "node", "--input-type=module", "--eval", REMOTE_ATTESTATION_PROGRAM,
    ], { signal: this.actionAbort.signal });
    assertRemoteSelectorBinding(state, instanceId, parseRemoteAttestation(output));
  }

  private selectionToState(output: SelectionOutput): OperatorState["rollout"] {
    return {
      groupId: output.rolloutGroupId,
      selectorPhase: output.phase,
      campaigns: output.campaigns.map(({ segment, campaignId, candidateCount, decisionHash }) => ({
        segment, campaignId, candidateCount, decisionHash,
      })),
    };
  }

  private async selectDrafts(): Promise<void> {
    const state = this.requireBoundState();
    assertCommandAllowed(state, "select");
    assertOperatorIdentity(state, this.config.identity);
    const selectorPhase = requiredEnvironment(this.environment, "SELECTOR_PHASE");
    if (selectorPhase !== "confirmed_failure" && selectorPhase !== "unknown_read_pilot") {
      throw new Error("SELECTOR_PHASE_invalid");
    }
    await this.verifyApiDeployment(state, false, this.actionAbort.signal);
    await this.verifyOwner(this.actionAbort.signal);
    await this.assertCircuitClosed(this.actionAbort.signal);
    await this.runAudit("audit-live", [], this.actionAbort.signal);
    const instanceId = requiredEnvironment(this.environment, "DEPLOYMENT_INSTANCE_ID");
    await this.remoteAttestation(instanceId);
    await this.persist({
      ...state,
      phase: "selecting",
      selectorDeployment: { ...state.selectorDeployment, instanceId },
      operation: { kind: "select", selectorPhase, startedAt: this.now().toISOString() },
    });
    const output = await this.runner.run("railway", [
      "ssh", ...this.railwayScope(), "--deployment-instance", instanceId,
      "--", "./node_modules/.bin/tsx", "scripts/select-expanded-historical-recovery.ts",
      "--phase", selectorPhase, "--json",
    ], { signal: this.actionAbort.signal });
    const selection = parseSelectionOutput(output);
    if (selection.phase !== selectorPhase) throw new Error("selector_phase_mismatch");
    const selected: OperatorState = {
      ...this.requireState(),
      phase: "selected",
      rollout: this.selectionToState(selection),
      operation: null,
    };
    this.state = selected;
    await this.auditGroup("draft", this.actionAbort.signal);
    await this.persist(selected);
  }

  private async adoptSelection(): Promise<void> {
    const state = this.requireBoundState();
    assertCommandAllowed(state, "adopt");
    assertOperatorIdentity(state, this.config.identity);
    if (!state.selectorDeployment.instanceId) throw new Error("selector_instance_not_bound");
    if (state.operation?.kind !== "select") throw new Error("selector_intent_missing");
    await this.remoteAttestation(state.selectorDeployment.instanceId);
    const selection = parseSelectionOutput(requiredEnvironment(this.environment, "ADOPT_SELECTION_JSON"));
    if (selection.phase !== state.operation.selectorPhase) {
      throw new Error("selector_phase_mismatch");
    }
    const adopted: OperatorState = {
      ...state,
      phase: "selected",
      rollout: this.selectionToState(selection),
      operation: null,
    };
    this.state = adopted;
    await this.auditGroup("draft", this.actionAbort.signal);
    await this.persist(adopted);
  }

  private async markOperation(
    phase: "approving" | "enabling" | "resuming" | "verifying",
    kind: "approve" | "enable" | "resume" | "verify",
  ): Promise<void> {
    await this.persist({
      ...this.requireState(),
      phase,
      operation: { kind, startedAt: this.now().toISOString() },
    });
  }

  private async approveStart(): Promise<void> {
    const initial = this.requireBoundState();
    assertCommandAllowed(initial, "approve-start");
    this.cleanupArmed = true;
    assertOperatorIdentity(initial, this.config.identity);
    this.throwIfSignalled();
    const expectedHistorical = initial.phase === "deployed"
      ? true
      : initial.phase === "recovery_ready"
        ? initial.historicalPrior
        : false;
    await this.verifyApiDeployment(initial, expectedHistorical, this.actionAbort.signal);
    await this.verifyOwner(this.actionAbort.signal);
    await this.assertCircuitClosed(this.actionAbort.signal);
    await this.runAudit("audit-live", [], this.actionAbort.signal);

    if (initial.phase === "selected" || initial.phase === "recovery_ready") {
      await this.auditGroup("draft|awaiting_approval|paused", this.actionAbort.signal);
      await this.markOperation("approving", "approve");
      const state = this.requireState();
      const response = await this.apiJson("POST", `/api/historical-recovery/rollout-groups/${state.rollout!.groupId}/approve`, {
        token: this.ownerToken(),
        body: campaignTransitionBody(state),
        signal: this.actionAbort.signal,
      }) as { ok?: unknown; state?: unknown; campaignIds?: unknown };
      if (response.ok !== true || response.state !== "paused") throw new Error("atomic_group_approval_failed");
      await this.assertGroup("paused", this.actionAbort.signal);
      await this.persist({ ...this.requireState(), phase: "approved", operation: null });
    }

    if (this.requireState().phase === "approved") {
      await this.auditGroup("paused", this.actionAbort.signal);
      await this.markOperation("enabling", "enable");
      const deploymentId = await this.deployRelease(true, "expanded recovery historical enable", this.actionAbort.signal);
      const deployed: OperatorState = {
        ...this.requireState(),
        phase: "deployed",
        activeDeploymentId: deploymentId,
        operation: null,
      };
      await this.persist(deployed);
      await this.verifyApiDeployment(deployed, true, this.actionAbort.signal);
      await this.verifySendingEnabled(true, this.actionAbort.signal);
    }

    if (this.requireState().phase === "deployed") {
      await this.verifyApiDeployment(this.requireState(), true, this.actionAbort.signal);
      await this.assertCircuitClosed(this.actionAbort.signal);
      await this.auditGroup("paused", this.actionAbort.signal);
      await this.markOperation("resuming", "resume");
      const state = this.requireState();
      const response = await this.apiJson("POST", `/api/historical-recovery/rollout-groups/${state.rollout!.groupId}/resume`, {
        token: this.ownerToken(),
        body: campaignTransitionBody(state),
        signal: this.actionAbort.signal,
      }) as { ok?: unknown; state?: unknown };
      if (response.ok !== true || response.state !== "running") throw new Error("atomic_group_resume_failed");
      await this.auditGroup("running|completed", this.actionAbort.signal);
      await this.persist({ ...this.requireState(), phase: "running", operation: null });
    }
    this.throwIfSignalled();
    this.cleanupArmed = false;
  }

  private async verifyFirstSends(): Promise<void> {
    const state = this.requireBoundState();
    assertCommandAllowed(state, "verify");
    this.cleanupArmed = true;
    assertOperatorIdentity(state, this.config.identity);
    await this.verifyOwner(this.actionAbort.signal);
    await this.verifyApiDeployment(state, true, this.actionAbort.signal);
    await this.assertCircuitClosed(this.actionAbort.signal);
    await this.auditGroup("running|completed", this.actionAbort.signal);
    await this.markOperation("verifying", "verify");
    for (const campaign of nonEmptyCampaigns(this.requireState())) {
      const output = await this.runner.run(path.join(this.root, "node_modules/.bin/tsx"), [
        path.join(this.root, "scripts/expanded-recovery-audit.ts"),
        "first-send", "--campaign", campaign.id, "--timeout-seconds", "600",
      ], { signal: this.actionAbort.signal, environment: this.auditEnvironment() });
      const first = parseFirstSendOutput(output);
      const response = await this.fetchImpl(
        `https://graph.instagram.com/v21.0/${encodeURIComponent(first.replyId)}?fields=id,text,parent_id`,
        {
          signal: this.actionAbort.signal,
          headers: { Authorization: `Bearer ${requiredEnvironment(this.environment, "META_ACCESS_TOKEN")}` },
        },
      );
      if (!response.ok) throw new Error(`meta_readback_failed:${response.status}`);
      const body = await response.json() as { id?: unknown; text?: unknown; parent_id?: unknown };
      if (body.id !== first.replyId || body.text !== first.text || body.parent_id !== first.parentCommentId) {
        throw new Error("meta_readback_mismatch");
      }
    }
    await this.auditGroup("running|completed", this.actionAbort.signal);
    await this.assertCircuitClosed(this.actionAbort.signal);
    await this.persist({ ...this.requireState(), phase: "verified", operation: null });
    this.throwIfSignalled();
    this.cleanupArmed = false;
  }

  private async pause(): Promise<number> {
    const state = this.requireBoundState();
    assertCommandAllowed(state, "pause");
    this.cleanupArmed = true;
    assertOperatorIdentity(state, this.config.identity);
    return this.cleanupCoordinator.request("owner requested fail-closed pause", 0);
  }

  private async retryCleanup(): Promise<number> {
    const state = this.requireState();
    assertCommandAllowed(state, "retry-cleanup");
    this.cleanupArmed = true;
    return this.cleanupCoordinator.request(state.cleanup?.reason ?? "retry cleanup", 0);
  }

  async execute(command: OperatorCommand): Promise<number> {
    try {
      this.state = await this.store.read();
      if (command === "deploy-inert") await this.deployInert();
      else {
        const state = this.requireState();
        if (state.phase === "cleanup_required" && command !== "retry-cleanup") {
          throw new Error("cleanup_required_lock");
        }
        switch (command) {
          case "select": await this.selectDrafts(); break;
          case "adopt": await this.adoptSelection(); break;
          case "approve-start": await this.approveStart(); break;
          case "verify": await this.verifyFirstSends(); break;
          case "pause": return this.pause();
          case "retry-cleanup": return this.retryCleanup();
          default: throw new Error("unsupported_operator_command");
        }
      }
      return this.signalCode ?? 0;
    } catch (error) {
      const reason = safeReason(error);
      process.stderr.write(`ERROR: ${reason}\n`);
      if (this.cleanupArmed && this.state?.rollout) {
        return this.cleanupCoordinator.request(
          this.signalCode === null ? reason : "operator interrupted",
          this.signalCode ?? 1,
        );
      }
      return this.signalCode ?? 1;
    }
  }
}

async function sourceIdentity(root: string, runner: OperatorCommandRunner): Promise<SourceIdentity> {
  const status = await runner.run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.trim() !== "") throw new Error("deployment_source_tree_not_clean");
  const releaseSha = (await runner.run("git", ["rev-parse", "HEAD"])).trim();
  const tracked = (await runner.run("git", ["ls-files", "-z"]))
    .split("\0").filter(Boolean).sort();
  const tree = createHash("sha256");
  for (const relative of tracked) {
    tree.update(relative).update("\0").update(await readFile(path.join(root, relative))).update("\0");
  }
  const selector = await readFile(path.join(root, "scripts/select-expanded-historical-recovery.ts"));
  return {
    releaseSha,
    sourceTreeSha256: tree.digest("hex"),
    selectorSha256: createHash("sha256").update(selector).digest("hex"),
    files: tracked,
  };
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const stateFile = process.env.EXPANDED_RECOVERY_STATE_FILE
    ?? path.join(root, ".expanded-recovery-rollout.state.json");
  const lockDirectory = `${stateFile}.lock`;
  const startupMarker = `${stateFile}.cleanup-required`;
  let pendingSignal: keyof typeof SIGNAL_CODES | null = null;
  let operator: ExpandedRecoveryRolloutOperator | null = null;
  for (const signal of Object.keys(SIGNAL_CODES) as Array<keyof typeof SIGNAL_CODES>) {
    process.on(signal, () => {
      pendingSignal ??= signal;
      operator?.requestSignal(signal);
    });
  }
  const command = process.argv[2] as OperatorCommand | undefined;
  const allowed: OperatorCommand[] = [
    "deploy-inert", "select", "adopt", "approve-start", "verify", "pause", "retry-cleanup",
  ];
  if (!command || !allowed.includes(command)) throw new Error(`commands: ${allowed.join(" ")}`);
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(path.join(lockDirectory, "pid"), `${process.pid}\n`, { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      let ownerAlive = true;
      try {
        const owner = Number((await readFile(path.join(lockDirectory, "pid"), "utf8")).trim());
        if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("invalid_lock_owner");
        process.kill(owner, 0);
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code === "ESRCH") ownerAlive = false;
      }
      if (!ownerAlive) {
        await rm(lockDirectory, { recursive: true, force: true });
        await mkdir(lockDirectory, { mode: 0o700 });
        await writeFile(path.join(lockDirectory, "pid"), `${process.pid}\n`, { mode: 0o600 });
      } else {
        process.stderr.write("ERROR: another rollout operator owns the exclusive lock\n");
        process.exitCode = 75;
        return;
      }
    }
    throw error;
  }
  try {
    try {
      await access(startupMarker);
      if (command !== "retry-cleanup") throw new Error("startup_cleanup_required_lock");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const runner = new SafeCommandRunner(root);
    const store = new RolloutStateStore(stateFile);
    const savedState = await store.read();
    let source: SourceIdentity | null = null;
    try {
      source = await sourceIdentity(root, runner);
      const config = parseOperatorConfig(process.env, source);
      operator = new ExpandedRecoveryRolloutOperator(root, config, store, runner, {}, source.files);
    } catch (startupError) {
      if (!savedState?.rollout) throw startupError;
      operator = new ExpandedRecoveryRolloutOperator(
        root,
        { apiBase: savedState.identity.api.origin, pgUrl: "", identity: savedState.identity },
        store,
        runner,
      );
      if (pendingSignal) operator.requestSignal(pendingSignal);
      process.exitCode = await operator.execute("retry-cleanup");
      if (process.exitCode !== 0) {
        await writeFile(startupMarker, `${safeReason(startupError)}\n`, { mode: 0o600 });
      }
      return;
    }
    if (pendingSignal) operator.requestSignal(pendingSignal);
    process.exitCode = await operator.execute(command);
    if (process.exitCode === 0) await rm(startupMarker, { force: true });
  } catch (error) {
    let priorStateMayExist = false;
    try { await access(stateFile); priorStateMayExist = true; } catch { /* absent */ }
    if (priorStateMayExist) {
      await writeFile(startupMarker, `${safeReason(error)}\n`, { mode: 0o600 });
      process.exitCode = 75;
    } else {
      process.exitCode = pendingSignal ? SIGNAL_CODES[pendingSignal] : 1;
    }
    process.stderr.write(`ERROR: ${safeReason(error)}\n`);
  } finally {
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${safeReason(error)}\n`);
    process.exitCode = 1;
  });
}
