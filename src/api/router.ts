import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAdmin } from "./auth.js";
import { keywordsRouter } from "./keywords.routes.js";
import { resourcesRouter } from "./resources.routes.js";
import { resourceCoversRouter } from "./resourceCovers.routes.js";
import { presentationCategoriesRouter } from "./presentationCategories.routes.js";
import { messagesRouter } from "./messages.routes.js";
import { uploadRouter } from "./upload.routes.js";
import { conversationsRouter } from "./conversations.routes.js";
import { statsRouter } from "./stats.routes.js";
import { mediaRouter } from "./media.routes.js";
import { usersRouter } from "./users.routes.js";
import { insightsRouter } from "./insights.routes.js";
import { aiRouter } from "./ai.routes.js";
import { dmThreadsRouter } from "./dmThreads.routes.js";
import { recoveryRemindersRouter } from "./recoveryReminders.routes.js";
import { historicalRecoveryRouter } from "./historicalRecovery.routes.js";
import { funnelsRouter } from "./funnels.routes.js";
import { guideDeliveriesRouter } from "./guideDeliveries.routes.js";
import { upcomingAutomationsRouter } from "./upcomingAutomations.routes.js";
import { flagsRouter } from "./flags.routes.js";
import { experimentsRouter } from "./experiments.routes.js";
import { logger } from "../lib/logger.js";

export const apiRouter = Router();

apiRouter.use(requireAdmin);

apiRouter.get("/me", (req, res) => {
  res.json({ email: req.adminEmail });
});

apiRouter.use("/keywords", keywordsRouter);
// Cover routes are mounted first because `/resources/:id` is otherwise a broad
// match. Both remain behind the same requireAdmin boundary above.
apiRouter.use("/resources", resourceCoversRouter);
apiRouter.use("/resources", resourcesRouter);
apiRouter.use("/presentation-categories", presentationCategoriesRouter);
apiRouter.use("/messages", messagesRouter);
apiRouter.use("/upload", uploadRouter);
apiRouter.use("/conversations", conversationsRouter);
apiRouter.use("/stats", statsRouter);
apiRouter.use("/media", mediaRouter);
apiRouter.use("/users", usersRouter);
apiRouter.use("/insights", insightsRouter);
apiRouter.use("/ai", aiRouter);
apiRouter.use("/dm-threads", dmThreadsRouter);
apiRouter.use("/guide-deliveries", guideDeliveriesRouter);
apiRouter.use("/recovery-reminders", recoveryRemindersRouter);
// Separate mount from /recovery-reminders on purpose (§40): the historical lens
// answers a different question, and mixing the two would let an owner approve 985
// public comments while thinking they were reviewing today's queue.
apiRouter.use("/historical-recovery", historicalRecoveryRouter);
// Funnels are their own mount rather than a tab under /insights: insights is
// scoped to reels ("which reels resonate"), while a funnel's axis is the
// conversation lifecycle. Same reason they get their own page.
apiRouter.use("/funnels", funnelsRouter);
apiRouter.use("/upcoming-automations", upcomingAutomationsRouter);
// Every switch in the system, and the only path that may change one. The enable
// fence lives in the route rather than the client.
apiRouter.use("/flags", flagsRouter);
// Separate mount from /flags, mirroring the two destinations in the console: a
// switch has a state, an experiment has a result. Read-only — an experiment is
// changed by changing the flags it owns, which is what /flags is for.
apiRouter.use("/experiments", experimentsRouter);

apiRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const code = err && typeof err === "object" && "code" in err ? (err as { code: string }).code : undefined;
  if (code === "P2025") return res.status(404).json({ error: "not_found" });
  if (code === "P2002") return res.status(409).json({ error: "unique_violation" });
  logger.error({ errorCode: "api_unhandled_error" }, "API error");
  res.status(500).json({ error: "internal_error" });
});
