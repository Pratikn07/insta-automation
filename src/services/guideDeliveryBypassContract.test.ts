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

  it("rejects an identifier alias beside the permitted direct handler call", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "src", "handlers"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "handlers", "messageHandler.ts"),
      'import { sendSequence } from "../services/sequenceSender.js";\n' +
        'async function deliverOwnedGuide(owner = "legacy") {\n' +
        "  switch (owner) {\n" +
        '    case "legacy": {\n' +
        '      await sendSequence({ igUserId: "1", messages: [], source: "guide_automation" });\n' +
        "      const hiddenSend = sendSequence;\n" +
        '      await hiddenSend({ igUserId: "2", messages: [], source: "guide_automation" });\n' +
        "      return;\n" +
        "    }\n" +
        "  }\n" +
        "}\n",
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("src/handlers/messageHandler.ts");
  });

  it("rejects a renamed static import even when literal counts look permitted", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "src", "handlers"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "handlers", "messageHandler.ts"),
      'import { sendSequence as hiddenSend } from "../services/sequenceSender.js";\n' +
        'async function deliverOwnedGuide(owner = "legacy") {\n' +
        "  switch (owner) {\n" +
        '    case "legacy": {\n' +
        '      await sendSequence({ igUserId: "1", messages: [], source: "guide_automation" });\n' +
        '      await hiddenSend({ igUserId: "2", messages: [], source: "guide_automation" });\n' +
        "      return;\n" +
        "    }\n" +
        "  }\n" +
        "}\n",
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("src/handlers/messageHandler.ts");
  });

  it("rejects require destructuring reached through a computed sender path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.cjs"),
      'const senderPath = "../src/services/" + "sequence" + "Sender.js";\n' +
        'const { ["send" + "Sequence"]: hiddenSend } = require(senderPath);\n' +
        'hiddenSend({ igUserId: "1", messages: [], source: "guide_automation" });\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.cjs");
  });

  it("rejects a dynamic import reached through a computed sender path alias", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'const senderPath = `../src/services/${"sequence"}${"Sender"}.js`;\n' +
        "const [hiddenSend] = Object.values(await import(senderPath));\n" +
        'await hiddenSend({ igUserId: "1", messages: [], source: "guide_automation" });\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("scans executable TSX source for hidden sender imports", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "web", "src"), { recursive: true });
    writeFileSync(
      path.join(root, "web", "src", "rogue.tsx"),
      'import { sendSequence as hiddenSend } from "../../src/services/sequenceSender.js";\n' +
        "export const Rogue = () => <button onClick={() => hiddenSend({})}>Send</button>;\n",
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("web/src/rogue.tsx");
  });

  it("fails closed when an executable source file cannot be parsed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "broken.mjs"), "const = ;\n");

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/broken.mjs");
    expect(output).toContain("parse failed");
  });

  it("fails closed when executable source is not valid UTF-8", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "broken.mjs"), Buffer.from([0xc3, 0x28]));

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/broken.mjs");
    expect(output).toContain("read failed");
  });

  it("accepts only the intended static import and direct owner-branch call shape", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "src", "handlers"), { recursive: true });
    mkdirSync(path.join(root, "src", "services"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "handlers", "messageHandler.ts"),
      'import { sendSequence } from "../services/sequenceSender.js";\n' +
        'async function deliverOwnedGuide(owner = "legacy") {\n' +
        "  switch (owner) {\n" +
        '    case "legacy":\n' +
        '      await sendSequence({ igUserId: "1", messages: [], source: "guide_automation" });\n' +
        "      return;\n" +
        "  }\n" +
        "}\n",
    );
    writeFileSync(
      path.join(root, "src", "services", "sequenceSender.ts"),
      "export async function sendSequence(_input: unknown) {}\n",
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("guide_delivery_bypass_check_passed");
  });

  it("accepts the repository only when no hidden legacy sender path exists", () => {
    const result = runDetector(process.cwd());
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("guide_delivery_bypass_check_passed");
  });
});
