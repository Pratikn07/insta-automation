import { spawnSync } from "node:child_process";
import { migrationDatabaseUrl } from "./services/migrationDatabaseUrl.js";

// Runtime traffic may use a transaction pool while schema migration needs a
// direct PostgreSQL session. DIRECT_URL is optional so local/test workflows keep
// using their existing DATABASE_URL unchanged.
const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["prisma", "migrate", "deploy"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: migrationDatabaseUrl(process.env),
    },
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

