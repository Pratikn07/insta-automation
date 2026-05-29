import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

declare module "express-serve-static-core" {
  interface Request {
    rawBody?: Buffer;
  }
}

export function captureRawBody(req: Request, _res: Response, buf: Buffer) {
  req.rawBody = buf;
}

export function verifyMetaSignature(req: Request, res: Response, next: NextFunction) {
  const header = req.get("x-hub-signature-256");
  if (!header || !header.startsWith("sha256=")) {
    logger.warn("Missing or malformed X-Hub-Signature-256");
    return res.sendStatus(401);
  }

  const signature = header.slice("sha256=".length);
  const expected = crypto
    .createHmac("sha256", env.META_APP_SECRET)
    .update(req.rawBody ?? Buffer.alloc(0))
    .digest("hex");

  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    logger.warn("Invalid webhook signature");
    return res.sendStatus(401);
  }

  next();
}

export function handleVerification(req: Request, res: Response) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === env.META_VERIFY_TOKEN && typeof challenge === "string") {
    logger.info("Webhook verification handshake succeeded");
    return res.status(200).send(challenge);
  }

  logger.warn({ mode, tokenMatch: token === env.META_VERIFY_TOKEN }, "Webhook verification failed");
  return res.sendStatus(403);
}
