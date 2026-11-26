import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type MethodDeclaration,
  type SourceFile,
} from "../ast";
import { nodeToLocation } from "../typegen/scanner";
import type { SourceLocation } from "../typegen/types";
import type { BunestDiagnostic } from "./diagnostics";
import {
  buildAddProviderToModuleEdit,
  buildConvertTypeImportEdit,
  type TextEditSpan,
} from "./magic-edits";
import type {
  ConstructorDependencyInfo,
  StaticModuleGraph,
  StaticModuleNode,
  StaticProviderNode,
  UnknownRegistrationKind,
} from "./module-graph";

export type RouteExplainConfirmationStatus =
  | "runtime-confirmed"
  | "static-only"
  | "mismatch";

export type RouteExplainPipelineStage =
  | "middleware"
  | "guard"
  | "interceptor"
  | "pipe"
  | "filter";

export type RouteExplainPipelineScope =
  | "global"
  | "module"
  | "controller"
  | "handler"
  | "param";

export type RouteExplainPipelineSource = "static" | "runtime" | "both";

export type DiDependencyStatus =
  | "resolved"
  | "missing-export"
  | "missing-import"
  | "unregistered"
  | "ambiguous-token"
  | "type-only-import"
  | "circular"
  | "unknown-dynamic";

export interface RouteExplainQuery {
  readonly raw: string;
  readonly method?: string;
  readonly path: string;
  readonly version?: string;
}

export interface RouteExplainRuntimeInfo {
  readonly attempted: boolean;
  readonly reachable: boolean;
  readonly serverUrl?: string;
  readonly bootstrapFailed?: boolean;
  readonly error?: string;
  readonly buildVersion?: string;
}

export interface DiOwnerModuleInfo {
  readonly name: string;
  readonly location?: SourceLocation;
  readonly exportsLocation?: SourceLocation;
  readonly exported: boolean;
  readonly importedByConsumer: boolean;
}

export interface DiDependencyTrace {
  readonly paramIndex: number;
  readonly paramName: string;
  readonly token: string;
  readonly typeName: string;
  readonly isOptional: boolean;
  readonly isTypeOnlyImport: boolean;
  readonly status: DiDependencyStatus;
  readonly ownerModules: readonly DiOwnerModuleInfo[];
  readonly location?: SourceLocation;
  readonly children?: readonly DiDependencyTrace[];
}

export interface RouteExplainPipelineEntry {
  readonly stage: RouteExplainPipelineStage;
  readonly name: string;
  readonly scope: RouteExplainPipelineScope;
  readonly source: RouteExplainPipelineSource;
  readonly location?: SourceLocation;
  readonly dependencies?: readonly DiDependencyTrace[];
}

export interface RouteExplainModuleInfo {
  readonly name: string;
  readonly location?: SourceLocation;
  readonly exportsLocation?: SourceLocation;
  readonly importsLocation?: SourceLocation;
  readonly isGlobal: boolean;
  readonly autoDiscover: boolean;
}

export interface RouteExplainControllerInfo {
  readonly name: string;
  readonly handlerName: string;
  readonly location?: SourceLocation;
  readonly handlerLocation?: SourceLocation;
  readonly isPublic?: boolean;
}

export interface RouteExplainMatch {
  readonly method: string;
  readonly path: string;
  readonly version?: string;
  readonly confirmationStatus: RouteExplainConfirmationStatus;
  readonly source: { readonly static: boolean; readonly runtime: boolean };
  readonly module?: RouteExplainModuleInfo;
  readonly controller: RouteExplainControllerInfo;
  readonly pipeline: readonly RouteExplainPipelineEntry[];
  readonly dependencies: readonly DiDependencyTrace[];
  readonly diagnostics: readonly BunestDiagnostic[];
}

export interface RouteExplainUnknown {
  readonly kind: UnknownRegistrationKind;
  readonly reason: string;
  readonly moduleName?: string;
  readonly location?: SourceLocation;
}

export type RouteExplainQuickFixKind =
  | "add-export"
  | "convert-type-import"
  | "add-provider";

export interface RouteExplainQuickFix {
  readonly id: string;
  readonly kind: RouteExplainQuickFixKind;
  readonly title: string;
  readonly targetFile: string;
  readonly location: SourceLocation;
  readonly edits: readonly TextEditSpan[];
  readonly deterministic: true;
}

export interface RouteExplainReport {
  readonly schemaVersion: "1.0";
  readonly query: RouteExplainQuery;
  readonly confirmationStatus: RouteExplainConfirmationStatus;
  readonly runtime: RouteExplainRuntimeInfo;
  readonly dirtyBuffers?: readonly string[];
  readonly matches: readonly RouteExplainMatch[];
  readonly unknowns: readonly RouteExplainUnknown[];
  readonly quickFixes: readonly RouteExplainQuickFix[];
}

export interface ExplainRouteOptions {
  readonly query: string;
  readonly version?: string;
  readonly sourceFiles: readonly SourceFile[];
  readonly moduleGraph: StaticModuleGraph;
  readonly diagnostics?: readonly BunestDiagnostic[];
  readonly serverUrl?: string;
  readonly dirtyBuffers?: readonly string[];
  readonly fetch?: typeof fetch;
}

interface StaticRouteCandidate {
  readonly method: string;
  readonly path: string;
  readonly version?: string;
  readonly controllerName: string;
  readonly handlerName: string;
  readonly controllerLocation: SourceLocation;
  readonly handlerLocation: SourceLocation;
  readonly sourceFile: SourceFile;
  readonly isPublic: boolean;
  readonly pipeline: readonly RouteExplainPipelineEntry[];
}

interface RuntimeRoutePayload {
  readonly method: string;
  readonly path: string;
  readonly controller?: string;
  readonly handler?: string;
  readonly version?: string | readonly string[];
  readonly module?: string;
  readonly guards?: readonly string[];
  readonly pipes?: readonly string[];
  readonly interceptors?: readonly string[];
  readonly filters?: readonly string[];
  readonly middleware?: readonly string[];
}

interface RuntimeRoutesResponse {
  readonly count?: number;
  readonly buildVersion?: string;
  readonly routes?: readonly RuntimeRoutePayload[];
}

