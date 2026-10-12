// scripts/link-guide-capability-spike.ts
// @prisma/client first: from a worktree it is what loads .env into process.env, and env
// validation below would otherwise exit 1.
import "@prisma/client";
import { pathToFileURL } from "node:url";
import { env } from "../src/config/env.js";
import { graph } from "../src/meta/graphClient.js";
import {
  buildLinkGuideSpikePayload,
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
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  runLinkGuideCapabilityCli().catch(() => {
    console.error("link_guide_capability_failed");
    process.exitCode = 1;
  });
}
