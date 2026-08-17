import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".superpowers",
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

function bindingState(identifier, checker) {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return "unbound";
  const declarations = (symbol.declarations ?? []).filter(isRuntimeDeclaration);
  if (declarations.length === 0) return "unbound";
  return declarations.length === 1 ? "bound" : "ambiguous";
}

function staticString(node, checker, resolving = new Set()) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression, checker, resolving);
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return staticString(node.expression, checker, resolving);
  }
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
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
    return staticString(declaration.initializer, checker, nextResolving);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(node.left, checker, resolving);
    const right = staticString(node.right, checker, resolving);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticString(span.expression, checker, resolving);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  return null;
}

function isSenderModule(value) {
  if (value === null) return false;
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  return /(?:^|\/)sequencesender(?:\.(?:js|ts))?$/.test(normalized);
}

function moduleReference(node, checker) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier
      ? { loader: "static", value: staticString(node.moduleSpecifier, checker) }
      : null;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    const expression = node.moduleReference.expression;
    return { loader: "static", value: staticString(expression, checker) };
  }
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return null;
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const requireState =
    ts.isIdentifier(node.expression) && node.expression.text === "require"
      ? bindingState(node.expression, checker)
      : "bound";
  const isRequire = requireState === "unbound";
  if (requireState === "ambiguous") {
    return { loader: "ambiguous", value: null };
  }
  if (!isDynamicImport && !isRequire) return null;
  return {
    loader: isDynamicImport ? "dynamic import" : "require",
    value: staticString(node.arguments[0], checker),
  };
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

function inspectSource(relative, sourceFile, checker) {
  const findings = new Set();
  const permittedIdentifiers = new Set();
  let permittedImportCount = 0;
  let permittedCallCount = 0;
  let permittedDefinitionCount = 0;
  const report = (message) => findings.add(`${relative}: ${message}`);

  const visit = (node) => {
    const reference = moduleReference(node, checker);
    if (reference && reference.loader !== "static" && reference.value === null) {
      report(`${reference.loader} module path is not statically resolvable`);
    } else if (reference && isSenderModule(reference.value)) {
      const importedIdentifier = relative === HANDLER_PATH ? exactSenderImport(node) : null;
      if (importedIdentifier) {
        permittedImportCount += 1;
        permittedIdentifiers.add(importedIdentifier);
      } else {
        report("legacy sequenceSender module reference outside the permitted static import");
      }
    }

    if (
      ts.isIdentifier(node) &&
      node.text === "require" &&
      bindingState(node, checker) !== "bound" &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      report("CommonJS loader alias or wrapper is not permitted");
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
    for (const finding of inspectSource(relative, sourceFile, checker)) findings.add(finding);
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
