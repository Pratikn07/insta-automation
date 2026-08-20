import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RETIRED_APPLY_ERROR = "guide_delivery_apply_retired";
const NO_DATABASE =
  "postgresql://no-user:no-password@127.0.0.1:1/no-database?connect_timeout=1";

describe.each([
  "scripts/deliver-open-gate-replies.mjs",
  "scripts/rearm-retry-gates.mjs",
])("%s", (script) => {
  it("refuses the retired apply mode before database or provider work", () => {
    const result = spawnSync(process.execPath, [path.resolve(script), "--apply"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        DATABASE_URL: NO_DATABASE,
        MIGRATION_TEST_DATABASE_URL: "",
        MIGRATION_TEST_DATABASE_DISPOSABLE: "",
      },
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(output).toContain(RETIRED_APPLY_ERROR);
    expect(output).not.toContain("Can't reach database server");
    expect(output).not.toContain("delivered →");
  });
});
