import type { Request, Response, NextFunction } from "express";
import { supabase } from "../lib/supabase.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

declare module "express-serve-static-core" {
  interface Request {
    adminEmail?: string;
  }
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_bearer_token" });
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) return res.status(401).json({ error: "empty_token" });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    logger.warn({ err: error?.message }, "Admin token rejected by Supabase");
    return res.status(401).json({ error: "invalid_token" });
  }

  const email = data.user.email?.toLowerCase();
  if (!email) return res.status(403).json({ error: "no_email_on_user" });

  if (!env.ADMIN_EMAIL) {
    logger.error("ADMIN_EMAIL not configured; refusing all admin access");
    return res.status(503).json({ error: "admin_not_configured" });
  }
  if (email !== env.ADMIN_EMAIL.toLowerCase()) {
    logger.warn({ email }, "Non-allowlisted email attempted admin access");
    return res.status(403).json({ error: "not_allowed" });
  }

  req.adminEmail = email;
  next();
}
