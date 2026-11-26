import {
  existsSyncPath,
  join,
  readDirSyncNames,
  relative,
  resolve,
  statSyncPath,
} from "@bunest/core";
import {
  Node,
  Project,
  SyntaxKind,
  type BunestArrayTypeNode,
  type BunestTypeReferenceNode,
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type MethodDeclaration,
  type ParameterDeclaration,
  type PropertyDeclaration,
  type SourceFile,
} from "../ast";

// ============================================================================
// Public Types
// ============================================================================

export interface BodyFieldConstraints {
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
}

export interface BodyFieldContract {
  readonly name: string;
  readonly tsType: string;
  readonly tsOptional: boolean;
  readonly isOptional: boolean;
  readonly constraints: BodyFieldConstraints;
  readonly validators: readonly string[];
  readonly sourceFile: string;
  readonly line: number;
}

export type BodyUnsupportedReasonKind =
  | "custom-validator"
  | "validation-groups"
  | "transform"
  | "mapped-type"
  | "nested-dto"
  | "non-literal-arg"
  | "dynamic-pipe"
  | "unresolvable-dto";

export interface BodyUnsupportedReason {
  readonly kind: BodyUnsupportedReasonKind;
  readonly field?: string;
  readonly reason: string;
  readonly sourceFile?: string;
  readonly line?: number;
}

export interface RouteBodyLocation {
  readonly file: string;
  readonly line: number;
  readonly endLine?: number;
}

export interface RouteBodyContract {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly version?: string;
  readonly controllerName: string;
  readonly handlerName: string;
  readonly routeSourceFile: string;
  readonly routeLine: number;
  readonly dtoName: string;
  readonly dtoSourceFile?: string;
  readonly dtoLine?: number;
  readonly dtoLocation?: RouteBodyLocation;
  readonly fields: readonly BodyFieldContract[];
  readonly unsupportedReasons: readonly BodyUnsupportedReason[];
}

export interface ScanBodyContractsOptions {
  readonly sourceRoot?: string;
}

export interface ScanBodyContractsResult {
  readonly projectDir: string;
  readonly sourceRoot: string;
  readonly routes: readonly RouteBodyContract[];
  readonly scannedFiles: number;
}

// ============================================================================
// Constants
// ============================================================================

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".bunest",
  "coverage",
  ".cache",
  ".turbo",
]);

const HTTP_METHOD_DECORATORS: Readonly<Record<string, string>> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
};

const TRUSTED_VALIDATION_MODULES = new Set([
  "@bunest/validation",
  "@bunest/validation/validator",
  "class-validator",
]);

const TRUSTED_TRANSFORM_MODULES = new Set([
  "@bunest/validation",
  "@bunest/validation/transformer",
  "class-transformer",
]);

const BUILTIN_VALIDATION_DECORATORS = new Set([
  "Min",
  "Max",
  "MinLength",
  "MaxLength",
  "IsOptional",
  "IsString",
  "IsNumber",
  "IsInt",
  "IsBoolean",
  "IsEmail",
  "IsDefined",
  "IsNotEmpty",
]);

const TRANSFORM_DECORATORS = new Set([
  "Transform",
  "Type",
  "Expose",
  "Exclude",
]);

const MAPPED_TYPE_HELPERS = new Set([
  "PartialType",
  "PickType",
  "OmitType",
  "IntersectionType",
]);

const TS_MAPPED_UTILITY_TYPES = new Set([
  "Partial",
  "Pick",
  "Omit",
  "Required",
  "Readonly",
  "Record",
]);

const PRIMITIVE_OR_BUILTIN_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "undefined",
  "null",
  "void",
  "never",
  "any",
  "unknown",
  "object",
  "Date",
  "RegExp",
  "Array",
  "ReadonlyArray",
  "Set",
  "Map",
  "Buffer",
  "Uint8Array",
]);

// ============================================================================
// File & Path Helpers
// ============================================================================

function isSourceTsFile(filePath: string): boolean {
  if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) return false;
  if (filePath.endsWith(".d.ts")) return false;
  if (/\.(?:spec|test)\.tsx?$/i.test(filePath)) return false;
  return true;
}

function walkTsSourceFiles(dir: string): string[] {
  if (!existsSyncPath(dir)) return [];
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readDirSyncNames(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSyncPath(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...walkTsSourceFiles(full));
    } else if (stat.isFile() && isSourceTsFile(full)) {
      results.push(full);
    }
  }
  return results.sort();
}

function toRelativePosixPath(projectRoot: string, filePath: string): string {
  return relative(projectRoot, filePath).replace(/\\/g, "/");
}

function getNodeLine(node: Node): number {
  return node.getSourceFile().getLineAndColumnAtPos(node.getStart()).line;
}

function getNodeEndLine(node: Node): number {
  return node.getSourceFile().getLineAndColumnAtPos(node.getEnd()).line;
}

