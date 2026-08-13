import { createHash } from "node:crypto";
import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;

export const EXPANDED_SEGMENT_ORDER = [
  "other",
  "unknown_cue",
  "unknown_generic",
  "unknown_no_name",
] as const;

const uuid = z.string().regex(UUID);
const sha256 = z.string().regex(SHA256);
const gitSha = z.string().regex(GIT_SHA);
const segment = z.enum(EXPANDED_SEGMENT_ORDER);

const identitySchema = z.object({
  railway: z.object({
    projectId: uuid,
    serviceId: uuid,
    environmentId: uuid,
    environmentName: z.string().trim().min(1),
    serviceName: z.string().trim().min(1),
  }).strict(),
  releaseSha: gitSha,
  selectorSha256: sha256,
  api: z.object({
    origin: z.string().url(),
    host: z.string().trim().min(1),
    ownerEmail: z.string().email(),
    fingerprint: sha256,
  }).strict(),
  database: z.object({
    protocol: z.enum(["postgres:", "postgresql:"]),
    host: z.string().trim().min(1),
    port: z.string().regex(/^\d+$/),
    name: z.string().trim().min(1),
    fingerprint: sha256,
  }).strict(),
}).strict();

const rolloutCampaignSchema = z.object({
  segment,
  campaignId: uuid.nullable(),
  candidateCount: z.number().int().min(0),
  decisionHash: sha256,
}).strict();

const phaseSchema = z.enum([
  "deploying_inert",
  "inert",
  "selecting",
  "selected",
  "approving",
  "approved",
  "enabling",
  "deployed",
  "resuming",
  "running",
  "completed",
  "verifying",
  "verified",
  "recovery_ready",
  "cleanup_required",
]);

const operationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("select"),
    selectorPhase: z.enum(["confirmed_failure", "unknown_read_pilot"]),
    startedAt: z.string().datetime(),
  }).strict(),
  z.object({
    kind: z.enum(["approve", "enable", "resume", "verify"]),
    startedAt: z.string().datetime(),
  }).strict(),
]);

const cleanupSchema = z.object({
  required: z.literal(true),
  reason: z.string().min(1).max(500),
  requestedAt: z.string().datetime(),
  pauseVerified: z.boolean(),
  historicalVerified: z.boolean(),
}).strict();

const rolloutStateSchema = z.object({
  version: z.literal(2),
  phase: phaseSchema,
  identity: identitySchema,
  historicalPrior: z.boolean(),
  selectorDeployment: z.object({
    id: uuid,
    instanceId: uuid.nullable(),
  }).strict().nullable(),
  activeDeploymentId: uuid.nullable(),
  rollout: z.object({
    groupId: uuid,
    selectorPhase: z.enum(["confirmed_failure", "unknown_read_pilot"]),
    campaigns: z.array(rolloutCampaignSchema).length(4),
  }).strict().nullable(),
  operation: operationSchema.nullable(),
  cleanup: cleanupSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.phase === "deploying_inert") {
    if (value.selectorDeployment !== null || value.activeDeploymentId !== null || value.rollout !== null) {
      context.addIssue({ code: "custom", message: "deploying inert state must be unbound" });
    }
  } else if (value.selectorDeployment === null || value.activeDeploymentId === null) {
    context.addIssue({ code: "custom", message: "deployed state identity incomplete" });
  }
  const manifestPhases = new Set<typeof value.phase>([
    "selected", "approving", "approved", "enabling", "deployed", "resuming",
    "running", "completed", "verifying", "verified", "recovery_ready", "cleanup_required",
  ]);
  if (manifestPhases.has(value.phase) && value.rollout === null) {
    context.addIssue({ code: "custom", message: "rollout manifest missing for phase" });
  }
  if (value.phase === "selecting") {
    if (value.rollout !== null || value.operation?.kind !== "select") {
      context.addIssue({ code: "custom", message: "selecting state intent incomplete" });
    }
  }
  const expectedOperation = {
    approving: "approve",
    enabling: "enable",
    resuming: "resume",
    verifying: "verify",
  } as const;
  if (value.phase in expectedOperation) {
    const expected = expectedOperation[value.phase as keyof typeof expectedOperation];
    if (value.operation?.kind !== expected) {
      context.addIssue({ code: "custom", message: "intermediate operation mismatch" });
    }
  } else if (
    value.phase !== "selecting"
    && value.phase !== "cleanup_required"
    && value.operation !== null
  ) {
    context.addIssue({ code: "custom", message: "terminal phase operation must be empty" });
  }
  if (value.rollout) {
    value.rollout.campaigns.forEach((campaign, index) => {
      if (campaign.segment !== EXPANDED_SEGMENT_ORDER[index]) {
        context.addIssue({ code: "custom", message: "rollout campaign order invalid" });
      }
      if ((campaign.candidateCount === 0) !== (campaign.campaignId === null)) {
        context.addIssue({ code: "custom", message: "campaign id/count shape invalid" });
      }
    });
  }
  if (value.phase === "cleanup_required" && value.cleanup?.required !== true) {
    context.addIssue({ code: "custom", message: "cleanup_required phase needs cleanup state" });
  }
});

