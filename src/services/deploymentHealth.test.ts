import { describe, expect, it } from "vitest";
import { buildDeploymentHealth } from "./deploymentHealth.js";

describe("buildDeploymentHealth", () => {
  it("exposes non-secret runtime identity needed to bind an operator to one deployment", () => {
    expect(buildDeploymentHealth({
      RAILWAY_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
      RAILWAY_SERVICE_ID: "22222222-2222-4222-8222-222222222222",
      RAILWAY_ENVIRONMENT_ID: "33333333-3333-4333-8333-333333333333",
      RAILWAY_DEPLOYMENT_ID: "44444444-4444-4444-8444-444444444444",
      EXPANDED_RECOVERY_RELEASE_SHA: "a".repeat(40),
      DM_RECOVERY_HISTORICAL_ENABLED: "false",
    }, "production")).toEqual({
      ok: true,
      env: "production",
      deployment: {
        projectId: "11111111-1111-4111-8111-111111111111",
        serviceId: "22222222-2222-4222-8222-222222222222",
        environmentId: "33333333-3333-4333-8333-333333333333",
        deploymentId: "44444444-4444-4444-8444-444444444444",
        releaseSha: "a".repeat(40),
        historicalEnabled: false,
      },
    });
  });

  it("fails closed to null for absent or malformed deployment metadata", () => {
    expect(buildDeploymentHealth({ DM_RECOVERY_HISTORICAL_ENABLED: "maybe" }, "production")).toEqual({
      ok: true,
      env: "production",
      deployment: null,
    });
  });
});
