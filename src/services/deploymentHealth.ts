import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const DEPLOYMENT_ARTIFACT_FILE = ".expanded-recovery-artifact.json";

const deploymentArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("expanded-recovery-deployment-artifact"),
  releaseSha: z.string().regex(GIT_SHA),
  sourceTreeSha256: z.string().regex(SHA256),
  selectorSha256: z.string().regex(SHA256),
  files: z.array(z.string().min(1)).min(1),
}).strict();

export type DeploymentArtifactAttestation = z.infer<typeof deploymentArtifactSchema>;

export function parseDeploymentArtifact(value: unknown): DeploymentArtifactAttestation {
  return deploymentArtifactSchema.parse(value);
}

/** Read only the immutable manifest packaged beside the deployed source tree. */
export function readDeploymentArtifact(
  root = process.cwd(),
): DeploymentArtifactAttestation | null {
  try {
    const artifact = parseDeploymentArtifact(JSON.parse(
      readFileSync(path.join(root, DEPLOYMENT_ARTIFACT_FILE), "utf8"),
    ));
    const sourceTree = createHash("sha256");
    for (const relative of artifact.files) {
      sourceTree
        .update(relative)
        .update("\0")
        .update(readFileSync(path.join(root, relative)))
        .update("\0");
    }
    return sourceTree.digest("hex") === artifact.sourceTreeSha256 ? artifact : null;
  } catch {
    return null;
  }
}

/** Non-secret runtime attestation used to prove which Railway artifact serves the API. */
export function buildDeploymentHealth(
  environment: NodeJS.ProcessEnv,
  nodeEnv: string,
  artifact: DeploymentArtifactAttestation | null = readDeploymentArtifact(),
) {
  const projectId = environment.RAILWAY_PROJECT_ID;
  const serviceId = environment.RAILWAY_SERVICE_ID;
  const environmentId = environment.RAILWAY_ENVIRONMENT_ID;
  const deploymentId = environment.RAILWAY_DEPLOYMENT_ID;
  const historicalRaw = environment.DM_RECOVERY_HISTORICAL_ENABLED;
  if (
    !projectId || !UUID.test(projectId)
    || !serviceId || !UUID.test(serviceId)
    || !environmentId || !UUID.test(environmentId)
    || !deploymentId || !UUID.test(deploymentId)
    || artifact === null
    || !["true", "false"].includes(historicalRaw ?? "")
  ) {
    return { ok: true as const, env: nodeEnv, deployment: null };
  }
  return {
    ok: true as const,
    env: nodeEnv,
    deployment: {
      projectId,
      serviceId,
      environmentId,
      deploymentId,
      releaseSha: artifact.releaseSha,
      sourceTreeSha256: artifact.sourceTreeSha256,
      selectorSha256: artifact.selectorSha256,
      historicalEnabled: historicalRaw === "true",
    },
  };
}