export type OperatorIdentity = z.infer<typeof identitySchema>;
export type OperatorState = z.infer<typeof rolloutStateSchema>;
export type OperatorCommand =
  | "deploy-inert"
  | "select"
  | "adopt"
  | "approve-start"
  | "verify"
  | "pause"
  | "retry-cleanup";

export type OperatorConfig = {
  apiBase: string;
  pgUrl: string;
  identity: OperatorIdentity;
};

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactApiOrigin(raw: string, expectedHost: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "https:"
    || url.hostname !== expectedHost
    || url.username !== ""
    || url.password !== ""
    || (url.pathname !== "" && url.pathname !== "/")
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("api_identity_invalid");
  }
  return url;
}

function exactDatabaseIdentity(raw: string, expectedHost: string, expectedName: string) {
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || url.hostname !== expectedHost
    || name !== expectedName
    || name.includes("/")
  ) {
    throw new Error("database_identity_invalid");
  }
  return {
    protocol: url.protocol as "postgres:" | "postgresql:",
    host: url.hostname,
    port: url.port || "5432",
    name,
  };
}

export function parseOperatorConfig(
  environment: NodeJS.ProcessEnv,
  source: { releaseSha: string; selectorSha256: string },
): OperatorConfig {
  const apiBase = required(environment, "API_BASE");
  const expectedApiHost = required(environment, "EXPECTED_API_HOST");
  const pgUrl = required(environment, "PGURL");
  const database = exactDatabaseIdentity(
    pgUrl,
    required(environment, "EXPECTED_DATABASE_HOST"),
    required(environment, "EXPECTED_DATABASE_NAME"),
  );
  const api = exactApiOrigin(apiBase, expectedApiHost);
  const ownerEmail = required(environment, "OWNER_EMAIL");
  const identity = identitySchema.parse({
    railway: {
      projectId: required(environment, "RAILWAY_PROJECT_ID"),
      serviceId: required(environment, "RAILWAY_SERVICE_ID"),
      environmentId: required(environment, "RAILWAY_ENVIRONMENT_ID"),
      environmentName: required(environment, "RAILWAY_ENVIRONMENT"),
      serviceName: required(environment, "API_SERVICE"),
    },
    releaseSha: source.releaseSha,
    selectorSha256: source.selectorSha256,
    api: {
      origin: api.origin,
      host: api.hostname,
      ownerEmail,
      fingerprint: digest({
        origin: api.origin,
        host: api.hostname,
        ownerEmail,
        projectId: environment.RAILWAY_PROJECT_ID,
        serviceId: environment.RAILWAY_SERVICE_ID,
        environmentId: environment.RAILWAY_ENVIRONMENT_ID,
      }),
    },
    database: {
      ...database,
      fingerprint: digest(database),
    },
  });
  return { apiBase: api.origin, pgUrl, identity };
}

