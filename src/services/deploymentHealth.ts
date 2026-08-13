const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_SHA = /^[a-f0-9]{40}$/;

/** Non-secret runtime attestation used to prove which Railway release serves the API. */
export function buildDeploymentHealth(environment: NodeJS.ProcessEnv, nodeEnv: string) {
  const projectId = environment.RAILWAY_PROJECT_ID;
  const serviceId = environment.RAILWAY_SERVICE_ID;
  const environmentId = environment.RAILWAY_ENVIRONMENT_ID;
  const deploymentId = environment.RAILWAY_DEPLOYMENT_ID;
  const releaseSha = environment.EXPANDED_RECOVERY_RELEASE_SHA;
  const historicalRaw = environment.DM_RECOVERY_HISTORICAL_ENABLED;
  if (
    !projectId || !UUID.test(projectId)
    || !serviceId || !UUID.test(serviceId)
    || !environmentId || !UUID.test(environmentId)
    || !deploymentId || !UUID.test(deploymentId)
    || !releaseSha || !GIT_SHA.test(releaseSha)
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
      releaseSha,
      historicalEnabled: historicalRaw === "true",
    },
  };
}
