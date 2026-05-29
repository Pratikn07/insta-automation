// Prompts for a secret with hidden input and writes it to .env
// Usage: node scripts/set-env-secret.mjs KEY_NAME
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import readline from "node:readline";

const key = process.argv[2];
if (!key) {
  console.error("Usage: node scripts/set-env-secret.mjs KEY_NAME");
  process.exit(1);
}

function promptHidden(question) {
  return new Promise((resolveP) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(question);
    process.stdin.setRawMode?.(true);
    let value = "";
    process.stdin.on("data", function onData(buf) {
      const ch = buf.toString("utf8");
      if (ch === "\n" || ch === "\r" || ch === "") {
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener("data", onData);
        rl.close();
        process.stdout.write("\n");
        resolveP(value);
      } else if (ch === "") {
        process.exit(130);
      } else if (ch === "" || ch === "\b") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    });
  });
}

const envPath = resolve(process.cwd(), ".env");
const original = readFileSync(envPath, "utf8");
const value = await promptHidden(`Paste value for ${key} (input hidden): `);

if (!value) {
  console.error("Empty value, aborting.");
  process.exit(1);
}

const re = new RegExp(`^${key}=.*$`, "m");
const line = `${key}=${value}`;
const updated = re.test(original) ? original.replace(re, line) : `${original.trimEnd()}\n${line}\n`;
writeFileSync(envPath, updated);
console.log(`✅ ${key} written to .env (length: ${value.length})`);
