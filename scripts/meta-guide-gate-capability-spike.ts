import { pathToFileURL } from "node:url";
import { env } from "../src/config/env.js";
import { GRAPH_VERSION, graph } from "../src/meta/graphClient.js";
import {
  buildCapabilityInputFromEnvironment,
  parseGuideGateCapabilityCli,
  runGuideGateCapabilityCase,
} from "../src/meta/guideGateCapabilitySpike.js";
import type { GuideGateCapabilityPayload } from "../src/meta/guideGatePayloads.js";

type GraphSendResponse = { message_id?: string };

export async function runMetaGuideGateCapabilityCli(
  args: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const parsed = parseGuideGateCapabilityCli(args);
  const payloadInput = buildCapabilityInputFromEnvironment(parsed.case, environment);
  const result = await runGuideGateCapabilityCase(
    {
      graphVersion: GRAPH_VERSION,
      now: () => new Date(),
      send: async (payload: GuideGateCapabilityPayload) => {
        const response = await graph.post<GraphSendResponse>(`/${env.IG_USER_ID}/messages`, payload);
        return { status: response.status, data: response.data };
      },
    },
    { confirmedControlledSend: parsed.confirmedControlledSend, payloadInput },
  );

  console.log(JSON.stringify(result));
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  runMetaGuideGateCapabilityCli().catch(() => {
    console.error("meta_guide_gate_capability_failed");
    process.exitCode = 1;
  });
}
