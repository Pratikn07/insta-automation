/**
 * Deciding whether a repeated create is the same create.
 *
 * The browser cannot always tell whether a create reached us: a timeout after
 * dispatch looks exactly like a success we never heard about. So the client owns
 * the row's UUID, sends it in the body, and repeats the *same* UUID if it has to
 * ask again. That turns "did this happen?" into a primary-key lookup.
 *
 * Two answers matter. If the stored row matches what this request intends, the
 * request already happened and its result is the stored row — a replay. If it
 * differs, the caller reused one key for two different intents, which is a bug we
 * must surface rather than paper over by returning the wrong row.
 *
 * Only request-owned fields are compared. Server-assigned values like `order` and
 * `createdAt` cannot disagree with a request that never mentioned them.
 */

export type CreateReplayVerdict = "replay" | "conflict";

/** Collapse the representational differences between a request and a row. */
function normalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  const a = normalize(left);
  const b = normalize(right);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    // Order is part of the value: a reordered array is a different intent.
    return a.every((item, index) => sameValue(item, b[index]));
  }
  // Strict, so `true` and `"true"` stay different things.
  return a === b;
}

export function classifyCreateReplay<T extends Record<string, unknown>>(input: {
  existing: T;
  intended: Partial<Record<keyof T, unknown>>;
  keys: readonly (keyof T)[];
}): CreateReplayVerdict {
  for (const key of input.keys) {
    if (!sameValue(input.existing[key], input.intended[key])) return "conflict";
  }
  return "replay";
}

/** Prisma's unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

/**
 * Whether a unique violation was the primary key rather than a business key.
 *
 * A clash on `id` means this exact create was already performed. A clash on, say,
 * `[keyword, mediaId]` means a *different* row already owns that pair, which is
 * the existing domain duplicate and keeps its existing response.
 */
export function isPrimaryKeyViolation(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const fields = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return fields.length > 0 && fields.every((field) => field === "id");
}

/**
 * The header must agree with the body when both name the operation.
 *
 * Disagreement means two different identities for one request and there is no
 * safe way to guess which one the caller meant, so it is rejected before any
 * write happens.
 */
export function idempotencyKeyMismatch(
  header: string | string[] | undefined,
  bodyId: string,
): boolean {
  if (header === undefined) return false;
  const key = Array.isArray(header) ? header[0] : header;
  if (key === undefined || key === "") return false;
  return key !== bodyId;
}
