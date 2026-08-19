import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import {
  getBusinessOverview,
  getConversationSummary,
  getKeywordGuideCatalog,
} from "../services/advisorReadService.js";
import { requireInternalRuntime } from "./internalAuth.js";
import { asyncRouter } from "./asyncRouter.js";

/**
 * The runtime→API data surface for the advisor.
 *
 * Three named tools, nothing generic. There is deliberately no path that accepts a
 * query, a table name, or a filter of the model's choosing: the advisor can ask
 * these three questions and no others.
 *
 * Mounted at /internal/ai in server.ts BEFORE cors and before the owner's
 * /api router, so it never inherits browser CORS or Supabase `requireAdmin` — the
 * two auth directions stay separate.
 */
export const internalAiRouter = asyncRouter();

internalAiRouter.use(requireInternalRuntime(env.TINY_SOHO_INTERNAL_TOKEN));

// `.strict()` on every schema: an unexpected key is a contract mismatch (or an
// attempt to widen the query), so it fails rather than being ignored.
const windowSchema = z.object({ windowDays: z.union([z.literal(7), z.literal(30)]) }).strict();
const catalogSchema = z.object({ limit: z.number().int().min(1).max(100) }).strict();
const summarySchema = z
  .object({
    windowDays: z.union([z.literal(7), z.literal(30)]),
    limit: z.number().int().min(1).max(25),
  })
  .strict();

/** Wrap a tool so a database failure never returns detail to the runtime. */
function tool<T>(name: string, run: (body: unknown) => Promise<T>) {
  return async (req: import("express").Request, res: import("express").Response) => {
    try {
      res.json(await run(req.body));
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "invalid_arguments" });
        return;
      }
      logger.error({ errorCode: "advisor_tool_failed", tool: name }, "Advisor tool failed");
      res.status(503).json({ error: "tool_unavailable" });
    }
  };
}

internalAiRouter.post(
  "/tools/business_overview",
  tool("business_overview", async (body) =>
    getBusinessOverview(windowSchema.parse(body)),
  ),
);

internalAiRouter.post(
  "/tools/keyword_guide_catalog",
  tool("keyword_guide_catalog", async (body) =>
    getKeywordGuideCatalog(catalogSchema.parse(body)),
  ),
);

internalAiRouter.post(
  "/tools/conversation_summary",
  tool("conversation_summary", async (body) =>
    getConversationSummary(summarySchema.parse(body)),
  ),
);

// Any other tool name is unknown — the registry is closed, so a model inventing a
// name gets a 404 rather than reaching a handler.
internalAiRouter.use((_req, res) => {
  res.status(404).json({ error: "unknown_tool" });
});
