import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Constant-time bearer check for the private runtime routes.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak length
 * through the error path, so both sides are hashed to a fixed-width buffer first
 * — a wrong-length token then costs the same as a wrong-value one.
 */
function safeEqual(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still perform a comparison of equal-length buffers so the work is constant.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function requireRuntimeSecret(runtimeSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.get("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token || !safeEqual(token, runtimeSecret)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
