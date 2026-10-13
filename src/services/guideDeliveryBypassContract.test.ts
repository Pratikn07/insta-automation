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

  it("rejects a CommonJS loader identifier alias", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.cjs"),
      'const senderPath = "../src/services/sequence" + "Sender.js";\n' +
        "const load = require;\n" +
        "const [hiddenSend] = Object.values(load(senderPath));\n" +
        'hiddenSend({ igUserId: "1", messages: [], source: "guide_automation" });\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.cjs");
  });

  it("rejects a CommonJS loader propagated through object shorthand and member aliases", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.cjs"),
      "const loaders = { require };\n" +
        "const load = loaders.require;\n" +
        'load("../src/services/sequenceSender.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.cjs");
  });

  it("accepts the inverse object member when its value is not a loader", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "safe.mjs"),
      "const require = (value) => value;\n" +
        "const loaders = { require };\n" +
        "const load = loaders.require;\n" +
        'load("./safe.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("guide_delivery_bypass_check_passed");
  });

  it("fails closed for a computed member of an object containing a loader factory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'import { createRequire } from "node:module";\n' +
        "const factories = { createRequire };\n" +
        "const selected = process.argv[2];\n" +
        "const load = factories[selected](import.meta.url);\n" +
        'load("../src/services/sequenceSender.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("accepts a computed member of an object with no loader provenance", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "safe.mjs"),
      "const loaders = { safe: (value) => value };\n" +
        "const selected = process.argv[2];\n" +
        "const load = loaders[selected];\n" +
        'load("./safe.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("guide_delivery_bypass_check_passed");
  });

  it("rejects a canonical createRequire-derived loader", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'import { createRequire } from "node:module";\n' +
        "const load = createRequire(import.meta.url);\n" +
        'load("../src/services/sequenceSender.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("accepts a createRequire-derived loader for a non-sender module", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "safe.mjs"),
      'import { createRequire } from "node:module";\n' +
        "const load = createRequire(import.meta.url);\n" +
        'load("./safe.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("guide_delivery_bypass_check_passed");
  });

  it("rejects a destructured CommonJS createRequire alias", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.cjs"),
      'const { createRequire: makeLoader } = require("node:module");\n' +
        "const load = makeLoader(__filename);\n" +
        'load("../src/services/sequenceSender.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.cjs");
  });

  it("rejects a namespace createRequire loader", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'import * as moduleApi from "node:module";\n' +
        "const load = moduleApi.createRequire(import.meta.url);\n" +
        'load("../src/services/sequenceSender.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("rejects a sender module specifier with a query or hash suffix", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'await import("../src/services/sequenceSender.js?bypass#fragment");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("accepts a non-sender module specifier with query and hash suffixes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "safe.mjs"),
      'await import("./safe.js?cache=1#fragment");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("guide_delivery_bypass_check_passed");
  });

  it("rejects a sender reference consumed through a default node:module import", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'import moduleApi from "node:module";\n' +
        "const load = moduleApi.createRequire(import.meta.url);\n" +
        'load("../src/services/sequenceSender.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("rejects a sender reference consumed through a dynamic node:module default", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'const moduleApi = (await import("node:module")).default;\n' +
        "const load = moduleApi.createRequire(import.meta.url);\n" +
        'load("../src/services/sequenceSender.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("rejects a sender reference nested in objects and destructuring", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'const toolbox = { nested: { candidate: "../src/services/sequenceSender.js" } };\n' +
        "const { nested: { candidate } } = toolbox;\n" +
        "console.info(candidate);\n",
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("rejects a sender reference after a createRequire loader is reassigned", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'import { createRequire } from "node:module";\n' +
        "let load = (value) => value;\n" +
        "load = createRequire(import.meta.url);\n" +
        'load("../src/services/sequenceSender.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("rejects a sender reference consumed through TypeScript import-equals", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.cts"),
      'import moduleApi = require("node:module");\n' +
        "const load = moduleApi.createRequire(__filename);\n" +
        'load("../src/services/sequenceSender.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.cts");
  });

  it("rejects a sender reference consumed through process.getBuiltinModule", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'const moduleApi = process.getBuiltinModule("node:module");\n' +
        "const load = moduleApi.createRequire(import.meta.url);\n" +
        'load("../src/services/sequenceSender.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("rejects a percent-encoded sender module name", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'await import("../src/services/sequence%53ender.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("rejects a sender module name through arbitrarily nested percent encoding", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'const candidate = "../src/services/sequence%25252525252525252553ender.js";\n' +
        "console.info(candidate);\n",
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("rejects a constant concatenated sender reference without a loader", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'const directory = "../src/" + "services";\n' +
        'const candidate = directory + "/sequence" + "Sender.js";\n' +
        "console.info(candidate);\n",
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("rejects a sender reference after separator and traversal normalization", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.cjs"),
      'const candidate = "..\\\\src\\\\other\\\\..\\\\services\\\\sequenceSender.js";\n' +
        "console.info(candidate);\n",
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.cjs");
  });

  it("fails closed when an ambiguous string construction has sender-significant fragments", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      'const prefix = "../src/services/sequence";\n' +
        'const candidate = prefix + process.argv[2] + "Sender.js";\n' +
        "console.info(candidate);\n",
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("accepts sender-like near names and inverse lexical shadows", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "safe.mjs"),
      'const candidate = "../src/services/sequenceSenders.js";\n' +
        "function unrelated() {\n" +
        '  const candidate = "../src/services/sequenceSenderBackup.js";\n' +
        "  return candidate;\n" +
        "}\n" +
        'console.info(candidate, unrelated(), "../src/services/sequence%53ender.test.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("guide_delivery_bypass_check_passed");
  });

  it("rejects a local dynamic-import wrapper", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.mjs"),
      "const load = (candidate) => import(candidate);\n" +
        'const senderPath = "../src/services/sequence" + "Sender.js";\n' +
        "const [hiddenSend] = Object.values(await load(senderPath));\n" +
        'await hiddenSend({ igUserId: "1", messages: [], source: "guide_automation" });\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.mjs");
  });

  it("accepts a CommonJS loader alias that references only a safe module", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "safe.cjs"),
      "const load = require;\n" +
        'load("./safe.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("guide_delivery_bypass_check_passed");
  });

  it("accepts a dynamic-import wrapper that references only a safe module", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "safe.mjs"),
      "const load = (candidate) => import(candidate);\n" +
        'await load("./safe.js");\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("guide_delivery_bypass_check_passed");
  });

  it("resolves an outer sender path despite a safe nested shadow", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "rogue.cjs"),
      'const senderPath = "../src/services/sequence" + "Sender.js";\n' +
        "function unrelated() {\n" +
        '  const senderPath = "./safe.js";\n' +
        "  return senderPath;\n" +
        "}\n" +
        "const [hiddenSend] = Object.values(require(senderPath));\n" +
        'hiddenSend({ igUserId: "1", messages: [], source: "guide_automation" });\n',
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("scripts/rogue.cjs");
  });

  it("does not apply a nested sender-path shadow to a safe outer loader call", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guide-delivery-bypass-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "safe.cjs"),
      'const modulePath = "./safe.js";\n' +
        "function unrelated() {\n" +
        '  const modulePath = "../src/services/sequence" + "SenderBackup.js";\n' +
        "  return modulePath;\n" +
        "}\n" +
        "require(modulePath);\n",
    );

    const result = runDetector(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("guide_delivery_bypass_check_passed");
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
    // The detector type-checks the whole repository, which takes 5–6s on a 4-core machine.
  }, 30_000);
});
