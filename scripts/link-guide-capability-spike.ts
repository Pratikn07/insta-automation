// scripts/link-guide-capability-spike.ts
// @prisma/client first: from a worktree it is what loads .env into process.env, and env
// validation below would otherwise exit 1.
import "@prisma/client";
import { pathToFileURL } from "node:url";
import { env } from "../src/config/env.js";
import { graph } from "../src/meta/graphClient.js";
import {
  buildLinkGuideSpikePayload,
  linkGuideSpikeOutcome,
  parseLinkGuideSpikeCli,
  runLinkGuideSpikeCase,
} from "../src/meta/linkGuideCapabilitySpike.js";
import type { MetaMessagePayload } from "../src/meta/sendMessage.js";

type GraphSendResponse = { message_id?: string };

export async function runLinkGuideCapabilityCli(
  args: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const parsed = parseLinkGuideSpikeCli(args);
  const payload = buildLinkGuideSpikePayload(parsed.case, environment);
  const result = await runLinkGuideSpikeCase(
    {
      now: () => new Date(),
      send: async (body: MetaMessagePayload) => {
        const response = await graph.post<GraphSendResponse>(`/${env.IG_USER_ID}/messages`, body);
        return { status: response.status, data: response.data };
      },
    },
    { case: parsed.case, confirmedControlledSend: parsed.confirmedControlledSend, payload },
  );
  console.log(JSON.stringify(result));
  const outcome = linkGuideSpikeOutcome(result);
  if (outcome === "unknown") console.error("outcome_unknown_do_not_retry");
  // Anything but an accepted send is a non-zero exit, so a wrapper can't read it as a pass.
  if (outcome !== "accepted") process.exitCode = outcome === "unknown" ? 2 : 1;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  runLinkGuideCapabilityCli().catch((error: unknown) => {
    // Only our own fixed identifiers (case, args, missing variable, controlled-send guard)
    // reach here, because Graph errors are caught inside runLinkGuideSpikeCase. Anything
    // else gets the generic line, so an arbitrary message never reaches stderr.
    const message = error instanceof Error ? error.message : "";
    console.error(/^[a-z0-9_]+$/.test(message) ? message : "link_guide_capability_failed");
    process.exitCode = 1;
  });
}
