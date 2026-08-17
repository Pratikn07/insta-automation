import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const detector = path.resolve("scripts/check-guide-delivery-bypasses.mjs");
const temporaryRoots: string[] = [];

function runDetector(root: string) {
  return spawnSync(process.execPath, [detector, "--root", root], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("guide-delivery bypass detector", () => {
  it("rejects a legacy sender import anywhere outside the ownership choke point", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'import { sendSequence } from "../src/services/sequenceSender.js";\n' +
        'await sendSequence({ igUserId: "1", messages: [], source: "guide_automation" });\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("rejects an aliased CommonJS legacy sender import", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.cjs"),
      'const { sendSequence: legacySend } = require("../src/services/sequenceSender.js");\n' +
        'legacySend({ igUserId: "1", messages: [], source: "guide_automation" });\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.cjs");
  });

  it("rejects a second legacy call hidden inside the allowed handler file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "src", "handlers"), { recursive: true });
    mkdirSync(path.join(root, "src", "services"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "handlers", "messageHandler.ts"),
      'import { sendSequence } from "../services/sequenceSender.js";\n' +
        'sendSequence({ igUserId: "1", messages: [], source: "guide_automation" });\n' +
        'sendSequence({ igUserId: "2", messages: [], source: "guide_automation" });\n',
    );
    writeFileSync(
      path.join(root, "src", "services", "sequenceSender.ts"),
      "export async function sendSequence() {}\n",
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("src/handlers/messageHandler.ts");
  });

  it("accepts the repository only when no hidden legacy sender path exists", () => {
    const result = runDetector(process.cwd());
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("guide_delivery_bypass_check_passed");
  });
});