export function parseRolloutState(serialized: string): OperatorState {
  return rolloutStateSchema.parse(JSON.parse(serialized));
}

export function assertOperatorIdentity(
  state: OperatorState,
  current: OperatorIdentity,
): void {
  if (JSON.stringify(state.identity) !== JSON.stringify(current)) {
    throw new Error("operator_identity_drift");
  }
}

const selectionOutputSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("expanded-recovery-selection"),
  rolloutGroupId: uuid,
  phase: z.enum(["confirmed_failure", "unknown_read_pilot"]),
  groupHourlyCap: z.literal(10),
  dailyCap: z.literal(1000),
  holdoutPercent: z.literal(0),
  eligibilityPolicyVersion: z.literal("eligibility-v4-expanded-audience"),
  selectionVersion: z.literal("v1-canonical-intents-expanded-audience"),
  copyVersion: z.literal("recovery-v2"),
  onePersonAcrossRollout: z.literal(true),
  campaigns: z.array(z.object({
    segment,
    campaignId: uuid.nullable(),
    candidateCount: z.number().int().min(0),
    excludedPeople: z.number().int().min(0),
    decisionHash: sha256,
  }).strict()).length(4),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  let nonEmpty = 0;
  value.campaigns.forEach((campaign, index) => {
    if (campaign.segment !== EXPANDED_SEGMENT_ORDER[index]) {
      context.addIssue({ code: "custom", message: "selector campaign order invalid" });
    }
    if ((campaign.candidateCount === 0) !== (campaign.campaignId === null)) {
      context.addIssue({ code: "custom", message: "selector campaign id/count invalid" });
    }
    if (campaign.campaignId) {
      nonEmpty += 1;
      if (ids.has(campaign.campaignId)) {
        context.addIssue({ code: "custom", message: "selector campaign id duplicate" });
      }
      ids.add(campaign.campaignId);
    }
  });
  if (nonEmpty === 0) {
    context.addIssue({ code: "custom", message: "selector produced no non-empty campaign" });
  }
});

export type SelectionOutput = z.infer<typeof selectionOutputSchema>;

export function parseSelectionOutput(output: string): SelectionOutput {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}") || trimmed.includes("\n")) {
    throw new Error("selector_output_not_single_json_record");
  }
  return selectionOutputSchema.parse(JSON.parse(trimmed));
}

const remoteAttestationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("expanded-recovery-remote-attestation"),
  railway: z.object({
    projectId: uuid,
    serviceId: uuid,
    environmentId: uuid,
    deploymentId: uuid,
  }).strict(),
  releaseSha: gitSha,
  selectorSha256: sha256,
  database: z.object({
    protocol: z.enum(["postgres:", "postgresql:"]),
    host: z.string().trim().min(1),
    port: z.string().regex(/^\d+$/),
    name: z.string().trim().min(1),
  }).strict(),
  historicalEnabled: z.boolean(),
}).strict();

export type RemoteAttestation = z.infer<typeof remoteAttestationSchema>;

export function parseRemoteAttestation(output: string): RemoteAttestation {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}") || trimmed.includes("\n")) {
    throw new Error("remote_attestation_not_single_json_record");
  }
  return remoteAttestationSchema.parse(JSON.parse(trimmed));
}

export function assertRemoteSelectorBinding(
  state: OperatorState,
  requestedInstanceId: string,
  attestation: RemoteAttestation,
): void {
  if (
    !UUID.test(requestedInstanceId)
    || state.selectorDeployment === null
    || (state.selectorDeployment.instanceId !== null
      && state.selectorDeployment.instanceId !== requestedInstanceId)
    || attestation.railway.projectId !== state.identity.railway.projectId
    || attestation.railway.serviceId !== state.identity.railway.serviceId
    || attestation.railway.environmentId !== state.identity.railway.environmentId
    || attestation.railway.deploymentId !== state.selectorDeployment.id
    || attestation.releaseSha !== state.identity.releaseSha
    || attestation.selectorSha256 !== state.identity.selectorSha256
    || attestation.database.protocol !== state.identity.database.protocol
    || attestation.database.host !== state.identity.database.host
    || attestation.database.port !== state.identity.database.port
    || attestation.database.name !== state.identity.database.name
    || attestation.historicalEnabled !== false
  ) {
    throw new Error("remote_selector_identity_mismatch");
  }
}

