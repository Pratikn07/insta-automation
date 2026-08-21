export function migrationDatabaseUrl(
  environment: { DATABASE_URL?: string; DIRECT_URL?: string },
): string {
  const url = environment.DIRECT_URL || environment.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL or DIRECT_URL is required to run migrations");
  return url;
}