interface RuntimeGraphResponse {
  readonly count?: number;
  readonly buildVersion?: string;
  readonly modules?: readonly {
    readonly name: string;
    readonly isGlobal?: boolean;
    readonly controllers?: readonly string[];
    readonly providers?: readonly { readonly token: string; readonly scope?: string }[];
    readonly exports?: readonly string[];
  }[];
}

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "ALL",
]);

const HTTP_METHOD_DECORATORS: Readonly<Record<string, string>> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Options: "OPTIONS",
  Head: "HEAD",
  All: "ALL",
};

const REQUEST_METHOD_ENUM_MAP: Readonly<Record<string, string>> = {
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  DELETE: "DELETE",
  PATCH: "PATCH",
  ALL: "ALL",
  OPTIONS: "OPTIONS",
  HEAD: "HEAD",
};

const PARAM_DECORATORS = new Set(["Param", "Query", "Body", "Headers", "UploadedFile", "UploadedFiles"]);

const APP_ENHANCER_STAGE_MAP: Readonly<Record<string, RouteExplainPipelineStage>> = {
  APP_GUARD: "guard",
  APP_PIPE: "pipe",
  APP_INTERCEPTOR: "interceptor",
  APP_FILTER: "filter",
};

const PRIMITIVE_OR_BUILTIN_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "object",
  "unknown",
  "any",
  "void",
  "never",
  "Date",
  "RegExp",
  "Array",
  "ReadonlyArray",
  "Map",
  "Set",
  "Record",
  "Promise",
  "Function",
  "ModuleRef",
  "Reflector",
  "Logger",
  "ConfigService",
  "EventEmitterService",
  "EventEmitter2",
  "CommandBus",
  "QueryBus",
  "EventBus",
  "DataSource",
  "EntityManager",
  "Repository",
  "MongoRepository",
  "OrmMigrationRunner",
  "HttpService",
  "ClientProxy",
]);

function getDecoratorShortName(dec: Decorator): string {
  const n = dec.getName();
  const i = n.lastIndexOf(".");
  return i !== -1 ? n.slice(i + 1) : n;
}

function getObjectProp(
  expr: Expression | undefined,
  propName: string,
): Expression | undefined {
  if (!expr || !Node.isObjectLiteralExpression(expr)) return undefined;
  const p = expr.getProperty(propName);
  if (p && Node.isPropertyAssignment(p)) return p.getInitializer();
  if (p && Node.isShorthandPropertyAssignment(p)) return p.getNameNode();
  return undefined;
}

function extractStringLiteral(expr: Expression | undefined): string | undefined {
  if (!expr) return undefined;
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.getLiteralValue();
  }
  return undefined;
}

function extractStringOrArrayLiterals(
  expr: Expression | undefined,
): { readonly values: string[]; readonly computed: boolean } {
  if (!expr) return { values: [], computed: false };
  const single = extractStringLiteral(expr);
  if (single !== undefined) return { values: [single], computed: false };
  if (Node.isArrayLiteralExpression(expr)) {
    const values: string[] = [];
    let computed = false;
    for (const el of expr.getElements()) {
      const lit = extractStringLiteral(el);
      if (lit !== undefined) values.push(lit);
      else computed = true;
    }
    return { values, computed };
  }
  return { values: [], computed: true };
}

