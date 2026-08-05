import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Service authentication for the runtime→API direction.
 *
 * Deliberately separate from the owner's Supabase `requireAdmin`: a Supabase user
 * token must NEVER open these routes, and this service token must never open the
 * owner's. Two directions, two secrets, rotated independently.
 *
 * Same constant-time shape as the runtime's own bearer check: `timingSafeEqual`
 * throws on a length mismatch, so both sides are compared at equal width and a
 * wrong-length token costs the same as a wrong-value one.
 */
function safeEqual(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function requireInternalRuntime(secret: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // An unset secret must fail closed. Without this, a deploy that forgot the
    // variable would expose the advisor's data routes unauthenticated.
    if (!secret) {
      res.status(503).json({ error: "internal_ai_not_configured" });
      return;
    }
    const header = req.get("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token || !safeEqual(token, secret)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
