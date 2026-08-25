/**
 * Prisma's foreign-key constraint failure.
 *
 * Its own module rather than sitting alongside the classifiers in `createReplay.ts`,
 * which is about whether a repeated create is the same create — a delete blocked by
 * a reference is a different question that happens to read the same field. Shared
 * rather than copied because every delete route that clears its own dependents needs
 * the same backstop, and the one that forgets it answers a 500 instead of a refusal.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: unknown }).code === "P2003"
  );
}