const apiAttestationSchema = z.object({
  ok: z.literal(true),
  env: z.string().min(1),
  deployment: z.object({
    projectId: uuid,
    serviceId: uuid,
    environmentId: uuid,
    deploymentId: uuid,
    releaseSha: gitSha,
    historicalEnabled: z.boolean(),
  }).strict(),
}).strict();

export type ApiAttestation = z.infer<typeof apiAttestationSchema>;

export function parseApiAttestation(value: unknown): ApiAttestation {
  return apiAttestationSchema.parse(value);
}

export function assertActiveDeploymentBinding(
  state: OperatorState,
  attestation: ApiAttestation,
  expectedHistoricalEnabled: boolean,
): void {
  const deployment = attestation.deployment;
  if (
    deployment.projectId !== state.identity.railway.projectId
    || deployment.serviceId !== state.identity.railway.serviceId
    || deployment.environmentId !== state.identity.railway.environmentId
    || deployment.deploymentId !== state.activeDeploymentId
    || deployment.releaseSha !== state.identity.releaseSha
    || deployment.historicalEnabled !== expectedHistoricalEnabled
  ) {
    throw new Error("active_api_identity_mismatch");
  }
}

function parseSingleJsonRecord(output: string, label: string): unknown {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}") || trimmed.includes("\n")) {
    throw new Error(`${label}_not_single_json_record`);
  }
  return JSON.parse(trimmed);
}

export function parseDeploymentStartOutput(output: string): string {
  const value = parseSingleJsonRecord(output, "deployment_start") as Record<string, unknown>;
  const id = value.id
    ?? value.deploymentId
    ?? (value.deployment && typeof value.deployment === "object"
      ? (value.deployment as Record<string, unknown>).id
      : undefined);
  return uuid.parse(id);
}

const deploymentRecordSchema = z.object({
  id: uuid,
  status: z.string().trim().min(1),
}).passthrough();

export function parseDeploymentList(
  output: string,
  deploymentId: string,
): { id: string; status: string } {
  const parsed = JSON.parse(output) as unknown;
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { deployments?: unknown }).deployments)
      ? (parsed as { deployments: unknown[] }).deployments
      : null;
  if (!raw) throw new Error("deployment_list_invalid");
  const matches = raw.map((row) => deploymentRecordSchema.parse(row))
    .filter(({ id }) => id === deploymentId);
  if (matches.length !== 1) throw new Error("exact_deployment_record_missing_or_duplicate");
  return { id: matches[0]!.id, status: matches[0]!.status };
}

export function parseHistoricalFlag(output: string): boolean {
  const value = parseSingleJsonRecord(output, "historical_flag") as Record<string, unknown>;
  const raw = value.value ?? value.DM_RECOVERY_HISTORICAL_ENABLED;
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  throw new Error("historical_flag_not_boolean");
}

const firstSendSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("expanded-recovery-first-send"),
  replyId: z.string().trim().min(1),
  parentCommentId: z.string().trim().min(1),
  text: z.string().min(1),
}).strict();

export type FirstSendOutput = z.infer<typeof firstSendSchema>;

export function parseFirstSendOutput(output: string): FirstSendOutput {
  return firstSendSchema.parse(parseSingleJsonRecord(output, "first_send"));
}

async function retryTotal(
  operation: () => Promise<void>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await operation();
      return true;
    } catch {
      if (attempt < 3) {
        try {
          await sleep(attempt * 1000);
        } catch {
          // Cleanup remains total even when the delay implementation fails.
        }
      }
    }
  }
  return false;
}

