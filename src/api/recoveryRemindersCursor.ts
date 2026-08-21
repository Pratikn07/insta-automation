import { Buffer } from "node:buffer";
import { z } from "zod";
import { isDayKey } from "../services/analyticsDay.js";

const MAX_CURSOR_LENGTH = 1_024;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

const daySchema = z.string().refine(isDayKey);
const scopeObjectSchema = z
  .object({
    id: z.string().uuid(),
    from: daySchema,
    to: daySchema,
    asOf: z.string().datetime({ offset: true }),
  })
  .strict();

const scopeSchema = scopeObjectSchema.refine((scope) => scope.from <= scope.to);

const payloadSchema = scopeObjectSchema
  .extend({ v: z.literal(1) })
  .strict()
  .refine((scope) => scope.from <= scope.to);

export type RecoveryCursorScope = z.infer<typeof scopeSchema>;
export type RecoveryCursorRequestScope = Pick<
  RecoveryCursorScope,
  "from" | "to" | "asOf"
>;

function invalidCursor(): never {
  throw new Error("invalid_cursor");
}

export function encodeRecoveryCursor(scope: RecoveryCursorScope): string {
  const parsed = scopeSchema.safeParse(scope);
  if (!parsed.success) return invalidCursor();

  return Buffer.from(
    JSON.stringify({ v: 1, ...parsed.data }),
    "utf8",
  ).toString("base64url");
}

export function decodeRecoveryCursor(
  token: string,
  currentScope: RecoveryCursorRequestScope,
): RecoveryCursorScope {
  if (
    token.length === 0 ||
    token.length > MAX_CURSOR_LENGTH ||
    !BASE64URL_RE.test(token)
  ) {
    return invalidCursor();
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return invalidCursor();
  }

  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) return invalidCursor();

  const { v: _version, ...scope } = parsed.data;
  if (
    scope.from !== currentScope.from ||
    scope.to !== currentScope.to ||
    scope.asOf !== currentScope.asOf
  ) {
    throw new Error("invalid_cursor_scope");
  }

  return scope;
}
