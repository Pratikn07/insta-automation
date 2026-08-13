import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildDeploymentHealth, readDeploymentArtifact } from "./deploymentHealth.js";

describe("buildDeploymentHealth", () => {
  it("exposes non-secret runtime identity needed to bind an operator to one deployment", () => {
    expect(buildDeploymentHealth({
      RAILWAY_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
      RAILWAY_SERVICE_ID: "22222222-2222-4222-8222-222222222222",
      RAILWAY_ENVIRONMENT_ID: "33333333-3333-4333-8333-333333333333",
      RAILWAY_DEPLOYMENT_ID: "44444444-4444-4444-8444-444444444444",
      DM_RECOVERY_HISTORICAL_ENABLED: "false",
    }, "production", {
      schemaVersion: 1,
      kind: "expanded-recovery-deployment-artifact",
      releaseSha: "a".repeat(40),
      sourceTreeSha256: "b".repeat(64),
      selectorSha256: "c".repeat(64),
      files: ["package.json"],
    })).toEqual({
      ok: true,
      env: "production",
      deployment: {
        projectId: "11111111-1111-4111-8111-111111111111",
        serviceId: "22222222-2222-4222-8222-222222222222",
        environmentId: "33333333-3333-4333-8333-333333333333",
        deploymentId: "44444444-4444-4444-8444-444444444444",
        releaseSha: "a".repeat(40),
        sourceTreeSha256: "b".repeat(64),
        selectorSha256: "c".repeat(64),
        historicalEnabled: false,
      },
    });
  });

  it("fails closed to null for absent or malformed deployment metadata", () => {
    expect(buildDeploymentHealth({ DM_RECOVERY_HISTORICAL_ENABLED: "maybe" }, "production", null)).toEqual({
      ok: true,
      env: "production",
      deployment: null,
    });
  });

  it("does not trust an operator-supplied release environment label without the deployed artifact", () => {
    expect(buildDeploymentHealth({
      RAILWAY_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
      RAILWAY_SERVICE_ID: "22222222-2222-4222-8222-222222222222",
      RAILWAY_ENVIRONMENT_ID: "33333333-3333-4333-8333-333333333333",
      RAILWAY_DEPLOYMENT_ID: "44444444-4444-4444-8444-444444444444",
      EXPANDED_RECOVERY_RELEASE_SHA: "a".repeat(40),
      DM_RECOVERY_HISTORICAL_ENABLED: "false",
    }, "production", null)).toMatchObject({ deployment: null });
  });

  it("recomputes every deployed file and rejects a tampered artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "expanded-recovery-artifact-"));
    try {
      await writeFile(path.join(root, "a.txt"), "safe", "utf8");
      const digest = createHash("sha256")
        .update("a.txt").update("\0").update("safe").update("\0").digest("hex");
      await writeFile(path.join(root, ".expanded-recovery-artifact.json"), JSON.stringify({
        schemaVersion: 1,
        kind: "expanded-recovery-deployment-artifact",
        releaseSha: "a".repeat(40),
        sourceTreeSha256: digest,
        selectorSha256: "c".repeat(64),
        files: ["a.txt"],
      }));
      expect(readDeploymentArtifact(root)).toMatchObject({ sourceTreeSha256: digest });
      await writeFile(path.join(root, "a.txt"), "tampered", "utf8");
      expect(readDeploymentArtifact(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
