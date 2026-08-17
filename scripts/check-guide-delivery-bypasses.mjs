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

function valueSymbol(identifier, checker) {
  if (
    ts.isShorthandPropertyAssignment(identifier.parent) &&
    identifier.parent.name === identifier
  ) {
    return checker.getShorthandAssignmentValueSymbol(identifier.parent);
  }
  return checker.getSymbolAtLocation(identifier);
}

function bindingState(identifier, checker) {
  const symbol = valueSymbol(identifier, checker);
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
  const normalized = value
    .replace(/[?#].*$/, "")
    .replaceAll("\\", "/")
    .toLowerCase();
  return /(?:^|\/)sequencesender(?:\.(?:js|ts))?$/.test(normalized);
}

function isNodeModule(value) {
  return value === "node:module" || value === "module";
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

function importDeclarationFor(node) {
  let current = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isImportDeclaration(current)) return current;
    current = current.parent;
  }
  return null;
}

function propertyName(node, checker) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return staticString(node.expression, checker);
  return null;
}

function combinedProvenance(values) {
  const meaningful = new Set(values.filter((value) => value !== "none"));
  if (meaningful.size === 0) return "none";
  if (meaningful.size === 1) return [...meaningful][0];
  return "ambiguous";
}

function declarationProvenance(declaration, checker, resolving) {
  if (ts.isVariableDeclaration(declaration)) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return "none";
    return loaderProvenance(declaration.initializer, checker, resolving);
  }
  if (ts.isImportSpecifier(declaration)) {
    const importedName = (declaration.propertyName ?? declaration.name).text;
    const importDeclaration = importDeclarationFor(declaration);
    const moduleName = importDeclaration
      ? staticString(importDeclaration.moduleSpecifier, checker)
      : null;
    return importedName === "createRequire" && isNodeModule(moduleName)
      ? "factory"
      : "none";
  }
  if (ts.isNamespaceImport(declaration)) {
    const importDeclaration = importDeclarationFor(declaration);
    const moduleName = importDeclaration
      ? staticString(importDeclaration.moduleSpecifier, checker)
      : null;
    return isNodeModule(moduleName) ? "namespace" : "none";
  }
  if (ts.isBindingElement(declaration)) {
    const pattern = declaration.parent;
    const variableDeclaration = pattern.parent;
    if (
      !ts.isObjectBindingPattern(pattern) ||
      !ts.isVariableDeclaration(variableDeclaration) ||
      !variableDeclaration.initializer
    ) {
      return "none";
    }
    const selectedName = propertyName(declaration.propertyName ?? declaration.name, checker);
    if (selectedName === null) return "ambiguous";
    return objectPropertyProvenance(
      variableDeclaration.initializer,
      selectedName,
      checker,
      resolving,
    );
  }
  return "none";
}

function symbolProvenance(symbol, checker, resolving) {
  if (resolving.has(symbol)) return "ambiguous";
  const declarations = (symbol.declarations ?? []).filter(isRuntimeDeclaration);
  if (declarations.length === 0) return "none";
  const nextResolving = new Set(resolving);
  nextResolving.add(symbol);
  return combinedProvenance(
    declarations.map((declaration) =>
      declarationProvenance(declaration, checker, nextResolving),
    ),
  );
}

