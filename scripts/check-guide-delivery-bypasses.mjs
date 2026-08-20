import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Directories this detector must not walk.
 *
 * The nested ones matter as much as node_modules. A git worktree under
 * `.worktrees/` or `.claude/worktrees/` is a full second copy of this repository,
 * so walking it re-reads `src/handlers/messageHandler.ts` at a path that does not
 * equal HANDLER_PATH — and every legitimate legacy reference in that copy is then
 * reported as a bypass "outside its permitted shape". One nested worktree produced
 * 117 findings, none of them about code that ships.
 *
 * That is worse than a false alarm. A safety check whose output is mostly noise is
 * a safety check people learn to skip, which is the failure it exists to prevent.
 *
 * The set mirrors the untracked working material already excluded by
 * `.railwayignore`, for the same underlying reason: these paths hold copies of the
 * repo, not the repo.
 */
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".claude",
  ".impeccable",
  ".rollout-audit-backups",
  ".superpowers",
  ".worktrees",
  "coverage",
  "dist",
  "node_modules",
]);
const EXECUTABLE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const HANDLER_PATH = "src/handlers/messageHandler.ts";
const SENDER_PATH = "src/services/sequenceSender.ts";
const DETECTOR_PATH = "scripts/check-guide-delivery-bypasses.mjs";
const EXPECTED_SENDER_MODULE = "../services/sequenceSender.js";
const SENDER_EXPORT = "sendSequence";
const OWNER_HELPER = "deliverOwnedGuide";

// Invariant: any executable AST expression that statically identifies the legacy
// sequenceSender module is forbidden, independent of the API that consumes it.
// Static evaluation covers literals, primitive templates/concatenation, and lexical
// const aliases. Runtime-generated values are outside that proof; unresolved string
// constructions still fail closed when their known fragments collapse to the sender.

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
      if (/\.(?:spec|test)\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) continue;
      files.push(path.join(directory, entry.name));
    }
  };
  visit(root);
  return files;
}

