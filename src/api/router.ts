import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAdmin } from "./auth.js";
import { keywordsRouter } from "./keywords.routes.js";
import { resourcesRouter } from "./resources.routes.js";
import { messagesRouter } from "./messages.routes.js";
import { uploadRouter } from "./upload.routes.js";
import { conversationsRouter } from "./conversations.routes.js";
import { statsRouter } from "./stats.routes.js";
import { mediaRouter } from "./media.routes.js";
import { usersRouter } from "./users.routes.js";
import { logger } from "../lib/logger.js";

export const apiRouter = Router();

apiRouter.use(requireAdmin);

apiRouter.get("/me", (req, res) => {
  res.json({ email: req.adminEmail });
});

apiRouter.use("/keywords", keywordsRouter);
apiRouter.use("/resources", resourcesRouter);
apiRouter.use("/messages", messagesRouter);
apiRouter.use("/upload", uploadRouter);
apiRouter.use("/conversations", conversationsRouter);
apiRouter.use("/stats", statsRouter);
apiRouter.use("/media", mediaRouter);
apiRouter.use("/users", usersRouter);

apiRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const code = err && typeof err === "object" && "code" in err ? (err as { code: string }).code : undefined;
  if (code === "P2025") return res.status(404).json({ error: "not_found" });
  if (code === "P2002") return res.status(409).json({ error: "unique_violation" });
  logger.error({ err }, "API error");
  res.status(500).json({ error: "internal_error" });
});