function objectPropertyProvenance(node, selectedName, checker, resolving) {
  const expression = unwrapExpression(node);
  if (!expression) return "ambiguous";

  const receiverProvenance = loaderProvenance(expression, checker, resolving);
  if (receiverProvenance === "ambiguous") return "ambiguous";
  if (receiverProvenance === "namespace") {
    return selectedName === "createRequire" ? "factory" : "none";
  }

  if (ts.isIdentifier(expression)) {
    const symbol = valueSymbol(expression, checker);
    if (!symbol || resolving.has(symbol)) return symbol ? "ambiguous" : "none";
    const declarations = (symbol.declarations ?? []).filter(isRuntimeDeclaration);
    if (declarations.length === 0) return "none";
    const nextResolving = new Set(resolving);
    nextResolving.add(symbol);
    return combinedProvenance(
      declarations.map((declaration) => {
        if (
          ts.isVariableDeclaration(declaration) &&
          ts.isIdentifier(declaration.name) &&
          declaration.initializer
        ) {
          return objectPropertyProvenance(
            declaration.initializer,
            selectedName,
            checker,
            nextResolving,
          );
        }
        return declarationProvenance(declaration, checker, nextResolving) === "namespace"
          ? selectedName === "createRequire"
            ? "factory"
            : "none"
          : "none";
      }),
    );
  }

  if (!ts.isObjectLiteralExpression(expression)) return "none";
  const matches = [];
  let ambiguous = false;
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      ambiguous = true;
      continue;
    }
    const candidateName = propertyName(property.name, checker);
    if (candidateName === null) {
      ambiguous = true;
      continue;
    }
    if (candidateName !== selectedName) continue;
    if (ts.isShorthandPropertyAssignment(property)) {
      matches.push(loaderProvenance(property.name, checker, resolving));
    } else if (ts.isPropertyAssignment(property)) {
      matches.push(loaderProvenance(property.initializer, checker, resolving));
    } else {
      matches.push("ambiguous");
    }
  }
  if (ambiguous || matches.length !== 1) return matches.length === 0 && !ambiguous
    ? "none"
    : "ambiguous";
  return matches[0];
}

function unknownObjectMemberProvenance(node, checker, resolving) {
  const expression = unwrapExpression(node);
  if (!expression) return "ambiguous";
  const directProvenance = loaderProvenance(expression, checker, resolving);
  if (directProvenance !== "none") return "ambiguous";

  if (ts.isIdentifier(expression)) {
    const symbol = valueSymbol(expression, checker);
    if (!symbol || resolving.has(symbol)) return symbol ? "ambiguous" : "none";
    const declarations = (symbol.declarations ?? []).filter(isRuntimeDeclaration);
    if (declarations.length === 0) return "none";
    const nextResolving = new Set(resolving);
    nextResolving.add(symbol);
    return combinedProvenance(
      declarations.map((declaration) => {
        if (
          ts.isVariableDeclaration(declaration) &&
          ts.isIdentifier(declaration.name) &&
          declaration.initializer
        ) {
          return unknownObjectMemberProvenance(
            declaration.initializer,
            checker,
            nextResolving,
          );
        }
        return "none";
      }),
    );
  }

  if (!ts.isObjectLiteralExpression(expression)) return "none";
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) return "ambiguous";
    const value = ts.isShorthandPropertyAssignment(property)
      ? property.name
      : ts.isPropertyAssignment(property)
        ? property.initializer
        : null;
    if (value && loaderProvenance(value, checker, resolving) !== "none") {
      return "ambiguous";
    }
    if (!value) return "ambiguous";
  }
  return "none";
}

function loaderProvenance(node, checker, resolving = new Set()) {
  const expression = unwrapExpression(node);
  if (!expression) return "ambiguous";
  if (expression.kind === ts.SyntaxKind.ImportKeyword) return "loader";

  if (ts.isIdentifier(expression)) {
    const symbol = valueSymbol(expression, checker);
    const declarations = (symbol?.declarations ?? []).filter(isRuntimeDeclaration);
    if (declarations.length === 0) {
      return expression.text === "require" ? "loader" : "none";
    }
    return symbolProvenance(symbol, checker, resolving);
  }

  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const selectedName = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : staticString(expression.argumentExpression, checker);
    if (selectedName === null) {
      return unknownObjectMemberProvenance(expression.expression, checker, resolving);
    }
    return objectPropertyProvenance(expression.expression, selectedName, checker, resolving);
  }

  if (ts.isCallExpression(expression)) {
    const calleeProvenance = loaderProvenance(expression.expression, checker, resolving);
    if (calleeProvenance === "ambiguous") return "ambiguous";
    if (calleeProvenance === "factory") return "loader";
    if (calleeProvenance !== "loader" || expression.arguments.length === 0) return "none";
    const moduleName = staticString(expression.arguments[0], checker);
    return isNodeModule(moduleName) ? "namespace" : "none";
  }

  return "none";
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
  const provenance = loaderProvenance(node.expression, checker);
  if (provenance === "ambiguous") {
    return { loader: "ambiguous", value: null };
  }
  if (provenance !== "loader") return null;
  return {
    loader:
      node.expression.kind === ts.SyntaxKind.ImportKeyword
        ? "dynamic import"
        : "runtime loader",
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
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      report(`${reference.loader} module path is not statically resolvable at line ${line + 1}`);
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