function normalizedRelativePath(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function scriptKind(file) {
  const extension = path.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  return [".ts", ".mts", ".cts"].includes(extension) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function checkerForSource(sourceFile) {
  const options = {
    allowJs: true,
    allowNonTsExtensions: true,
    module: ts.ModuleKind.NodeNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const sameFile = (file) => path.resolve(file) === path.resolve(sourceFile.fileName);
  const host = {
    fileExists: sameFile,
    readFile: (file) => (sameFile(file) ? sourceFile.text : undefined),
    getSourceFile: (file) => (sameFile(file) ? sourceFile : undefined),
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => path.dirname(sourceFile.fileName),
    getDirectories: () => [],
    getCanonicalFileName: (file) => file,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  return ts.createProgram([sourceFile.fileName], options, host).getTypeChecker();
}

function isRuntimeDeclaration(declaration) {
  let current = declaration;
  while (current && !ts.isSourceFile(current)) {
    if (current.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
      return false;
    }
    current = current.parent;
  }
  return !current?.isDeclarationFile;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function constantBinding(identifier, checker, resolving) {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol || resolving.has(symbol)) return null;
  const declarations = (symbol.declarations ?? []).filter(isRuntimeDeclaration);
  if (declarations.length !== 1) return null;
  const declaration = declarations[0];
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  const nextResolving = new Set(resolving);
  nextResolving.add(symbol);
  return { initializer: declaration.initializer, resolving: nextResolving };
}

function staticPrimitive(node, checker, resolving = new Set()) {
  const expression = unwrapExpression(node);
  if (!expression) return null;
  if (ts.isStringLiteralLike(expression)) return { value: expression.text };
  if (ts.isNumericLiteral(expression)) return { value: Number(expression.text) };
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  if (expression.kind === ts.SyntaxKind.NullKeyword) return { value: null };

  if (ts.isIdentifier(expression)) {
    const binding = constantBinding(expression, checker, resolving);
    return binding
      ? staticPrimitive(binding.initializer, checker, binding.resolving)
      : null;
  }

  if (
    ts.isPrefixUnaryExpression(expression) &&
    (expression.operator === ts.SyntaxKind.PlusToken ||
      expression.operator === ts.SyntaxKind.MinusToken)
  ) {
    const operand = staticPrimitive(expression.operand, checker, resolving);
    if (!operand || typeof operand.value !== "number") return null;
    return {
      value:
        expression.operator === ts.SyntaxKind.MinusToken
          ? -operand.value
          : operand.value,
    };
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticPrimitive(expression.left, checker, resolving);
    const right = staticPrimitive(expression.right, checker, resolving);
    if (!left || !right) return null;
    if (typeof left.value === "string" || typeof right.value === "string") {
      return { value: String(left.value) + String(right.value) };
    }
    if (typeof left.value === "number" && typeof right.value === "number") {
      return { value: left.value + right.value };
    }
    return null;
  }

  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const part = staticPrimitive(span.expression, checker, resolving);
      if (!part) return null;
      value += String(part.value) + span.literal.text;
    }
    return { value };
  }
  return null;
}

function staticString(node, checker) {
  const primitive = staticPrimitive(node, checker);
  return primitive && typeof primitive.value === "string" ? primitive.value : null;
}

function staticFragments(node, checker, resolving = new Set()) {
  const exact = staticPrimitive(node, checker, resolving);
  if (exact) return { ambiguous: false, pieces: [String(exact.value)] };

  const expression = unwrapExpression(node);
  if (!expression) return null;
  if (ts.isIdentifier(expression)) {
    const binding = constantBinding(expression, checker, resolving);
    return binding
      ? staticFragments(binding.initializer, checker, binding.resolving)
      : null;
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticFragments(expression.left, checker, resolving) ?? {
      ambiguous: true,
      pieces: [],
    };
    const right = staticFragments(expression.right, checker, resolving) ?? {
      ambiguous: true,
      pieces: [],
    };
    return {
      ambiguous: left.ambiguous || right.ambiguous,
      pieces: [...left.pieces, ...right.pieces],
    };
  }

  if (ts.isTemplateExpression(expression)) {
    const result = { ambiguous: false, pieces: [expression.head.text] };
    for (const span of expression.templateSpans) {
      const part = staticFragments(span.expression, checker, resolving);
      if (part) {
        result.ambiguous ||= part.ambiguous;
        result.pieces.push(...part.pieces);
      } else {
        result.ambiguous = true;
      }
      result.pieces.push(span.literal.text);
    }
    return result;
  }
  return null;
}

function decodePercentEncoding(value) {
  let decoded = value;
  while (true) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return decoded;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
}

function canonicalSpecifier(value) {
  const decoded = decodePercentEncoding(value);
  const withoutSuffix = decoded.replace(/[?#].*$/, "");
  return path.posix.normalize(withoutSuffix.replaceAll("\\", "/"));
}

function withoutSenderRuntimeExtension(value) {
  const extension = path.posix.extname(value).toLowerCase();
  if (extension === ".js" || extension === ".ts") {
    return value.slice(0, -extension.length);
  }
  return extension === "" ? value : null;
}

function isSenderReference(value, sourceFile, root) {
  const canonical = canonicalSpecifier(value);
  const resolved = path.resolve(path.dirname(sourceFile.fileName), canonical);
  const targetStem = withoutSenderRuntimeExtension(
    path.resolve(root, SENDER_PATH).replaceAll("\\", "/").toLowerCase(),
  );
  const resolvedStem = withoutSenderRuntimeExtension(
    resolved.replaceAll("\\", "/").toLowerCase(),
  );
  if (resolvedStem !== null && resolvedStem === targetStem) return true;

  const basenameStem = withoutSenderRuntimeExtension(
    path.posix.basename(canonical).toLowerCase(),
  );
  return basenameStem === "sequencesender";
}

function exactSenderImport(node) {
  if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return null;
  if (node.moduleSpecifier.text !== EXPECTED_SENDER_MODULE) return null;
  const clause = node.importClause;
  if (
    !clause ||
    clause.isTypeOnly ||
    clause.name ||
    !clause.namedBindings ||
    !ts.isNamedImports(clause.namedBindings) ||
    clause.namedBindings.elements.length !== 1
  ) {
    return null;
  }
  const specifier = clause.namedBindings.elements[0];
  if (
    specifier.isTypeOnly ||
    specifier.propertyName ||
    specifier.name.text !== SENDER_EXPORT
  ) {
    return null;
  }
  return specifier.name;
}

function exactSenderImportSource(node, relative) {
  return (
    relative === HANDLER_PATH &&
    ts.isStringLiteral(node) &&
    ts.isImportDeclaration(node.parent) &&
    node.parent.moduleSpecifier === node &&
    exactSenderImport(node.parent) !== null
  );
}

function insideLegacyOwnerHelper(node, sourceFile) {
  let current = node.parent;
  let insideLegacyCase = false;
  while (current && current !== sourceFile) {
    if (
      ts.isCaseClause(current) &&
      ts.isStringLiteral(current.expression) &&
      current.expression.text === "legacy"
    ) {
      insideLegacyCase = true;
    }
    if (ts.isFunctionLike(current)) {
      return (
        insideLegacyCase &&
        ts.isFunctionDeclaration(current) &&
        current.name?.text === OWNER_HELPER
      );
    }
    current = current.parent;
  }
  return false;
}

function exactSenderCall(node, sourceFile) {
  return (
    ts.isCallExpression(node) &&
    !node.questionDotToken &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === SENDER_EXPORT &&
    insideLegacyOwnerHelper(node, sourceFile)
  );
}

function exactSenderDefinition(node) {
  return (
    ts.isFunctionDeclaration(node) &&
    node.name?.text === SENDER_EXPORT &&
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

function computedName(node, checker) {
  if (ts.isElementAccessExpression(node)) {
    return staticString(node.argumentExpression, checker);
  }
  if (ts.isComputedPropertyName(node)) {
    return staticString(node.expression, checker);
  }
  return null;
}

function inspectSource(root, relative, sourceFile, checker) {
  const findings = new Set();
  const permittedIdentifiers = new Set();
  let permittedImportCount = 0;
  let permittedCallCount = 0;
  let permittedDefinitionCount = 0;
  const report = (message) => findings.add(`${relative}: ${message}`);
  const lineFor = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node) => {
    if (relative === HANDLER_PATH && ts.isImportDeclaration(node)) {
      const importedIdentifier = exactSenderImport(node);
      if (importedIdentifier) {
        permittedImportCount += 1;
        permittedIdentifiers.add(importedIdentifier);
      }
    }

    const value = staticString(node, checker);
    if (value !== null && isSenderReference(value, sourceFile, root)) {
      if (!exactSenderImportSource(node, relative)) {
        report(`legacy sequenceSender module reference at line ${lineFor(node)}`);
      }
    } else if (value === null) {
      const fragments = staticFragments(node, checker);
      if (
        fragments?.ambiguous &&
        fragments.pieces.length > 0 &&
        isSenderReference(fragments.pieces.join(""), sourceFile, root)
      ) {
        report(`ambiguous legacy sequenceSender construction at line ${lineFor(node)}`);
      }
    }

    if (relative === HANDLER_PATH && exactSenderCall(node, sourceFile)) {
      permittedCallCount += 1;
      permittedIdentifiers.add(node.expression);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === SENDER_EXPORT
    ) {
      report("legacy sender call outside the permitted owner branch");
    }

    if (relative === SENDER_PATH && exactSenderDefinition(node)) {
      permittedDefinitionCount += 1;
      permittedIdentifiers.add(node.name);
    }

    if (
      ts.isIdentifier(node) &&
      node.text === SENDER_EXPORT &&
      !permittedIdentifiers.has(node)
    ) {
      report("legacy sender identifier used outside its permitted shape");
    }

    const name = computedName(node, checker);
    if (name === SENDER_EXPORT) {
      report("computed legacy sender member reference");
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (relative === HANDLER_PATH) {
    if (permittedImportCount !== 1) {
      report(`expected one exact static legacy import, found ${permittedImportCount}`);
    }
    if (permittedCallCount !== 1) {
      report(`expected one direct legacy owner-branch call, found ${permittedCallCount}`);
    }
  }
  if (relative === SENDER_PATH && permittedDefinitionCount !== 1) {
    report(`expected one exported legacy sender definition, found ${permittedDefinitionCount}`);
  }

  return findings;
}

function bypasses(root) {
  const findings = new Set();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (const file of executableFiles(root)) {
    const relative = normalizedRelativePath(root, file);
    if (relative === DETECTOR_PATH) continue;

    let source;
    try {
      source = decoder.decode(readFileSync(file));
    } catch {
      findings.add(`${relative}: read failed`);
      continue;
    }

    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );
    if (sourceFile.parseDiagnostics.length > 0) {
      findings.add(`${relative}: parse failed`);
      continue;
    }
    const checker = checkerForSource(sourceFile);
    for (const finding of inspectSource(root, relative, sourceFile, checker)) {
      findings.add(finding);
    }
  }
  return [...findings].sort();
}

try {
  const root = repositoryRoot(process.argv.slice(2));
  const findings = bypasses(root);
  if (findings.length > 0) {
    console.error("guide_delivery_bypass_detected");
    for (const finding of findings) console.error(finding);
    process.exitCode = 1;
  } else {
    console.log("guide_delivery_bypass_check_passed");
  }
} catch {
  console.error("guide_delivery_bypass_scan_failed");
  process.exitCode = 1;
}