async function retryTotalValue<T>(
  operation: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return { ok: true, value: await operation() };
    } catch {
      if (attempt < 3) {
        try {
          await sleep(attempt * 1000);
        } catch {
          // Cleanup remains total even when the delay implementation fails.
        }
      }
    }
  }
  return { ok: false };
}

async function durableWrite(
  state: OperatorState,
  writeState: (state: OperatorState) => Promise<void>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  return retryTotal(() => writeState(state), sleep);
}

export async function performFailClosedCleanup(input: {
  state: OperatorState;
  originalExitCode: number;
  reason: string;
  writeState: (state: OperatorState) => Promise<void>;
  pauseAndVerify: () => Promise<void>;
  restoreHistoricalFlag: () => Promise<void | { activeDeploymentId: string }>;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<{ state: OperatorState; exitCode: number }> {
  let locked: OperatorState = {
    ...input.state,
    phase: "cleanup_required",
    cleanup: {
      required: true,
      reason: input.reason.slice(0, 500) || "operator cleanup",
      requestedAt: input.state.cleanup?.requestedAt ?? new Date().toISOString(),
      pauseVerified: input.state.cleanup?.pauseVerified ?? false,
      historicalVerified: input.state.cleanup?.historicalVerified ?? false,
    },
  };
  const lockWritten = await durableWrite(locked, input.writeState, input.sleep);

  // A prior proof can become stale outside this process. Every explicit cleanup
  // attempt therefore proves both conditions again before releasing the lock.
  const pauseVerified = await retryTotal(input.pauseAndVerify, input.sleep);
  const restored = await retryTotalValue(input.restoreHistoricalFlag, input.sleep);
  const historicalVerified = restored.ok;
  locked = {
    ...locked,
    ...(restored.ok && restored.value?.activeDeploymentId
      ? { activeDeploymentId: restored.value.activeDeploymentId }
      : {}),
    cleanup: { ...locked.cleanup!, pauseVerified, historicalVerified },
  };

  if (!lockWritten || !pauseVerified || !historicalVerified) {
    await durableWrite(locked, input.writeState, input.sleep);
    return { state: locked, exitCode: 75 };
  }

  const recovered: OperatorState = {
    ...locked,
    phase: locked.rollout ? "recovery_ready" : "inert",
    operation: null,
    cleanup: null,
  };
  if (!(await durableWrite(recovered, input.writeState, input.sleep))) {
    await durableWrite(locked, input.writeState, input.sleep);
    return { state: locked, exitCode: 75 };
  }
  return { state: recovered, exitCode: input.originalExitCode };
}

export class CleanupCoordinator {
  private active: Promise<number> | null = null;

  constructor(private readonly cleanup: (reason: string, exitCode: number) => Promise<number>) {}

  request(reason: string, exitCode: number): Promise<number> {
    this.active ??= this.cleanup(reason, exitCode).catch(() => 75);
    return this.active;
  }
}

const allowedByPhase: Record<OperatorState["phase"], readonly OperatorCommand[]> = {
  deploying_inert: ["deploy-inert"],
  inert: ["deploy-inert", "select"],
  selecting: ["adopt"],
  selected: ["approve-start", "pause"],
  approving: ["retry-cleanup"],
  approved: ["approve-start", "pause"],
  enabling: ["retry-cleanup"],
  deployed: ["approve-start", "pause"],
  resuming: ["retry-cleanup"],
  running: ["verify", "pause"],
  completed: ["verify", "pause"],
  verifying: ["retry-cleanup"],
  verified: ["verify", "pause"],
  recovery_ready: ["approve-start", "pause"],
  cleanup_required: ["retry-cleanup"],
};

export function assertCommandAllowed(state: OperatorState, command: OperatorCommand): void {
  if (state.phase === "cleanup_required" && command !== "retry-cleanup") {
    throw new Error("cleanup_required_lock");
  }
  if (!allowedByPhase[state.phase].includes(command)) {
    throw new Error(`command_not_allowed_from_${state.phase}`);
  }
}