function enhancerNameFromExpr(expr: Expression): string {
  if (Node.isIdentifier(expr)) return expr.getText();
  const text = expr.getText().trim();
  const newMatch = /^new\s+([A-Za-z_$][\w$.]*)\s*\(/.exec(text);
  if (newMatch?.[1]) return newMatch[1];
  return text;
}

export function normalizeRoutePath(rawPath: string): string {
  const withoutQuery = rawPath.split("?")[0]?.trim() ?? "";
  const cleaned = withoutQuery.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  return cleaned ? `/${cleaned}` : "/";
}

function joinRoutePath(prefix: string, subPath: string): string {
  const parts = [prefix, subPath]
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

/**
 * Parses a route query string such as `"POST /orders"`, `"/orders/123"`,
 * or `"GET /v1/orders/:id"` into a structured `RouteExplainQuery`.
 */
export function parseRouteQuery(
  raw: string,
  explicitVersion?: string,
): RouteExplainQuery {
  const trimmed = raw.trim();
  const spaceIdx = trimmed.search(/\s+/);
  if (spaceIdx > 0) {
    const maybeMethod = trimmed.slice(0, spaceIdx).toUpperCase();
    const rest = trimmed.slice(spaceIdx).trim();
    if (HTTP_METHODS.has(maybeMethod) && rest.length > 0) {
      return {
        raw,
        method: maybeMethod,
        path: normalizeRoutePath(rest),
        ...(explicitVersion ? { version: explicitVersion } : {}),
      };
    }
  }
  return {
    raw,
    path: normalizeRoutePath(trimmed),
    ...(explicitVersion ? { version: explicitVersion } : {}),
  };
}

function isParamSegment(seg: string): boolean {
  return seg.startsWith(":") || seg === "*" || seg.startsWith("*");
}

function matchPathSegments(queryPath: string, candidatePath: string): boolean {
  const qNorm = normalizeRoutePath(queryPath);
  const cNorm = normalizeRoutePath(candidatePath);
  if (qNorm === cNorm) return true;

  const qSegs = qNorm === "/" ? [] : qNorm.slice(1).split("/");
  const cSegs = cNorm === "/" ? [] : cNorm.slice(1).split("/");

  for (let i = 0; i < Math.max(qSegs.length, cSegs.length); i++) {
    const q = qSegs[i];
    const c = cSegs[i];
    if (c === "*" || c?.startsWith("*")) return true;
    if (q === "*" || q?.startsWith("*")) return true;
    if (q === undefined || c === undefined) return false;
    if (q === c) continue;
    if (isParamSegment(c) || isParamSegment(q)) continue;
    return false;
  }
  return true;
}

/**
 * Matches a parsed `RouteExplainQuery` against a route candidate, supporting
 * HTTP method wildcards (`ALL`), concrete paths vs `:param` segments, and
 * versioned routes (explicit version or `/v<version>/...` prefix).
 */
export function matchesRouteQuery(
  query: RouteExplainQuery,
  candidate: {
    readonly method: string;
    readonly path: string;
    readonly version?: string | readonly string[];
  },
): boolean {
  const candMethod = candidate.method.toUpperCase();
  if (
    query.method &&
    query.method !== "ALL" &&
    candMethod !== "ALL" &&
    candMethod !== query.method
  ) {
    return false;
  }

  const candVersions = Array.isArray(candidate.version)
    ? candidate.version.map(String)
    : candidate.version !== undefined
      ? [String(candidate.version)]
      : [];

  if (query.version) {
    if (candVersions.length === 0 || !candVersions.includes(query.version)) {
      return false;
    }
  }

  if (matchPathSegments(query.path, candidate.path)) {
    return true;
  }

  // Also match `/v<version><path>` when route specifies a version
  for (const v of candVersions) {
    const versionedPath = joinRoutePath(`v${v}`, candidate.path);
    if (matchPathSegments(query.path, versionedPath)) {
      return true;
    }
  }

  return false;
}

function extractEnhancerDecorators(
  decs: readonly Decorator[],
  scope: RouteExplainPipelineScope,
): RouteExplainPipelineEntry[] {
  const out: RouteExplainPipelineEntry[] = [];
  const map: Readonly<Record<string, RouteExplainPipelineStage>> = {
    UseGuards: "guard",
    UseInterceptors: "interceptor",
    UsePipes: "pipe",
    UseFilters: "filter",
  };
  for (const dec of decs) {
    const short = getDecoratorShortName(dec);
    const stage = map[short];
    if (!stage) continue;
    for (const arg of dec.getArguments()) {
      out.push({
        stage,
        name: enhancerNameFromExpr(arg as Expression),
        scope,
        source: "static",
        location: nodeToLocation(arg),
      });
    }
  }
  return out;
}

function extractVersionDecorator(decs: readonly Decorator[]): string[] | undefined {
  const dec = decs.find((d) => getDecoratorShortName(d) === "Version");
  if (!dec) return undefined;
  const arg0 = dec.getArguments()[0] as Expression | undefined;
  const { values } = extractStringOrArrayLiterals(arg0);
  return values.length > 0 ? values : undefined;
}

function extractGlobalEnhancersFromModules(
  sourceFiles: readonly SourceFile[],
): RouteExplainPipelineEntry[] {
  const out: RouteExplainPipelineEntry[] = [];
  for (const sf of sourceFiles) {
    for (const cls of sf.getClasses()) {
      const modDec = cls
        .getDecorators()
        .find((d) => {
          const s = getDecoratorShortName(d);
          return s === "Module" || s === "AutoModule";
        });
      if (!modDec) continue;
      const arg0 = modDec.getArguments()[0] as Expression | undefined;
      const providersExpr = getObjectProp(arg0, "providers");
      if (!providersExpr || !Node.isArrayLiteralExpression(providersExpr)) {
        continue;
      }
      for (const el of providersExpr.getElements()) {
        if (!Node.isObjectLiteralExpression(el)) continue;
        const provide = getObjectProp(el, "provide");
        if (!provide) continue;
        const tokenText = Node.isStringLiteral(provide)
          ? provide.getLiteralValue()
          : provide.getText().trim();
        const stage = APP_ENHANCER_STAGE_MAP[tokenText];
        if (!stage) continue;
        const useClass = getObjectProp(el, "useClass");
        const useValue = getObjectProp(el, "useValue");
        const targetExpr = useClass ?? useValue;
        const name = targetExpr ? enhancerNameFromExpr(targetExpr) : tokenText;
        out.push({
          stage,
          name,
          scope: "global",
          source: "static",
          location: nodeToLocation(el),
        });
      }
    }
  }
  return out;
}

function extractStaticRoutes(
  sourceFiles: readonly SourceFile[],
  globalEnhancers: readonly RouteExplainPipelineEntry[],
  unknowns: RouteExplainUnknown[],
): StaticRouteCandidate[] {
  const candidates: StaticRouteCandidate[] = [];

  for (const sf of sourceFiles) {
    for (const cls of sf.getClasses()) {
      const classDecs = cls.getDecorators();
      const ctrlDec = classDecs.find(
        (d) => getDecoratorShortName(d) === "Controller",
      );
      if (!ctrlDec) continue;

      const controllerName = cls.getName() ?? "AnonymousController";
      const controllerLocation = nodeToLocation(cls.getNameNode() ?? cls);
      const classPublic = classDecs.some(
        (d) => getDecoratorShortName(d) === "Public",
      );

      let prefixes: string[] = [""];
      let controllerVersions = extractVersionDecorator(classDecs);

      const ctrlArg0 = ctrlDec.getArguments()[0] as Expression | undefined;
      if (ctrlArg0) {
        if (Node.isObjectLiteralExpression(ctrlArg0)) {
          const pathProp = getObjectProp(ctrlArg0, "path");
          if (pathProp) {
            const parsed = extractStringOrArrayLiterals(pathProp);
            if (parsed.computed) {
              unknowns.push({
                kind: "computed-route",
                reason: `Controller "${controllerName}" uses computed path "${pathProp.getText()}".`,
                location: nodeToLocation(pathProp),
              });
            }
            if (parsed.values.length > 0) prefixes = parsed.values;
          }
          const verProp = getObjectProp(ctrlArg0, "version");
          if (verProp) {
            const parsedVer = extractStringOrArrayLiterals(verProp);
            if (parsedVer.values.length > 0) {
              controllerVersions = parsedVer.values;
            }
          }
        } else {
          const parsed = extractStringOrArrayLiterals(ctrlArg0);
          if (parsed.computed) {
            unknowns.push({
              kind: "computed-route",
              reason: `Controller "${controllerName}" uses computed route prefix "${ctrlArg0.getText()}".`,
              location: nodeToLocation(ctrlArg0),
            });
          }
          if (parsed.values.length > 0) prefixes = parsed.values;
        }
      }

      const classPipeline = extractEnhancerDecorators(classDecs, "controller");

      for (const method of cls.getMethods()) {
        const methodDecs = method.getDecorators();
        const methodRoutes: Array<{ httpMethod: string; path: string }> = [];

        for (const dec of methodDecs) {
          const short = getDecoratorShortName(dec);
          const mappedMethod = HTTP_METHOD_DECORATORS[short];
          if (mappedMethod) {
            const arg0 = dec.getArguments()[0] as Expression | undefined;
            if (!arg0) {
              methodRoutes.push({ httpMethod: mappedMethod, path: "" });
            } else {
              const parsed = extractStringOrArrayLiterals(arg0);
              if (parsed.computed) {
                unknowns.push({
                  kind: "computed-route",
                  reason: `Handler "${controllerName}.${method.getName()}" uses computed route path "${arg0.getText()}".`,
                  location: nodeToLocation(arg0),
                });
              }
              if (parsed.values.length === 0) {
                methodRoutes.push({ httpMethod: mappedMethod, path: "" });
              } else {
                for (const p of parsed.values) {
                  methodRoutes.push({ httpMethod: mappedMethod, path: p });
                }
              }
            }
          } else if (short === "RequestMapping") {
            const arg0 = dec.getArguments()[0] as Expression | undefined;
            const pathExpr = getObjectProp(arg0, "path");
            const methodExpr = getObjectProp(arg0, "method");
            let httpMethod = "GET";
            if (methodExpr) {
              const txt = methodExpr
                .getText()
                .replace(/^.*\./, "")
                .replace(/['"]/g, "")
                .toUpperCase();
              httpMethod = REQUEST_METHOD_ENUM_MAP[txt] ?? "GET";
            }
            const parsed = extractStringOrArrayLiterals(pathExpr);
            if (parsed.computed) {
              unknowns.push({
                kind: "computed-route",
                reason: `Handler "${controllerName}.${method.getName()}" uses computed @RequestMapping path.`,
                location: nodeToLocation(pathExpr ?? dec),
              });
            }
            if (parsed.values.length === 0) {
              methodRoutes.push({ httpMethod, path: "" });
            } else {
              for (const p of parsed.values) {
                methodRoutes.push({ httpMethod, path: p });
              }
            }
          }
        }

        if (methodRoutes.length === 0) continue;

        const handlerName = method.getName();
        const handlerLocation = nodeToLocation(method.getNameNode());
        const methodPublic =
          classPublic ||
          methodDecs.some((d) => getDecoratorShortName(d) === "Public");
        const methodVersions =
          extractVersionDecorator(methodDecs) ?? controllerVersions;
        const handlerPipeline = extractEnhancerDecorators(
          methodDecs,
          "handler",
        );

        // Parameter-level pipes: `@Param('id', ParseIntPipe)`, `@Body(ValidationPipe)`
        const paramPipeline: RouteExplainPipelineEntry[] = [];
        for (const param of method.getParameters()) {
          for (const pDec of param.getDecorators()) {
            const pShort = getDecoratorShortName(pDec);
            if (!PARAM_DECORATORS.has(pShort)) continue;
            const pArgs = pDec.getArguments();
            for (let idx = 0; idx < pArgs.length; idx++) {
              const arg = pArgs[idx] as Expression;
              if (idx === 0 && extractStringLiteral(arg) !== undefined) {
                continue;
              }
              paramPipeline.push({
                stage: "pipe",
                name: enhancerNameFromExpr(arg),
                scope: "param",
                source: "static",
                location: nodeToLocation(arg),
              });
            }
          }
        }

        const combinedPipeline: RouteExplainPipelineEntry[] = [
          ...globalEnhancers,
          ...classPipeline,
          ...handlerPipeline,
          ...paramPipeline,
        ];

        const versionList: readonly (string | undefined)[] =
          methodVersions && methodVersions.length > 0
            ? methodVersions
            : [undefined];

        for (const prefix of prefixes) {
          for (const mr of methodRoutes) {
            const fullPath = joinRoutePath(prefix, mr.path);
            for (const ver of versionList) {
              candidates.push({
                method: mr.httpMethod,
                path: fullPath,
                version: ver,
                controllerName,
                handlerName,
                controllerLocation,
                handlerLocation,
                sourceFile: sf,
                isPublic: methodPublic,
                pipeline: combinedPipeline,
              });
            }
          }
        }
      }
    }
  }

  return candidates;
}

function getImportedModuleNames(
  consumer: StaticModuleNode,
  graph: StaticModuleGraph,
): Set<string> {
  const imported = new Set<string>();
  const queue = [...consumer.imports];
  const visited = new Set<string>([consumer.name]);

  while (queue.length > 0) {
    const name = queue.shift()!;
    imported.add(name);
    if (visited.has(name)) continue;
    visited.add(name);
    const mod = graph.moduleByName.get(name);
    if (!mod) continue;
    for (const exp of mod.exports) {
      if (graph.moduleByName.has(exp) && !visited.has(exp)) {
        queue.push(exp);
      }
    }
  }
  return imported;
}

function isTokenVisibleInModule(
  consumer: StaticModuleNode,
  token: string,
  graph: StaticModuleGraph,
): boolean {
  if (
    consumer.providers.includes(token) ||
    consumer.controllers.includes(token) ||
    consumer.exports.includes(token)
  ) {
    return true;
  }
  for (const mod of graph.modules) {
    if (
      mod.isGlobal &&
      (mod.exports.includes(token) || mod.providers.includes(token))
    ) {
      return true;
    }
  }
  const importedNames = getImportedModuleNames(consumer, graph);
  if (importedNames.has(token)) {
    return true;
  }
  for (const impName of importedNames) {
    const mod = graph.moduleByName.get(impName);
    if (mod && mod.exports.includes(token)) {
      return true;
    }
  }
  return false;
}

function findOwningModulesForToken(
  token: string,
  graph: StaticModuleGraph,
): StaticModuleNode[] {
  const owners: StaticModuleNode[] = [];
  for (const mod of graph.modules) {
    if (mod.providers.includes(token)) {
      owners.push(mod);
    }
  }
  return owners;
}

function moduleHasUnknownsInScope(
  consumer: StaticModuleNode | undefined,
  graph: StaticModuleGraph,
): boolean {
  if (!consumer) return graph.unknownRegistrations.length > 0;
  if (consumer.autoDiscover) return true;
  const inScope = new Set<string>([
    consumer.name,
    ...getImportedModuleNames(consumer, graph),
  ]);
  for (const mod of graph.modules) {
    if (mod.isGlobal) inScope.add(mod.name);
  }
  return graph.unknownRegistrations.some(
    (u) => !u.moduleName || inScope.has(u.moduleName),
  );
}

function traceDependencies(
  deps: readonly ConstructorDependencyInfo[],
  consumerMod: StaticModuleNode | undefined,
  graph: StaticModuleGraph,
  visited: ReadonlySet<string>,
): DiDependencyTrace[] {
  const importedNames = consumerMod
    ? getImportedModuleNames(consumerMod, graph)
    : new Set<string>();
  const hasUnknowns = moduleHasUnknownsInScope(consumerMod, graph);

  return deps.map((dep, paramIndex): DiDependencyTrace => {
    const token = dep.token ?? dep.typeName;
    const isBuiltin = !dep.token && PRIMITIVE_OR_BUILTIN_TYPES.has(dep.typeName);

    if (dep.isTypeOnlyImport && !dep.token && !isBuiltin) {
      return {
        paramIndex,
        paramName: dep.paramName,
        token,
        typeName: dep.typeName,
        isOptional: dep.isOptional,
        isTypeOnlyImport: true,
        status: "type-only-import",
        ownerModules: [],
        location: dep.location,
      };
    }

    if (isBuiltin) {
      return {
        paramIndex,
        paramName: dep.paramName,
        token,
        typeName: dep.typeName,
        isOptional: dep.isOptional,
        isTypeOnlyImport: dep.isTypeOnlyImport,
        status: "resolved",
        ownerModules: [],
        location: dep.location,
      };
    }

    if (visited.has(token) && !dep.isForwardRef) {
      return {
        paramIndex,
        paramName: dep.paramName,
        token,
        typeName: dep.typeName,
        isOptional: dep.isOptional,
        isTypeOnlyImport: dep.isTypeOnlyImport,
        status: "circular",
        ownerModules: [],
        location: dep.location,
      };
    }

    const owningMods = findOwningModulesForToken(token, graph);
    const ownerModules: DiOwnerModuleInfo[] = owningMods.map((mod) => ({
      name: mod.name,
      location: mod.location,
      exportsLocation: mod.exportsLocation,
      exported: mod.exports.includes(token) || mod.isGlobal,
      importedByConsumer: consumerMod
        ? mod.name === consumerMod.name || importedNames.has(mod.name)
        : false,
    }));

    const providerDeclCount = graph.providersByName.get(token)?.length ?? 0;
    const consumerOwnsDirectly = Boolean(
      consumerMod && consumerMod.providers.includes(token),
    );
    const visibleOwners = ownerModules.filter(
      (o) =>
        (consumerMod && o.name === consumerMod.name) ||
        (o.importedByConsumer && o.exported) ||
        graph.moduleByName.get(o.name)?.isGlobal === true,
    );

    let status: DiDependencyStatus;
    if (
      visibleOwners.length > 1 ||
      (owningMods.length > 1 && !consumerOwnsDirectly) ||
      (providerDeclCount > 1 && owningMods.length > 1)
    ) {
      status = "ambiguous-token";
    } else if (
      consumerMod &&
      isTokenVisibleInModule(consumerMod, token, graph)
    ) {
      status = "resolved";
    } else if (owningMods.length > 0) {
      const hasImportedUnexported = ownerModules.some(
        (o) => o.importedByConsumer && !o.exported,
      );
      status = hasImportedUnexported ? "missing-export" : "missing-import";
    } else {
      status = hasUnknowns ? "unknown-dynamic" : "unregistered";
    }

    let children: DiDependencyTrace[] | undefined;
    if (status === "resolved") {
      const targetProv = graph.providerByName.get(token);
      if (targetProv && targetProv.dependencies.length > 0) {
        const nextMod =
          owningMods.length === 1 ? owningMods[0] : consumerMod;
        const nextVisited = new Set(visited);
        nextVisited.add(token);
        children = traceDependencies(
          targetProv.dependencies,
          nextMod,
          graph,
          nextVisited,
        );
      }
    }

    return {
      paramIndex,
      paramName: dep.paramName,
      token,
      typeName: dep.typeName,
      isOptional: dep.isOptional,
      isTypeOnlyImport: dep.isTypeOnlyImport,
      status,
      ownerModules,
      location: dep.location,
      ...(children && children.length > 0 ? { children } : {}),
    };
  });
}

function findControllerOwnerModule(
  controllerName: string,
  graph: StaticModuleGraph,
): StaticModuleNode | undefined {
  return graph.modules.find((m) => m.controllers.includes(controllerName));
}

function toModuleInfo(
  mod: StaticModuleNode | undefined,
): RouteExplainModuleInfo | undefined {
  if (!mod) return undefined;
  return {
    name: mod.name,
    location: mod.location,
    exportsLocation: mod.exportsLocation,
    importsLocation: mod.importsLocation,
    isGlobal: mod.isGlobal,
    autoDiscover: mod.autoDiscover,
  };
}

function collectDependencyTokens(
  traces: readonly DiDependencyTrace[],
  out: Set<string>,
): void {
  for (const t of traces) {
    out.add(t.token);
    out.add(t.typeName);
    if (t.children) collectDependencyTokens(t.children, out);
  }
}

function filterRelevantDiagnostics(
  allDiagnostics: readonly BunestDiagnostic[],
  controllerName: string,
  controllerFile: string,
  moduleName: string | undefined,
  traces: readonly DiDependencyTrace[],
): BunestDiagnostic[] {
  const tokens = new Set<string>([controllerName]);
  if (moduleName) tokens.add(moduleName);
  collectDependencyTokens(traces, tokens);

  return allDiagnostics.filter((d) => {
    if (d.location.filePath === controllerFile) return true;
    for (const tok of tokens) {
      if (d.message.includes(`"${tok}"`)) return true;
    }
    return false;
  });
}

function mergeRuntimePipeline(
  staticPipeline: readonly RouteExplainPipelineEntry[],
  rt: RuntimeRoutePayload,
): {
  readonly pipeline: RouteExplainPipelineEntry[];
  readonly hasPipelineMismatch: boolean;
} {
  const hasRuntimePipeline =
    rt.guards !== undefined ||
    rt.pipes !== undefined ||
    rt.interceptors !== undefined ||
    rt.filters !== undefined ||
    rt.middleware !== undefined;

  if (!hasRuntimePipeline) {
    return { pipeline: [...staticPipeline], hasPipelineMismatch: false };
  }

  const runtimeStages: Array<{
    stage: RouteExplainPipelineStage;
    names: readonly string[];
  }> = [
    { stage: "middleware", names: rt.middleware ?? [] },
    { stage: "guard", names: rt.guards ?? [] },
    { stage: "interceptor", names: rt.interceptors ?? [] },
    { stage: "pipe", names: rt.pipes ?? [] },
    { stage: "filter", names: rt.filters ?? [] },
  ];

  const remainingStatic = new Map<string, RouteExplainPipelineEntry[]>();
  for (const entry of staticPipeline) {
    const key = `${entry.stage}:${entry.name}`;
    const list = remainingStatic.get(key) ?? [];
    list.push(entry);
    remainingStatic.set(key, list);
  }

  const merged: RouteExplainPipelineEntry[] = [];
  for (const { stage, names } of runtimeStages) {
    for (const name of names) {
      const key = `${stage}:${name}`;
      const list = remainingStatic.get(key);
      const matchedStatic = list?.shift();
      if (matchedStatic) {
        merged.push({
          ...matchedStatic,
          source: "both",
        });
      } else {
        merged.push({
          stage,
          name,
          scope: "global",
          source: "runtime",
        });
      }
    }
  }

  let hasPipelineMismatch = false;
  for (const list of remainingStatic.values()) {
    for (const leftover of list) {
      // Static controller/handler enhancer declared in code but missing at runtime
      hasPipelineMismatch = true;
      merged.push(leftover);
    }
  }

  return { pipeline: merged, hasPipelineMismatch };
}

function generateDeterministicQuickFixes(
  matches: readonly RouteExplainMatch[],
  confirmationStatus: RouteExplainConfirmationStatus,
  sourceFiles: readonly SourceFile[],
  graph: StaticModuleGraph,
  unknowns: readonly RouteExplainUnknown[],
): RouteExplainQuickFix[] {
  if (confirmationStatus === "mismatch") {
    return [];
  }

  const sfByPath = new Map<string, SourceFile>();
  for (const sf of sourceFiles) {
    sfByPath.set(sf.getFilePath(), sf);
  }

  const fixes: RouteExplainQuickFix[] = [];
  const seenIds = new Set<string>();

  const pushFix = (fix: RouteExplainQuickFix): void => {
    if (seenIds.has(fix.id)) return;
    seenIds.add(fix.id);
    fixes.push(fix);
  };

  const inspectDeps = (
    deps: readonly DiDependencyTrace[],
    consumerName: string,
    consumerFile: string | undefined,
    consumerMod: StaticModuleNode | undefined,
  ): void => {
    const consumerHasUnknowns =
      Boolean(consumerMod?.autoDiscover) ||
      moduleHasUnknownsInScope(consumerMod, graph) ||
      unknowns.some(
        (u) =>
          u.kind === "auto-discover" ||
          (consumerMod && u.moduleName === consumerMod.name),
      );

    for (const dep of deps) {
      if (dep.status === "type-only-import" && consumerFile) {
        const sf = sfByPath.get(consumerFile);
        if (sf) {
          const edit = buildConvertTypeImportEdit({
            sourceFile: sf,
            symbolName: dep.typeName,
          });
          if (edit.changed) {
            pushFix({
              id: `convert-type-import:${consumerName}:${dep.typeName}`,
              kind: "convert-type-import",
              title: `Convert type-only import of ${dep.typeName} to value import`,
              targetFile: sf.getFilePath(),
              location: dep.location ?? {
                filePath: sf.getFilePath(),
                line: 1,
                column: 1,
                endLine: 1,
                endColumn: 1,
                start: 0,
                end: 0,
              },
              edits: edit.edits,
              deterministic: true,
            });
          }
        }
      } else if (
        dep.status === "missing-export" &&
        !consumerHasUnknowns &&
        dep.ownerModules.length === 1
      ) {
        const ownerInfo = dep.ownerModules[0]!;
        if (ownerInfo.importedByConsumer && !ownerInfo.exported) {
          const ownerMod = graph.moduleByName.get(ownerInfo.name);
          const ownerHasUnknowns =
            Boolean(ownerMod?.autoDiscover) ||
            unknowns.some((u) => u.moduleName === ownerInfo.name);
          if (ownerMod && !ownerHasUnknowns) {
            const ownerSf = sfByPath.get(ownerMod.sourceFile);
            if (ownerSf) {
              const edit = buildAddProviderToModuleEdit({
                sourceFile: ownerSf,
                moduleClassName: ownerMod.name,
                symbolName: dep.token,
                arrayProperty: "exports",
              });
              if (edit.changed) {
                pushFix({
                  id: `add-export:${ownerMod.name}:${dep.token}`,
                  kind: "add-export",
                  title: `Export ${dep.token} from ${ownerMod.name}`,
                  targetFile: ownerMod.sourceFile,
                  location:
                    ownerMod.exportsLocation ?? ownerMod.decoratorLocation,
                  edits: edit.edits,
                  deterministic: true,
                });
              }
            }
          }
        }
      } else if (
        dep.status === "unregistered" &&
        !consumerHasUnknowns &&
        dep.ownerModules.length === 0 &&
        consumerMod &&
        !consumerMod.autoDiscover &&
        unknowns.length === 0
      ) {
        const consumerSf = sfByPath.get(consumerMod.sourceFile);
        const provDecl = graph.providerByName.get(dep.token);
        if (consumerSf && provDecl) {
          const edit = buildAddProviderToModuleEdit({
            sourceFile: consumerSf,
            moduleClassName: consumerMod.name,
            symbolName: dep.token,
            arrayProperty: "providers",
          });
          if (edit.changed) {
            pushFix({
              id: `add-provider:${consumerMod.name}:${dep.token}`,
              kind: "add-provider",
              title: `Register ${dep.token} in ${consumerMod.name}.providers`,
              targetFile: consumerMod.sourceFile,
              location:
                consumerMod.providersLocation ?? consumerMod.decoratorLocation,
              edits: edit.edits,
              deterministic: true,
            });
          }
        }
      }

      if (dep.children && dep.children.length > 0) {
        const nextProv = graph.providerByName.get(dep.token);
        const nextMod =
          dep.ownerModules.length === 1
            ? graph.moduleByName.get(dep.ownerModules[0]!.name)
            : consumerMod;
        inspectDeps(
          dep.children,
          dep.token,
          nextProv?.sourceFile,
          nextMod,
        );
      }
    }
  };

  for (const match of matches) {
    if (match.module?.autoDiscover) continue;
    const consumerMod = match.module
      ? graph.moduleByName.get(match.module.name)
      : undefined;
    inspectDeps(
      match.dependencies,
      match.controller.name,
      match.controller.location?.filePath,
      consumerMod,
    );
    for (const entry of match.pipeline) {
      if (entry.dependencies && entry.dependencies.length > 0) {
        const enhProv = graph.providerByName.get(entry.name);
        inspectDeps(
          entry.dependencies,
          entry.name,
          enhProv?.sourceFile ?? entry.location?.filePath,
          consumerMod,
        );
      }
    }
  }

  return fixes;
}

/**
 * Explains a Bunest HTTP route statically and optionally confirms it against a
 * running dev server (`/__bunest/routes` and `/__bunest/graph`), producing a
 * versioned `RouteExplainReport` (`schemaVersion: "1.0"`).
 */
export async function explainRoute(
  options: ExplainRouteOptions,
): Promise<RouteExplainReport> {
  const query = parseRouteQuery(options.query, options.version);
  const unknowns: RouteExplainUnknown[] = [
    ...options.moduleGraph.unknownRegistrations,
  ];
  const globalEnhancers = extractGlobalEnhancersFromModules(options.sourceFiles);
  const allStaticRoutes = extractStaticRoutes(
    options.sourceFiles,
    globalEnhancers,
    unknowns,
  );
  const matchingStatic = allStaticRoutes.filter((r) =>
    matchesRouteQuery(query, r),
  );

  const staticMatches: RouteExplainMatch[] = matchingStatic.map((cand) => {
    const ownerMod = findControllerOwnerModule(
      cand.controllerName,
      options.moduleGraph,
    );
    const ctrlProv = options.moduleGraph.providerByName.get(
      cand.controllerName,
    );
    const deps = ctrlProv
      ? traceDependencies(
          ctrlProv.dependencies,
          ownerMod,
          options.moduleGraph,
          new Set([cand.controllerName]),
        )
      : [];

    const pipelineWithDeps: RouteExplainPipelineEntry[] = cand.pipeline.map(
      (entry) => {
        const enhProv = options.moduleGraph.providerByName.get(entry.name);
        if (!enhProv || enhProv.dependencies.length === 0) {
          return entry;
        }
        return {
          ...entry,
          dependencies: traceDependencies(
            enhProv.dependencies,
            ownerMod,
            options.moduleGraph,
            new Set([entry.name]),
          ),
        };
      },
    );

    const diagnostics = filterRelevantDiagnostics(
      options.diagnostics ?? [],
      cand.controllerName,
      cand.sourceFile.getFilePath(),
      ownerMod?.name,
      deps,
    );

    return {
      method: cand.method,
      path: cand.path,
      ...(cand.version !== undefined ? { version: cand.version } : {}),
      confirmationStatus: "static-only",
      source: { static: true, runtime: false },
      ...(ownerMod ? { module: toModuleInfo(ownerMod) } : {}),
      controller: {
        name: cand.controllerName,
        handlerName: cand.handlerName,
        location: cand.controllerLocation,
        handlerLocation: cand.handlerLocation,
        ...(cand.isPublic ? { isPublic: true } : {}),
      },
      pipeline: pipelineWithDeps,
      dependencies: deps,
      diagnostics,
    };
  });

  // Query runtime dev diagnostics endpoints if `serverUrl` is provided
  let runtime: RouteExplainRuntimeInfo = {
    attempted: false,
    reachable: false,
  };
  let finalMatches: RouteExplainMatch[] = staticMatches;
  let confirmationStatus: RouteExplainConfirmationStatus = "static-only";

  if (options.serverUrl) {
    const baseUrl = options.serverUrl.replace(/\/+$/, "");
    const fetchFn = options.fetch ?? fetch;
    try {
      const [routesRes, graphRes] = await Promise.all([
        fetchFn(`${baseUrl}/__bunest/routes`),
        fetchFn(`${baseUrl}/__bunest/graph`),
      ]);

      if (!routesRes.ok || !graphRes.ok) {
        const failedRes = !routesRes.ok ? routesRes : graphRes;
        let errText = `HTTP ${failedRes.status}`;
        try {
          const body = await failedRes.text();
          if (body) {
            try {
              const parsed = JSON.parse(body) as { error?: string; message?: string };
              errText = parsed.error ?? parsed.message ?? body;
            } catch {
              errText = body;
            }
          }
        } catch {
          // ignore body read error
        }
        runtime = {
          attempted: true,
          reachable: true,
          serverUrl: baseUrl,
          bootstrapFailed: true,
          error: errText,
        };
        confirmationStatus = "static-only";
      } else {
        const routesData = (await routesRes.json()) as RuntimeRoutesResponse;
        const graphData = (await graphRes.json()) as RuntimeGraphResponse;
        const buildVersion =
          routesRes.headers.get("x-bunest-build-version") ??
          routesData.buildVersion ??
          graphData.buildVersion;

        runtime = {
          attempted: true,
          reachable: true,
          serverUrl: baseUrl,
          bootstrapFailed: false,
          ...(buildVersion ? { buildVersion } : {}),
        };

        // Build runtime controller -> module map from `/__bunest/graph`
        const runtimeCtrlToMod = new Map<
          string,
          { name: string; isGlobal: boolean }
        >();
        for (const m of graphData.modules ?? []) {
          for (const c of m.controllers ?? []) {
            runtimeCtrlToMod.set(c, {
              name: m.name,
              isGlobal: Boolean(m.isGlobal),
            });
          }
        }

        const matchingRuntime = (routesData.routes ?? []).filter((r) =>
          matchesRouteQuery(query, {
            method: r.method,
            path: r.path,
            version: r.version,
          }),
        );

        const usedRuntime = new Set<number>();
        const reconciled: RouteExplainMatch[] = [];

        for (const sm of staticMatches) {
          const rtIdx = matchingRuntime.findIndex((rt, idx) => {
            if (usedRuntime.has(idx)) return false;
            const rtMethod = rt.method.toUpperCase();
            const rtPath = normalizeRoutePath(rt.path);
            const rtCtrl = rt.controller ?? "UnknownController";
            const rtHandler = rt.handler ?? "";
            const rtMod =
              rt.module ?? runtimeCtrlToMod.get(rtCtrl)?.name;
            const sameRoute =
              rtMethod === sm.method &&
              rtPath === normalizeRoutePath(sm.path) &&
              rtCtrl === sm.controller.name &&
              rtHandler === sm.controller.handlerName;
            if (!sameRoute) return false;
            if (rtMod && sm.module && rtMod !== sm.module.name) return false;
            return true;
          });

          if (rtIdx !== -1) {
            usedRuntime.add(rtIdx);
            const rt = matchingRuntime[rtIdx]!;
            const { pipeline, hasPipelineMismatch } = mergeRuntimePipeline(
              sm.pipeline,
              rt,
            );
            const matchStatus: RouteExplainConfirmationStatus =
              hasPipelineMismatch ? "mismatch" : "runtime-confirmed";
            reconciled.push({
              ...sm,
              confirmationStatus: matchStatus,
              source: { static: true, runtime: true },
              pipeline,
            });
          } else {
            reconciled.push({
              ...sm,
              confirmationStatus: "mismatch",
              source: { static: true, runtime: false },
            });
          }
        }

        // Preserve any runtime-only matches (mismatch)
        for (let idx = 0; idx < matchingRuntime.length; idx++) {
          if (usedRuntime.has(idx)) continue;
          const rt = matchingRuntime[idx]!;
          const rtCtrl = rt.controller ?? "UnknownController";
          const rtModName =
            rt.module ?? runtimeCtrlToMod.get(rtCtrl)?.name;
          const staticMod = rtModName
            ? options.moduleGraph.moduleByName.get(rtModName)
            : undefined;
          const rtPipeline: RouteExplainPipelineEntry[] = [
            ...(rt.middleware ?? []).map((name) => ({
              stage: "middleware" as const,
              name,
              scope: "global" as const,
              source: "runtime" as const,
            })),
            ...(rt.guards ?? []).map((name) => ({
              stage: "guard" as const,
              name,
              scope: "global" as const,
              source: "runtime" as const,
            })),
            ...(rt.interceptors ?? []).map((name) => ({
              stage: "interceptor" as const,
              name,
              scope: "global" as const,
              source: "runtime" as const,
            })),
            ...(rt.pipes ?? []).map((name) => ({
              stage: "pipe" as const,
              name,
              scope: "global" as const,
              source: "runtime" as const,
            })),
            ...(rt.filters ?? []).map((name) => ({
              stage: "filter" as const,
              name,
              scope: "global" as const,
              source: "runtime" as const,
            })),
          ];
          const rtVer: string | undefined =
            typeof rt.version === "string"
              ? rt.version
              : Array.isArray(rt.version)
                ? rt.version.join(",")
                : undefined;
          reconciled.push({
            method: rt.method.toUpperCase(),
            path: normalizeRoutePath(rt.path),
            ...(rtVer ? { version: rtVer } : {}),
            confirmationStatus: "mismatch",
            source: { static: false, runtime: true },
            ...(staticMod
              ? { module: toModuleInfo(staticMod) }
              : rtModName
                ? {
                    module: {
                      name: rtModName,
                      isGlobal:
                        runtimeCtrlToMod.get(rtCtrl)?.isGlobal ?? false,
                      autoDiscover: false,
                    },
                  }
                : {}),
            controller: {
              name: rtCtrl,
              handlerName: rt.handler ?? "unknown",
            },
            pipeline: rtPipeline,
            dependencies: [],
            diagnostics: [],
          });
          unknowns.push({
            kind: "runtime-only",
            reason: `Route "${rt.method.toUpperCase()} ${normalizeRoutePath(rt.path)}" (${rtCtrl}.${rt.handler ?? "unknown"}) exists at runtime but was not matched statically.`,
            ...(rtModName ? { moduleName: rtModName } : {}),
          });
        }

        finalMatches = reconciled;
        const anyMismatch = reconciled.some(
          (m) => m.confirmationStatus === "mismatch",
        );
        confirmationStatus = anyMismatch ? "mismatch" : "runtime-confirmed";
      }
    } catch (err) {
      runtime = {
        attempted: true,
        reachable: false,
        serverUrl: baseUrl,
        bootstrapFailed: true,
        error: err instanceof Error ? err.message : String(err),
      };
      confirmationStatus = "static-only";
    }
  }

  const quickFixes = generateDeterministicQuickFixes(
    finalMatches,
    confirmationStatus,
    options.sourceFiles,
    options.moduleGraph,
    unknowns,
  );

  return {
    schemaVersion: "1.0",
    query,
    confirmationStatus,
    runtime,
    ...(options.dirtyBuffers && options.dirtyBuffers.length > 0
      ? { dirtyBuffers: [...options.dirtyBuffers] }
      : {}),
    matches: finalMatches,
    unknowns,
    quickFixes,
  };
}
