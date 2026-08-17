import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".superpowers",
  "coverage",
  "dist",
  "node_modules",
]);
const EXECUTABLE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts"]);
const ALLOWED_IMPORT_PATH = "src/handlers/messageHandler.ts";
const ALLOWED_CALL_PATHS = new Set([
  "src/handlers/messageHandler.ts",
  "src/services/sequenceSender.ts",
]);
const DETECTOR_PATH = "scripts/check-guide-delivery-bypasses.mjs";

function repositoryRoot(argv) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1) return process.cwd();
  const supplied = argv[rootIndex + 1];
  if (!supplied) throw new Error("guide_delivery_bypass_root_missing");
  return path.resolve(supplied);
}

function executableFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) visit(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !EXECUTABLE_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (/\.(?:spec|test)\.[cm]?[jt]s$/.test(entry.name)) continue;
      files.push(path.join(directory, entry.name));
    }
  };
  visit(root);
  return files;
}

function normalizedRelativePath(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function bypasses(root) {
  const findings = [];
  const legacyModuleReference = /["'][^"'\n]*sequenceSender(?:\.js|\.ts)?["']/g;
  const legacyCall = /\bsendSequence\s*\(/g;

  for (const file of executableFiles(root)) {
    const relative = normalizedRelativePath(root, file);
    if (relative === DETECTOR_PATH) continue;
    const source = readFileSync(file, "utf8");
    const moduleReferenceCount = [...source.matchAll(legacyModuleReference)].length;
    const callCount = [...source.matchAll(legacyCall)].length;
    if (relative === ALLOWED_IMPORT_PATH) {
      if (moduleReferenceCount !== 1) {
        findings.push(`${relative}: expected one legacy sequenceSender import, found ${moduleReferenceCount}`);
      }
    } else if (moduleReferenceCount > 0) {
      findings.push(`${relative}: legacy sequenceSender import`);
    }
    if (relative === ALLOWED_IMPORT_PATH && callCount !== 1) {
      findings.push(`${relative}: expected one owned sendSequence call, found ${callCount}`);
    } else if (!ALLOWED_CALL_PATHS.has(relative) && callCount > 0) {
      findings.push(`${relative}: legacy sendSequence call`);
    }
  }
  return findings;
}

const root = repositoryRoot(process.argv.slice(2));
const findings = bypasses(root);
if (findings.length > 0) {
  console.error("guide_delivery_bypass_detected");
  for (const finding of findings) console.error(finding);
  process.exitCode = 1;
} else {
  console.log("guide_delivery_bypass_check_passed");
}