function joinRoutePath(prefix: string, routePath: string): string {
  const parts = [prefix, routePath]
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

// ============================================================================
// AST Expression Helpers
// ============================================================================

function unwrapParensAndAs(expr: Expression | undefined): Expression | undefined {
  let current = expr;
  while (current) {
    if (Node.isParenthesizedExpression(current)) {
      current = current.getExpression();
    } else if (Node.isAsExpression(current)) {
      current = current.getExpression();
    } else if (Node.isSatisfiesExpression(current)) {
      current = current.getExpression();
    } else {
      break;
    }
  }
  return current;
}

function extractStringLiteral(expr: Expression | undefined): string | undefined {
  const unwrapped = unwrapParensAndAs(expr);
  if (!unwrapped) return undefined;
  if (
    Node.isStringLiteral(unwrapped) ||
    Node.isNoSubstitutionTemplateLiteral(unwrapped)
  ) {
    return unwrapped.getLiteralValue();
  }
  return undefined;
}

function extractStringOrArrayLiterals(expr: Expression | undefined): string[] {
  const unwrapped = unwrapParensAndAs(expr);
  if (!unwrapped) return [];
  const single = extractStringLiteral(unwrapped);
  if (single !== undefined) return [single];
  if (Node.isArrayLiteralExpression(unwrapped)) {
    const out: string[] = [];
    for (const el of unwrapped.getElements()) {
      if (Node.isExpression(el)) {
        const s = extractStringLiteral(el);
        if (s !== undefined) out.push(s);
      }
    }
    return out;
  }
  return [];
}

function extractNumericLiteral(expr: Expression | undefined): number | undefined {
  const unwrapped = unwrapParensAndAs(expr);
  if (!unwrapped) return undefined;
  if (Node.isNumericLiteral(unwrapped)) {
    const val = unwrapped.getLiteralValue();
    return Number.isFinite(val) ? val : undefined;
  }
  if (unwrapped.getKind() === SyntaxKind.PrefixUnaryExpression) {
    const rawText = unwrapped.getText().trim();
    const operand = unwrapped.getChildren()[0];
    if (operand && Node.isNumericLiteral(operand)) {
      const base = operand.getLiteralValue();
      if (!Number.isFinite(base)) return undefined;
      if (rawText.startsWith("-")) return -base;
      if (rawText.startsWith("+")) return base;
    }
  }
  return undefined;
}

function isStaticLiteralValue(expr: Expression | undefined): boolean {
  const unwrapped = unwrapParensAndAs(expr);
  if (!unwrapped) return false;
  if (
    Node.isStringLiteral(unwrapped) ||
    Node.isNoSubstitutionTemplateLiteral(unwrapped) ||
    Node.isNumericLiteral(unwrapped)
  ) {
    return true;
  }
  const kind = unwrapped.getKind();
  if (
    kind === SyntaxKind.TrueKeyword ||
    kind === SyntaxKind.FalseKeyword ||
    kind === SyntaxKind.NullKeyword ||
    kind === SyntaxKind.UndefinedKeyword
  ) {
    return true;
  }
  if (kind === SyntaxKind.PrefixUnaryExpression) {
    return extractNumericLiteral(unwrapped) !== undefined;
  }
  if (Node.isArrayLiteralExpression(unwrapped)) {
    return unwrapped
      .getElements()
      .every((el) => Node.isExpression(el) && isStaticLiteralValue(el));
  }
  if (Node.isObjectLiteralExpression(unwrapped)) {
    return unwrapped.getProperties().every((prop) => {
      if (!Node.isPropertyAssignment(prop)) return false;
      return isStaticLiteralValue(prop.getInitializer());
    });
  }
  return false;
}

function getPropertyInitializer(
  obj: Expression | undefined,
  propName: string,
): Expression | undefined {
  const unwrapped = unwrapParensAndAs(obj);
  if (!unwrapped || !Node.isObjectLiteralExpression(unwrapped)) {
    return undefined;
  }
  const prop = unwrapped.getProperty(propName);
  if (prop && Node.isPropertyAssignment(prop)) {
    return prop.getInitializer();
  }
  if (prop && Node.isShorthandPropertyAssignment(prop)) {
    return prop.getNameNode();
  }
  return undefined;
}

function getDecoratorShortName(dec: Decorator): string {
  const name = dec.getName();
  const dotIdx = name.lastIndexOf(".");
  return dotIdx !== -1 ? name.slice(dotIdx + 1) : name;
}

// ============================================================================
// Import Origin Tracking
// ============================================================================

interface ImportBinding {
  readonly moduleSpecifier: string;
  readonly importedName: string;
  readonly isNamespace: boolean;
}

function buildImportMap(sf: SourceFile): Map<string, ImportBinding> {
  const map = new Map<string, ImportBinding>();
  for (const imp of sf.getImportDeclarations()) {
    const moduleSpecifier = imp.getModuleSpecifierValue();
    const defImp = imp.getDefaultImport();
    if (defImp) {
      map.set(defImp.getText(), {
        moduleSpecifier,
        importedName: "default",
        isNamespace: false,
      });
    }
    const nsImp = imp.getNamespaceImport();
    if (nsImp) {
      map.set(nsImp.getText(), {
        moduleSpecifier,
        importedName: "*",
        isNamespace: true,
      });
    }
    for (const named of imp.getNamedImports()) {
      const localName = named.getAliasNode()?.getText() ?? named.getName();
      map.set(localName, {
        moduleSpecifier,
        importedName: named.getName(),
        isNamespace: false,
      });
    }
  }
  return map;
}

interface ResolvedDecoratorOrigin {
  readonly localName: string;
  readonly canonicalName: string;
  readonly moduleSpecifier?: string;
}

/**
 * Resolves a decorator's import origin, including aliased named imports
 * (`import { Min as MinVal } from "@bunest/validation/validator"`) and
 * namespace imports (`import * as V from "@bunest/validation/validator"` -> `@V.Min(1)`).
 * Also follows pure relative re-exports (`export { Min } from "@bunest/validation/validator"`),
 * while ensuring local/3rd-party re-implementations never match trusted modules.
 */
function resolveDecoratorOrigin(
  dec: Decorator,
  sf: SourceFile,
  importMap: ReadonlyMap<string, ImportBinding>,
  project: Project,
): ResolvedDecoratorOrigin {
  const expr = dec.getExpression();
  const target = Node.isCallExpression(expr) ? expr.getExpression() : expr;

  if (Node.isPropertyAccessExpression(target)) {
    const base = target.getExpression();
    const propName = target.getName();
    if (Node.isIdentifier(base)) {
      const nsBinding = importMap.get(base.getText());
      if (nsBinding && nsBinding.isNamespace) {
        return resolveReExportedOrigin(
          `${base.getText()}.${propName}`,
          propName,
          nsBinding.moduleSpecifier,
          sf,
          project,
          new Set(),
        );
      }
    }
    return {
      localName: target.getText(),
      canonicalName: propName,
    };
  }

  const localName = target.getText();
  const binding = importMap.get(localName);
  if (!binding) {
    return {
      localName,
      canonicalName: localName,
    };
  }

  return resolveReExportedOrigin(
    localName,
    binding.importedName,
    binding.moduleSpecifier,
    sf,
    project,
    new Set(),
  );
}

function resolveReExportedOrigin(
  localName: string,
  importedName: string,
  moduleSpecifier: string,
  fromSf: SourceFile,
  project: Project,
  visited: Set<string>,
): ResolvedDecoratorOrigin {
  // Bare package specifiers terminate immediately
  if (!moduleSpecifier.startsWith(".") && !moduleSpecifier.startsWith("/")) {
    return {
      localName,
      canonicalName: importedName,
      moduleSpecifier,
    };
  }

  const resolvedPath = project.resolveModulePath(
    fromSf.getFilePath(),
    moduleSpecifier,
  );
  if (!resolvedPath || visited.has(resolvedPath)) {
    return {
      localName,
      canonicalName: importedName,
      moduleSpecifier,
    };
  }
  visited.add(resolvedPath);

  const targetSf =
    project.getSourceFile(resolvedPath) ??
    project.addSourceFileAtPathIfExists(resolvedPath);
  if (!targetSf) {
    return {
      localName,
      canonicalName: importedName,
      moduleSpecifier,
    };
  }

  // Check if targetSf purely re-exports `importedName` from another module
  for (const exp of targetSf.getExportDeclarations()) {
    const expSpec = exp.getModuleSpecifierValue();
    if (!expSpec) continue;
    if (exp.isNamespaceExport()) {
      // Only follow `export * from "<pkg>"` if `importedName` is not locally declared in targetSf
      const hasLocal =
        targetSf.getFunctions().some((f) => f.getName() === importedName) ||
        targetSf.getClasses().some((c) => c.getName() === importedName) ||
        targetSf
          .getVariableDeclarations()
          .some((v) => v.getName() === importedName);
      if (!hasLocal) {
        const candidate = resolveReExportedOrigin(
          localName,
          importedName,
          expSpec,
          targetSf,
          project,
          visited,
        );
        if (
          candidate.moduleSpecifier &&
          (TRUSTED_VALIDATION_MODULES.has(candidate.moduleSpecifier) ||
            TRUSTED_TRANSFORM_MODULES.has(candidate.moduleSpecifier))
        ) {
          return candidate;
        }
      }
    } else {
      for (const spec of exp.getNamedExports()) {
        const exportedAs = spec.getAliasName() ?? spec.getName();
        if (exportedAs === importedName) {
          return resolveReExportedOrigin(
            localName,
            spec.getName(),
            expSpec,
            targetSf,
            project,
            visited,
          );
        }
      }
    }
  }

  // Otherwise, it's defined in this relative module (e.g. `./fake-validator`)
  return {
    localName,
    canonicalName: importedName,
    moduleSpecifier,
  };
}

// ============================================================================
// Controller & Route Extraction
// ============================================================================

interface ControllerRouteInfo {
  readonly prefixes: readonly string[];
  readonly version?: string;
}

function extractVersionDecorator(decorators: readonly Decorator[]): string | undefined {
  const versionDec = decorators.find(
    (d) => getDecoratorShortName(d) === "Version",
  );
  if (!versionDec) return undefined;
  const arg = versionDec.getArguments()[0] as Expression | undefined;
  const values = extractStringOrArrayLiterals(arg);
  return values[0];
}

function extractControllerInfo(cls: ClassDeclaration): ControllerRouteInfo | undefined {
  const dec = cls
    .getDecorators()
    .find((d) => getDecoratorShortName(d) === "Controller");
  if (!dec) return undefined;

  const classVersion = extractVersionDecorator(cls.getDecorators());
  const firstArg = unwrapParensAndAs(
    dec.getArguments()[0] as Expression | undefined,
  );
  if (!firstArg) {
    return { prefixes: [""], version: classVersion };
  }
  const direct = extractStringOrArrayLiterals(firstArg);
  if (direct.length > 0) {
    return { prefixes: direct, version: classVersion };
  }
  if (Node.isObjectLiteralExpression(firstArg)) {
    const pathInit = getPropertyInitializer(firstArg, "path");
    const objPaths = extractStringOrArrayLiterals(pathInit);
    const versionInit = getPropertyInitializer(firstArg, "version");
    const objVersions = extractStringOrArrayLiterals(versionInit);
    return {
      prefixes: objPaths.length > 0 ? objPaths : [""],
      version: objVersions[0] ?? classVersion,
    };
  }
  return { prefixes: [""], version: classVersion };
}

function extractMethodHttpRoutes(
  method: MethodDeclaration,
): Array<{ readonly httpMethod: string; readonly path: string }> {
  const out: Array<{ readonly httpMethod: string; readonly path: string }> = [];
  for (const dec of method.getDecorators()) {
    const shortName = getDecoratorShortName(dec);
    const httpMethod = HTTP_METHOD_DECORATORS[shortName];
    if (!httpMethod) continue;
    const args = dec.getArguments();
    const paths = extractStringOrArrayLiterals(args[0] as Expression | undefined);
    if (paths.length === 0) {
      out.push({ httpMethod, path: "" });
    } else {
      for (const p of paths) {
        out.push({ httpMethod, path: p });
      }
    }
  }
  return out;
}

// ============================================================================
// Pipe Inspection (Dynamic Pipe & Validation Groups on @UsePipes / @Body)
// ============================================================================

function inspectPipeExpression(
  expr: Expression,
  projectRoot: string,
  reasonsOut: BodyUnsupportedReason[],
): void {
  const unwrapped = unwrapParensAndAs(expr);
  if (!unwrapped) return;

  const sf = unwrapped.getSourceFile();
  const sourceFile = toRelativePosixPath(projectRoot, sf.getFilePath());
  const line = getNodeLine(unwrapped);

  // `new ValidationPipe(...)`
  if (Node.isNewExpression(unwrapped)) {
    const calleeName = unwrapped.getExpression().getText();
    const shortCallee = calleeName.includes(".")
      ? calleeName.slice(calleeName.lastIndexOf(".") + 1)
      : calleeName;

    if (shortCallee === "ValidationPipe") {
      const optArg = unwrapped.getArguments()[0] as Expression | undefined;
      if (!optArg) return;
      const unwrappedOpt = unwrapParensAndAs(optArg);
      if (!unwrappedOpt || !Node.isObjectLiteralExpression(unwrappedOpt)) {
        reasonsOut.push({
          kind: "dynamic-pipe",
          reason: `ValidationPipe uses dynamic options expression (${optArg.getText()})`,
          sourceFile,
          line,
        });
        return;
      }

      const groupsInit = getPropertyInitializer(unwrappedOpt, "groups");
      if (groupsInit) {
        reasonsOut.push({
          kind: "validation-groups",
          reason: `ValidationPipe configures validation groups (${groupsInit.getText()})`,
          sourceFile,
          line,
        });
      }

      if (!isStaticLiteralValue(unwrappedOpt)) {
        reasonsOut.push({
          kind: "dynamic-pipe",
          reason: `ValidationPipe options contain non-literal/dynamic properties`,
          sourceFile,
          line,
        });
      }
      return;
    }

    reasonsOut.push({
      kind: "dynamic-pipe",
      reason: `Custom pipe instance 'new ${calleeName}(...)' requires manual review`,
      sourceFile,
      line,
    });
    return;
  }

  // `ValidationPipe` class reference (static default config)
  if (Node.isIdentifier(unwrapped) && unwrapped.getText() === "ValidationPipe") {
    return;
  }

  // Any other pipe expression (factory call, custom pipe identifier, etc.)
  reasonsOut.push({
    kind: "dynamic-pipe",
    reason: `Dynamic or custom pipe '${unwrapped.getText()}' requires manual review`,
    sourceFile,
    line,
  });
}

function inspectUsePipesDecorators(
  decorators: readonly Decorator[],
  projectRoot: string,
  reasonsOut: BodyUnsupportedReason[],
): void {
  for (const dec of decorators) {
    if (getDecoratorShortName(dec) !== "UsePipes") continue;
    for (const arg of dec.getArguments()) {
      if (Node.isExpression(arg)) {
        inspectPipeExpression(arg, projectRoot, reasonsOut);
      }
    }
  }
}

// ============================================================================
// DTO Resolution
// ============================================================================

type DtoResolutionResult =
  | { readonly ok: true; readonly dtoClass: ClassDeclaration; readonly dtoName: string }
  | { readonly ok: false; readonly dtoName: string; readonly reason: BodyUnsupportedReason };

function resolveTypeNodeToDeclaration(
  typeNode: Node,
  sf: SourceFile,
  project: Project,
  visited = new Set<string>(),
): { readonly decl?: Node; readonly typeName: string; readonly mappedUtility?: string } {
  // Unwrap ParenthesizedType
  if (typeNode.getKind() === SyntaxKind.ParenthesizedType) {
    const inner = typeNode.getChildren()[0];
    if (inner) return resolveTypeNodeToDeclaration(inner, sf, project, visited);
  }

  // Handle UnionType like `CreateOrderDto | undefined`
  if (Node.isUnionTypeNode(typeNode)) {
    const nonNullish = typeNode.getTypeNodes().filter((t) => {
      const text = t.getText().trim();
      return text !== "undefined" && text !== "null";
    });
    if (nonNullish.length === 1 && nonNullish[0]) {
      return resolveTypeNodeToDeclaration(nonNullish[0], sf, project, visited);
    }
    return { typeName: typeNode.getText().trim() };
  }

  if (typeNode.getKind() !== SyntaxKind.TypeReference) {
    return { typeName: typeNode.getText().trim() };
  }

  const refNode = typeNode as BunestTypeReferenceNode;
  const rawTypeName = refNode.getTypeName().getText().trim();

  if (TS_MAPPED_UTILITY_TYPES.has(rawTypeName)) {
    return {
      typeName: typeNode.getText().trim(),
      mappedUtility: rawTypeName,
    };
  }

  // Qualified name e.g. `Dtos.CreateOrderDto`
  if (rawTypeName.includes(".")) {
    const parts = rawTypeName.split(".");
    const nsName = parts[0]!;
    const memberName = parts[parts.length - 1]!;
    const importMap = buildImportMap(sf);
    const nsBinding = importMap.get(nsName);
    if (nsBinding && nsBinding.isNamespace) {
      const targetSf = sf
        .getResolver()
        .resolveModuleSourceFile(sf.getFilePath(), nsBinding.moduleSpecifier);
      if (targetSf) {
        const decl = targetSf.getExportedDeclarations().get(memberName)?.[0];
        if (decl) {
          return unwrapTypeAliasDecl(decl, memberName, project, visited);
        }
      }
    }
    return { typeName: rawTypeName };
  }

  // 1. Local declaration in same file
  const localClass = sf.getClass(rawTypeName);
  if (localClass) {
    return { decl: localClass, typeName: rawTypeName };
  }
  const localTypeAlias = sf
    .getTypeAliases()
    .find((ta) => ta.getName() === rawTypeName);
  if (localTypeAlias) {
    return unwrapTypeAliasDecl(localTypeAlias, rawTypeName, project, visited);
  }
  const localInterface = sf
    .getInterfaces()
    .find((iface) => iface.getName() === rawTypeName);
  if (localInterface) {
    return { decl: localInterface, typeName: rawTypeName };
  }

  // 2. Imported symbol (supports `import { CreateOrderDto as OrderPayload } from "./dto"`)
  const importMap = buildImportMap(sf);
  const binding = importMap.get(rawTypeName);
  if (binding) {
    const targetSf = sf
      .getResolver()
      .resolveModuleSourceFile(sf.getFilePath(), binding.moduleSpecifier);
    if (targetSf) {
      const decl = targetSf
        .getExportedDeclarations()
        .get(binding.importedName)?.[0];
      if (decl) {
        return unwrapTypeAliasDecl(decl, rawTypeName, project, visited);
      }
    }
  }

  return { typeName: rawTypeName };
}

function unwrapTypeAliasDecl(
  decl: Node,
  fallbackName: string,
  project: Project,
  visited: Set<string>,
): { readonly decl?: Node; readonly typeName: string; readonly mappedUtility?: string } {
  if (!Node.isTypeAliasDeclaration(decl)) {
    return { decl, typeName: fallbackName };
  }
  const key = `${decl.getSourceFile().getFilePath()}\0${decl.getName()}`;
  if (visited.has(key)) {
    return { decl, typeName: decl.getName() };
  }
  visited.add(key);
  return resolveTypeNodeToDeclaration(
    decl.getTypeNode(),
    decl.getSourceFile(),
    project,
    visited,
  );
}

function resolveBodyParamDto(
  param: ParameterDeclaration,
  sf: SourceFile,
  project: Project,
  projectRoot: string,
): DtoResolutionResult {
  const sourceFile = toRelativePosixPath(projectRoot, sf.getFilePath());
  const line = getNodeLine(param);
  const typeNode = param.getTypeNode();

  if (!typeNode) {
    return {
      ok: false,
      dtoName: "unknown",
      reason: {
        kind: "unresolvable-dto",
        reason: `@Body() parameter '${param.getName()}' has no TypeScript type annotation`,
        sourceFile,
        line,
      },
    };
  }

  const resolved = resolveTypeNodeToDeclaration(typeNode, sf, project);

  if (resolved.mappedUtility) {
    return {
      ok: false,
      dtoName: resolved.typeName,
      reason: {
        kind: "mapped-type",
        reason: `@Body() type '${resolved.typeName}' uses mapped utility type '${resolved.mappedUtility}'`,
        sourceFile,
        line,
      },
    };
  }

  if (resolved.decl && Node.isClassDeclaration(resolved.decl)) {
    const dtoName = resolved.decl.getName() ?? resolved.typeName;
    return { ok: true, dtoClass: resolved.decl, dtoName };
  }

  return {
    ok: false,
    dtoName: resolved.typeName || typeNode.getText().trim(),
    reason: {
      kind: "unresolvable-dto",
      reason: `@Body() type '${resolved.typeName || typeNode.getText().trim()}' could not be resolved to a DTO class declaration`,
      sourceFile,
      line,
    },
  };
}

// ============================================================================
// DTO Property & Validation Decorator Extraction
// ============================================================================

function checkOptionsForValidationGroups(
  args: readonly Node[],
  fieldName: string,
  sourceFile: string,
  line: number,
  reasonsOut: BodyUnsupportedReason[],
): void {
  for (const arg of args) {
    if (!Node.isExpression(arg)) continue;
    const unwrapped = unwrapParensAndAs(arg);
    if (!unwrapped || !Node.isObjectLiteralExpression(unwrapped)) continue;
    const groupsInit = getPropertyInitializer(unwrapped, "groups");
    if (groupsInit) {
      reasonsOut.push({
        kind: "validation-groups",
        field: fieldName,
        reason: `Field '${fieldName}' uses validation groups (${groupsInit.getText()})`,
        sourceFile,
        line,
      });
      return;
    }
  }
}

function isNestedDtoOrObjectType(
  typeNode: Node | undefined,
  sf: SourceFile,
  project: Project,
): boolean {
  if (!typeNode) return false;

  if (typeNode.getKind() === SyntaxKind.ParenthesizedType) {
    const inner = typeNode.getChildren()[0];
    return isNestedDtoOrObjectType(inner, sf, project);
  }

  if (typeNode.getKind() === SyntaxKind.TypeLiteral) {
    return true;
  }

  if (typeNode.getKind() === SyntaxKind.ArrayType) {
    const elem = (typeNode as BunestArrayTypeNode).getElementTypeNode();
    return isNestedDtoOrObjectType(elem, sf, project);
  }

  if (Node.isUnionTypeNode(typeNode)) {
    return typeNode.getTypeNodes().some((member) => {
      const text = member.getText().trim();
      if (text === "undefined" || text === "null") return false;
      return isNestedDtoOrObjectType(member, sf, project);
    });
  }

  if (typeNode.getKind() === SyntaxKind.TypeReference) {
    const ref = typeNode as BunestTypeReferenceNode;
    const refName = ref.getTypeName().getText().trim();
    if (refName === "Array" || refName === "ReadonlyArray") {
      const elemArg = ref.getTypeArguments()[0];
      return isNestedDtoOrObjectType(elemArg, sf, project);
    }
    if (PRIMITIVE_OR_BUILTIN_TYPES.has(refName)) {
      return false;
    }
    const resolved = resolveTypeNodeToDeclaration(typeNode, sf, project);
    if (resolved.decl && Node.isClassDeclaration(resolved.decl)) {
      return true;
    }
    if (resolved.decl && Node.isInterfaceDeclaration(resolved.decl)) {
      return true;
    }
  }

  return false;
}

function collectClassPropertiesWithInheritance(
  dtoClass: ClassDeclaration,
  projectRoot: string,
  reasonsOut: BodyUnsupportedReason[],
  visited = new Set<ClassDeclaration>(),
): PropertyDeclaration[] {
  if (visited.has(dtoClass)) return [];
  visited.add(dtoClass);

  const byName = new Map<string, PropertyDeclaration>();
  const orderedNames: string[] = [];

  const extendsClause = dtoClass.getExtends();
  if (extendsClause) {
    const extExpr = unwrapParensAndAs(extendsClause.getExpression());
    const sf = dtoClass.getSourceFile();
    const afterExtends = sf
      .getFullText()
      .slice(extendsClause.getEnd())
      .trimStart();
    const isCallSyntaxInExtends =
      (extExpr !== undefined && Node.isCallExpression(extExpr)) ||
      afterExtends.startsWith("(");

    const rawCalleeText = extExpr
      ? Node.isCallExpression(extExpr)
        ? extExpr.getExpression().getText()
        : extExpr.getText()
      : "";
    const shortCallee = rawCalleeText.includes(".")
      ? rawCalleeText.slice(rawCalleeText.lastIndexOf(".") + 1)
      : rawCalleeText;

    // Also check if `shortCallee` is an aliased import of PartialType/PickType/OmitType/IntersectionType
    const importMap = buildImportMap(sf);
    const importedCallee =
      importMap.get(shortCallee)?.importedName ?? shortCallee;

    if (
      isCallSyntaxInExtends ||
      MAPPED_TYPE_HELPERS.has(shortCallee) ||
      MAPPED_TYPE_HELPERS.has(importedCallee)
    ) {
      const sourceFile = toRelativePosixPath(projectRoot, sf.getFilePath());
      const line = getNodeLine(extendsClause);
      const helperName = MAPPED_TYPE_HELPERS.has(importedCallee)
        ? importedCallee
        : shortCallee || rawCalleeText;
      reasonsOut.push({
        kind: "mapped-type",
        reason:
          MAPPED_TYPE_HELPERS.has(shortCallee) ||
          MAPPED_TYPE_HELPERS.has(importedCallee)
            ? `DTO '${dtoClass.getName() ?? "Anonymous"}' extends mapped type helper '${helperName}(...)'`
            : `DTO '${dtoClass.getName() ?? "Anonymous"}' extends dynamic helper '${rawCalleeText}(...)'`,
        sourceFile,
        line,
      });
    } else {
      const baseClass = dtoClass.getBaseClass();
      if (baseClass) {
        const inherited = collectClassPropertiesWithInheritance(
          baseClass,
          projectRoot,
          reasonsOut,
          visited,
        );
        for (const prop of inherited) {
          const name = prop.getName();
          if (!byName.has(name)) orderedNames.push(name);
          byName.set(name, prop);
        }
      }
    }
  }

  for (const prop of dtoClass.getProperties()) {
    if (prop.isStatic()) continue;
    const name = prop.getName();
    if (!byName.has(name)) orderedNames.push(name);
    byName.set(name, prop);
  }

  return orderedNames.map((n) => byName.get(n)!);
}

function extractDtoContract(
  dtoClass: ClassDeclaration,
  project: Project,
  projectRoot: string,
  reasonsOut: BodyUnsupportedReason[],
): BodyFieldContract[] {
  const fields: BodyFieldContract[] = [];
  const importMapCache = new Map<SourceFile, Map<string, ImportBinding>>();

  const getImportMap = (sf: SourceFile): Map<string, ImportBinding> => {
    let cached = importMapCache.get(sf);
    if (!cached) {
      cached = buildImportMap(sf);
      importMapCache.set(sf, cached);
    }
    return cached;
  };

  const properties = collectClassPropertiesWithInheritance(
    dtoClass,
    projectRoot,
    reasonsOut,
  );

  for (const prop of properties) {
    const propSf = prop.getSourceFile();
    const propSourceFile = toRelativePosixPath(projectRoot, propSf.getFilePath());
    const propLine = getNodeLine(prop.getNameNode());
    const fieldName = prop.getName();
    const typeNode = prop.getTypeNode();
    const tsType = typeNode ? typeNode.getText().trim() : "unknown";
    const tsOptional = prop.hasQuestionToken();

    const importMap = getImportMap(propSf);
    const validators: string[] = [];
    const seenValidators = new Set<string>();
    let isOptional = false;
    let min: number | undefined;
    let max: number | undefined;
    let minLength: number | undefined;
    let maxLength: number | undefined;
    let hasNestedDtoReason = false;

    for (const dec of prop.getDecorators()) {
      const decLine = getNodeLine(dec);
      const origin = resolveDecoratorOrigin(dec, propSf, importMap, project);
      const { localName, canonicalName, moduleSpecifier } = origin;
      const args = dec.getArguments();

      const isTrustedValidation =
        moduleSpecifier !== undefined &&
        TRUSTED_VALIDATION_MODULES.has(moduleSpecifier);
      const isTrustedTransform =
        moduleSpecifier !== undefined &&
        TRUSTED_TRANSFORM_MODULES.has(moduleSpecifier);

      if (isTrustedValidation) {
        checkOptionsForValidationGroups(
          args,
          fieldName,
          propSourceFile,
          decLine,
          reasonsOut,
        );

        if (canonicalName === "ValidateNested") {
          hasNestedDtoReason = true;
          reasonsOut.push({
            kind: "nested-dto",
            field: fieldName,
            reason: `Field '${fieldName}' uses @ValidateNested() which is outside top-level JSON body diff scope`,
            sourceFile: propSourceFile,
            line: decLine,
          });
          continue;
        }

        if (TRANSFORM_DECORATORS.has(canonicalName)) {
          reasonsOut.push({
            kind: "transform",
            field: fieldName,
            reason: `Field '${fieldName}' uses @${canonicalName}() transform decorator`,
            sourceFile: propSourceFile,
            line: decLine,
          });
          continue;
        }

        if (BUILTIN_VALIDATION_DECORATORS.has(canonicalName)) {
          if (!seenValidators.has(canonicalName)) {
            seenValidators.add(canonicalName);
            validators.push(canonicalName);
          }

          if (canonicalName === "IsOptional") {
            isOptional = true;
          } else if (
            canonicalName === "Min" ||
            canonicalName === "Max" ||
            canonicalName === "MinLength" ||
            canonicalName === "MaxLength"
          ) {
            const firstArg = args[0] as Expression | undefined;
            const num = extractNumericLiteral(firstArg);
            if (num === undefined) {
              reasonsOut.push({
                kind: "non-literal-arg",
                field: fieldName,
                reason: `@${canonicalName}(${firstArg ? firstArg.getText().trim() : ""}) on '${fieldName}' uses a non-literal bound`,
                sourceFile: propSourceFile,
                line: decLine,
              });
            } else if (canonicalName === "Min") {
              min = min === undefined ? num : Math.max(min, num);
            } else if (canonicalName === "Max") {
              max = max === undefined ? num : Math.min(max, num);
            } else if (canonicalName === "MinLength") {
              minLength =
                minLength === undefined ? num : Math.max(minLength, num);
            } else if (canonicalName === "MaxLength") {
              maxLength =
                maxLength === undefined ? num : Math.min(maxLength, num);
            }
          }
          continue;
        }

        // Other decorator from validation package (e.g. Validate, ValidateIf, Matches, IsEnum...)
        reasonsOut.push({
          kind: "custom-validator",
          field: fieldName,
          reason: `Validator @${canonicalName}() on '${fieldName}' is not statically analyzed and requires manual review`,
          sourceFile: propSourceFile,
          line: decLine,
        });
        continue;
      }

      if (isTrustedTransform || TRANSFORM_DECORATORS.has(canonicalName)) {
        reasonsOut.push({
          kind: "transform",
          field: fieldName,
          reason: `Field '${fieldName}' uses transform decorator @${localName}()${moduleSpecifier ? ` from '${moduleSpecifier}'` : ""}`,
          sourceFile: propSourceFile,
          line: decLine,
        });
        continue;
      }

      if (canonicalName === "ValidateNested") {
        hasNestedDtoReason = true;
        reasonsOut.push({
          kind: "nested-dto",
          field: fieldName,
          reason: `Field '${fieldName}' uses @${localName}() nested validation`,
          sourceFile: propSourceFile,
          line: decLine,
        });
        continue;
      }

      // 3rd-party or local decorator — MUST NOT be treated as a built-in validation constraint
      reasonsOut.push({
        kind: "custom-validator",
        field: fieldName,
        reason: `Decorator @${localName}() on '${fieldName}'${moduleSpecifier ? ` imported from '${moduleSpecifier}'` : " (local)"} is not a recognized built-in validator`,
        sourceFile: propSourceFile,
        line: decLine,
      });
    }

    if (
      !hasNestedDtoReason &&
      isNestedDtoOrObjectType(typeNode, propSf, project)
    ) {
      reasonsOut.push({
        kind: "nested-dto",
        field: fieldName,
        reason: `Field '${fieldName}: ${tsType}' is a nested DTO/object type outside top-level JSON body scope`,
        sourceFile: propSourceFile,
        line: propLine,
      });
    }

    const constraints: BodyFieldConstraints = {
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
    };

    fields.push({
      name: fieldName,
      tsType,
      tsOptional,
      isOptional,
      constraints,
      validators,
      sourceFile: propSourceFile,
      line: propLine,
    });
  }

  return fields;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Statically scans a Bunest project for controller routes with `@Body()` DTO
 * parameters, resolves DTO declarations across relative imports and aliases,
 * and extracts verified built-in validation constraints plus explicit
 * unsupported/needs-review reasons.
 */
export async function scanRouteBodyContracts(
  projectDir: string,
  options?: ScanBodyContractsOptions,
): Promise<ScanBodyContractsResult> {
  const projectRoot = resolve(projectDir);
  const sourceRootDir = options?.sourceRoot
    ? resolve(projectRoot, options.sourceRoot)
    : existsSyncPath(resolve(projectRoot, "src"))
      ? resolve(projectRoot, "src")
      : projectRoot;

  const candidateTsconfig = resolve(projectRoot, "tsconfig.json");
  const project = new Project({
    ...(existsSyncPath(candidateTsconfig)
      ? { tsConfigFilePath: candidateTsconfig }
      : {}),
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: false,
  });

  const filePaths = walkTsSourceFiles(sourceRootDir);
  const sourceFiles: SourceFile[] = [];
  for (const fp of filePaths) {
    const sf = project.addSourceFileAtPathIfExists(fp);
    if (sf) sourceFiles.push(sf);
  }

  const routes: RouteBodyContract[] = [];

  for (const sf of sourceFiles) {
    const routeSourceFile = toRelativePosixPath(projectRoot, sf.getFilePath());

    for (const cls of sf.getClasses()) {
      const controllerInfo = extractControllerInfo(cls);
      if (!controllerInfo) continue;

      const controllerName = cls.getName() ?? "AnonymousController";
      const controllerPipeReasons: BodyUnsupportedReason[] = [];
      inspectUsePipesDecorators(
        cls.getDecorators(),
        projectRoot,
        controllerPipeReasons,
      );

      for (const method of cls.getMethods()) {
        const httpRoutes = extractMethodHttpRoutes(method);
        if (httpRoutes.length === 0) continue;

        const methodVersion =
          extractVersionDecorator(method.getDecorators()) ??
          controllerInfo.version;
        const handlerName = method.getName();
        const routeLine = getNodeLine(method.getNameNode());

        // Find whole-body `@Body()` parameter (skipping property-scoped `@Body("field")`)
        let bodyParam: ParameterDeclaration | undefined;
        let bodyDecorator: Decorator | undefined;
        for (const param of method.getParameters()) {
          for (const dec of param.getDecorators()) {
            if (getDecoratorShortName(dec) !== "Body") continue;
            const firstStrArg = extractStringLiteral(
              dec.getArguments()[0] as Expression | undefined,
            );
            if (firstStrArg !== undefined) continue;
            bodyParam = param;
            bodyDecorator = dec;
            break;
          }
          if (bodyParam) break;
        }

        if (!bodyParam || !bodyDecorator) continue;

        const routeReasons: BodyUnsupportedReason[] = [...controllerPipeReasons];
        inspectUsePipesDecorators(
          method.getDecorators(),
          projectRoot,
          routeReasons,
        );
        for (const arg of bodyDecorator.getArguments()) {
          if (Node.isExpression(arg)) {
            inspectPipeExpression(arg, projectRoot, routeReasons);
          }
        }

        const resolvedDto = resolveBodyParamDto(
          bodyParam,
          sf,
          project,
          projectRoot,
        );

        let dtoName = resolvedDto.dtoName;
        let dtoSourceFile: string | undefined;
        let dtoLine: number | undefined;
        let dtoLocation: RouteBodyLocation | undefined;
        let fields: BodyFieldContract[] = [];

        if (resolvedDto.ok) {
          const dtoClass = resolvedDto.dtoClass;
          dtoName = resolvedDto.dtoName;
          dtoSourceFile = toRelativePosixPath(
            projectRoot,
            dtoClass.getSourceFile().getFilePath(),
          );
          dtoLine = getNodeLine(dtoClass.getNameNode() ?? dtoClass);
          dtoLocation = {
            file: dtoSourceFile,
            line: dtoLine,
            endLine: getNodeEndLine(dtoClass),
          };
          fields = extractDtoContract(dtoClass, project, projectRoot, routeReasons);
        } else {
          routeReasons.push(resolvedDto.reason);
        }

        for (const prefix of controllerInfo.prefixes) {
          for (const route of httpRoutes) {
            const fullPath = joinRoutePath(prefix, route.path);
            const key = `${route.httpMethod} ${fullPath}`;
            routes.push({
              key,
              method: route.httpMethod,
              path: fullPath,
              ...(methodVersion !== undefined ? { version: methodVersion } : {}),
              controllerName,
              handlerName,
              routeSourceFile,
              routeLine,
              dtoName,
              ...(dtoSourceFile !== undefined ? { dtoSourceFile } : {}),
              ...(dtoLine !== undefined ? { dtoLine } : {}),
              ...(dtoLocation !== undefined ? { dtoLocation } : {}),
              fields: [...fields],
              unsupportedReasons: [...routeReasons],
            });
          }
        }
      }
    }
  }

  routes.sort(
    (a, b) =>
      a.key.localeCompare(b.key) ||
      a.controllerName.localeCompare(b.controllerName) ||
      a.handlerName.localeCompare(b.handlerName),
  );

  return {
    projectDir: projectRoot,
    sourceRoot: toRelativePosixPath(projectRoot, sourceRootDir) || ".",
    routes,
    scannedFiles: sourceFiles.length,
  };
}
