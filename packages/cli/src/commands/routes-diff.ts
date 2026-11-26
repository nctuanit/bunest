import {
  dirname,
  existsSyncPath,
  mkdirSyncPath,
  readTextSync,
  relative,
  resolve,
  writeTextSync,
} from "@bunest/core";
import {
  diffBodyContracts,
  formatBodyContractDiffPretty,
  type BodyContractDiffReport,
  type BodyContractPayload,
  type PipeProfileInfo,
  type ReplayEvidenceRecord as DiffReplayEvidenceRecord,
  type ReplayVerdict,
  type RouteBodyContract,
} from "../analyzer/body-contract-diff";
import {
  scanRouteBodyContracts,
  type RouteBodyContract as ScannedRouteBodyContract,
} from "../analyzer/body-dto-scanner";
import { normalizeRoutePath } from "../analyzer/route-explain";
import {
  Node,
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type MethodDeclaration,
  type SourceFile,
} from "../ast";
import {
  loadBunestConfig,
  type BunestConfigLike,
} from "../config/bunest-config.loader";
import { loadCliConfiguration } from "../config/configuration.loader";
import { BunestTypegenScanner, nodeToLocation } from "../typegen/scanner";
import type { ExtractedRouteEntry, SourceLocation } from "../typegen/types";
import type { CliIO } from "../types";

export type RoutesDiffFormat = "pretty" | "json";

export interface RouteManifestEntry {
  readonly method: string;
  readonly path: string;
  readonly version?: string;
  readonly controller?: string;
  readonly handler?: string;
  readonly sourceFile?: string;
  readonly body?: BodyContractPayload;
}

export interface RouteSnapshotManifest {
  readonly schemaVersion: "1.0";
  readonly commit?: string;
  readonly bodyMetadataIncluded?: boolean;
  readonly routes: readonly RouteManifestEntry[];
  readonly unknowns: readonly RouteDiffUnknown[];
}

export interface RoutesSnapshotCommandOptions {
  readonly cwd?: string;
  readonly out?: string;
  readonly body?: boolean;
  readonly commit?: string;
  readonly sourceRoot?: string;
  readonly tsconfig?: string;
  readonly config?: string;
  readonly bunestConfig?: BunestConfigLike;
  readonly silent?: boolean;
}

export interface RoutesSnapshotCommandResult {
  readonly exitCode: number;
  readonly manifest?: RouteSnapshotManifest;
  readonly formatted: string;
  readonly outPath?: string;
}

export interface RouteParamRenameDetail {
  readonly segmentIndex: number;
  readonly from: string;
  readonly to: string;
}

export interface RouteParamRenameEntry {
  readonly method: string;
  readonly fromPath: string;
  readonly toPath: string;
  readonly version?: string;
  readonly paramRenames: readonly RouteParamRenameDetail[];
  readonly base: RouteManifestEntry;
  readonly current: RouteManifestEntry;
}

export interface RouteVersionChangeEntry {
  readonly method: string;
  readonly path: string;
  readonly fromVersion?: string;
  readonly toVersion?: string;
  readonly base: RouteManifestEntry;
  readonly current: RouteManifestEntry;
}

export interface RouteDiffUnknown {
  readonly kind: "computed-route" | "dynamic-route";
  readonly reason: string;
  readonly controller?: string;
  readonly handler?: string;
  readonly location?: SourceLocation;
}

export interface RouteDiffReport {
  readonly schemaVersion: "1.0";
  readonly hasChanges: boolean;
  readonly summary: {
    readonly baseCount: number;
    readonly currentCount: number;
    readonly added: number;
    readonly removed: number;
    readonly paramRenamed: number;
    readonly versionChanged: number;
    readonly unknowns: number;
  };
  readonly added: readonly RouteManifestEntry[];
  readonly removed: readonly RouteManifestEntry[];
  readonly paramRenamed: readonly RouteParamRenameEntry[];
  readonly versionChanged: readonly RouteVersionChangeEntry[];
  readonly unknowns: readonly RouteDiffUnknown[];
  readonly bodyDiff?: BodyContractDiffReport;
}

export interface RoutesDiffCommandOptions {
  readonly base: string;
  readonly head?: string;
  readonly body?: boolean;
  readonly evidence?: string;
  readonly baseCommit?: string;
  readonly headCommit?: string;
  readonly pipeProfile?: PipeProfileInfo;
  readonly sampleValues?: Readonly<Record<string, unknown>>;
  readonly cwd?: string;
  readonly sourceRoot?: string;
  readonly tsconfig?: string;
  readonly config?: string;
  readonly bunestConfig?: BunestConfigLike;
  readonly format?: RoutesDiffFormat;
  readonly silent?: boolean;
}

export interface RoutesDiffCommandResult {
  readonly exitCode: number;
  readonly report?: RouteDiffReport;
  readonly formatted: string;
}

export interface ScanProjectRoutesResult {
  readonly routes: readonly RouteManifestEntry[];
  readonly unknowns: readonly RouteDiffUnknown[];
}

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

function getDecoratorShortName(dec: Decorator): string {
  const name = dec.getName();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : name;
}

function getObjectProp(
  expr: Expression | undefined,
  propName: string,
): Expression | undefined {
  if (!expr || !Node.isObjectLiteralExpression(expr)) return undefined;
  const prop = expr.getProperty(propName);
  if (!prop || !Node.isPropertyAssignment(prop)) return undefined;
  return prop.getInitializer();
}

function extractStringOrArrayLiterals(expr: Expression | undefined): {
  values: string[];
  computed: boolean;
} {
  if (!expr) return { values: [], computed: false };
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return { values: [expr.getLiteralValue()], computed: false };
  }
  if (Node.isArrayLiteralExpression(expr)) {
    const values: string[] = [];
    let computed = false;
    for (const el of expr.getElements()) {
      if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
        values.push(el.getLiteralValue());
      } else {
        computed = true;
      }
    }
    return { values, computed };
  }
  return { values: [], computed: true };
}

function extractVersionValues(decs: readonly Decorator[]): string[] | undefined {
  const dec = decs.find((d) => getDecoratorShortName(d) === "Version");
  if (!dec) return undefined;
  const arg0 = dec.getArguments()[0] as Expression | undefined;
  const { values } = extractStringOrArrayLiterals(arg0);
  return values.length > 0 ? values : undefined;
}

function extractControllerVersion(cls: ClassDeclaration): string[] | undefined {
  const classDecs = cls.getDecorators();
  let versions = extractVersionValues(classDecs);
  const ctrlDec = classDecs.find((d) => getDecoratorShortName(d) === "Controller");
  if (ctrlDec) {
    const arg0 = ctrlDec.getArguments()[0] as Expression | undefined;
    const verProp = getObjectProp(arg0, "version");
    if (verProp) {
      const parsed = extractStringOrArrayLiterals(verProp);
      if (parsed.values.length > 0) {
        versions = parsed.values;
      }
    }
  }
  return versions;
}

function collectRouteVersionsAndUnknowns(sourceFiles: readonly SourceFile[]): {
  versionsByHandler: Map<string, readonly string[]>;
  unknowns: RouteDiffUnknown[];
} {
  const versionsByHandler = new Map<string, readonly string[]>();
  const unknowns: RouteDiffUnknown[] = [];

  for (const sf of sourceFiles) {
    const filePath = sf.getFilePath();
    for (const cls of sf.getClasses()) {
      const classDecs = cls.getDecorators();
      const ctrlDec = classDecs.find(
        (d) => getDecoratorShortName(d) === "Controller",
      );
      if (!ctrlDec) continue;

      const controllerName = cls.getName() ?? "AnonymousController";
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
                controller: controllerName,
                location: nodeToLocation(pathProp),
              });
            }
          }
        } else {
          const parsed = extractStringOrArrayLiterals(ctrlArg0);
          if (parsed.computed) {
            unknowns.push({
              kind: "computed-route",
              reason: `Controller "${controllerName}" uses computed route prefix "${ctrlArg0.getText()}".`,
              controller: controllerName,
              location: nodeToLocation(ctrlArg0),
            });
          }
        }
      }

      const controllerVersions = extractControllerVersion(cls);

      for (const method of cls.getMethods()) {
        const methodDecs = method.getDecorators();
        const handlerName = method.getName();
        let hasHttpDecorator = false;

        for (const dec of methodDecs) {
          const short = getDecoratorShortName(dec);
          if (HTTP_METHOD_DECORATORS[short]) {
            hasHttpDecorator = true;
            const arg0 = dec.getArguments()[0] as Expression | undefined;
            if (arg0) {
              const parsed = extractStringOrArrayLiterals(arg0);
              if (parsed.computed) {
                unknowns.push({
                  kind: "computed-route",
                  reason: `Handler "${controllerName}.${handlerName}" uses computed route path "${arg0.getText()}".`,
                  controller: controllerName,
                  handler: handlerName,
                  location: nodeToLocation(arg0),
                });
              }
            }
          } else if (short === "RequestMapping") {
            hasHttpDecorator = true;
            const arg0 = dec.getArguments()[0] as Expression | undefined;
            const pathExpr = getObjectProp(arg0, "path");
            if (pathExpr) {
              const parsed = extractStringOrArrayLiterals(pathExpr);
              if (parsed.computed) {
                unknowns.push({
                  kind: "computed-route",
                  reason: `Handler "${controllerName}.${handlerName}" uses computed RequestMapping path "${pathExpr.getText()}".`,
                  controller: controllerName,
                  handler: handlerName,
                  location: nodeToLocation(pathExpr),
                });
              }
            }
          }
        }

        if (!hasHttpDecorator) continue;
        const effectiveVersions =
          extractVersionValues(methodDecs) ?? controllerVersions;
        if (effectiveVersions && effectiveVersions.length > 0) {
          versionsByHandler.set(
            `${filePath}::${controllerName}::${handlerName}`,
            effectiveVersions,
          );
        }
      }
    }
  }

  return { versionsByHandler, unknowns };
}

function normalizeEntry(entry: RouteManifestEntry): RouteManifestEntry {
  const method = entry.method.trim().toUpperCase();
  const path = normalizeRoutePath(entry.path);
  const version =
    entry.version !== undefined && entry.version.trim().length > 0
      ? entry.version.trim()
      : undefined;
  return {
    method,
    path,
    ...(version !== undefined ? { version } : {}),
    ...(entry.controller ? { controller: entry.controller } : {}),
    ...(entry.handler ? { handler: entry.handler } : {}),
    ...(entry.sourceFile ? { sourceFile: entry.sourceFile } : {}),
    ...(entry.body !== undefined ? { body: entry.body } : {}),
  };
}

function splitPathSegments(path: string): string[] {
  const normalized = normalizeRoutePath(path);
  if (normalized === "/") return [];
  return normalized.slice(1).split("/");
}

function buildStructuralPath(path: string): string {
  const segs = splitPathSegments(path);
  if (segs.length === 0) return "/";
  return `/${segs.map((s) => (s.startsWith(":") ? ":" : s)).join("/")}`;
}

function computeParamRenames(
  fromPath: string,
  toPath: string,
): RouteParamRenameDetail[] {
  const fromSegs = splitPathSegments(fromPath);
  const toSegs = splitPathSegments(toPath);
  if (fromSegs.length !== toSegs.length) return [];

  const renames: RouteParamRenameDetail[] = [];
  for (let i = 0; i < fromSegs.length; i++) {
    const a = fromSegs[i]!;
    const b = toSegs[i]!;
    if (a.startsWith(":") && b.startsWith(":") && a !== b) {
      renames.push({
        segmentIndex: i,
        from: a.slice(1),
        to: b.slice(1),
      });
    }
  }
  return renames;
}

function routeSortKey(entry: RouteManifestEntry): string {
  return `${entry.method} ${entry.path} ${entry.version ?? ""}`;
}

function sortEntries(entries: readonly RouteManifestEntry[]): RouteManifestEntry[] {
  return [...entries].sort((a, b) =>
    routeSortKey(a).localeCompare(routeSortKey(b)),
  );
}

/**
 * Compares a base route manifest against the current route list, classifying
 * added routes, removed routes, parameter renames (e.g. `:id` -> `:orderId`),
 * version changes, and statically unresolvable/dynamic routes.
 */
export function diffRouteManifests(
  baseRoutes: readonly RouteManifestEntry[],
  currentRoutes: readonly RouteManifestEntry[],
  unknowns: readonly RouteDiffUnknown[] = [],
): RouteDiffReport {
  const normalizedBase = baseRoutes.map(normalizeEntry);
  const normalizedCurrent = currentRoutes.map(normalizeEntry);

  const matchedBase = new Set<number>();
  const matchedCurrent = new Set<number>();

  // 1. Exact matches (method + path + version)
  const currentExactBuckets = new Map<string, number[]>();
  for (let i = 0; i < normalizedCurrent.length; i++) {
    const key = routeSortKey(normalizedCurrent[i]!);
    const bucket = currentExactBuckets.get(key);
    if (bucket) {
      bucket.push(i);
    } else {
      currentExactBuckets.set(key, [i]);
    }
  }

  for (let bi = 0; bi < normalizedBase.length; bi++) {
    const key = routeSortKey(normalizedBase[bi]!);
    const bucket = currentExactBuckets.get(key);
    if (bucket && bucket.length > 0) {
      const ci = bucket.shift()!;
      matchedBase.add(bi);
      matchedCurrent.add(ci);
    }
  }

  // 2. Parameter renames (same method + structural path + version, different param name(s))
  const paramRenamed: RouteParamRenameEntry[] = [];
  const currentStructBuckets = new Map<string, number[]>();
  for (let ci = 0; ci < normalizedCurrent.length; ci++) {
    if (matchedCurrent.has(ci)) continue;
    const cur = normalizedCurrent[ci]!;
    const key = `${cur.method} ${buildStructuralPath(cur.path)} ${cur.version ?? ""}`;
    const bucket = currentStructBuckets.get(key);
    if (bucket) {
      bucket.push(ci);
    } else {
      currentStructBuckets.set(key, [ci]);
    }
  }

  for (let bi = 0; bi < normalizedBase.length; bi++) {
    if (matchedBase.has(bi)) continue;
    const base = normalizedBase[bi]!;
    const key = `${base.method} ${buildStructuralPath(base.path)} ${base.version ?? ""}`;
    const bucket = currentStructBuckets.get(key);
    if (!bucket || bucket.length === 0) continue;

    const matchIdx = bucket.findIndex((ci) => {
      const cur = normalizedCurrent[ci]!;
      return computeParamRenames(base.path, cur.path).length > 0;
    });
    if (matchIdx === -1) continue;

    const ci = bucket.splice(matchIdx, 1)[0]!;
    const cur = normalizedCurrent[ci]!;
    matchedBase.add(bi);
    matchedCurrent.add(ci);
    paramRenamed.push({
      method: base.method,
      fromPath: base.path,
      toPath: cur.path,
      ...(base.version !== undefined ? { version: base.version } : {}),
      paramRenames: computeParamRenames(base.path, cur.path),
      base,
      current: cur,
    });
  }

  // 3. Version changes (same method + path, different version)
  const versionChanged: RouteVersionChangeEntry[] = [];
  const currentPathBuckets = new Map<string, number[]>();
  for (let ci = 0; ci < normalizedCurrent.length; ci++) {
    if (matchedCurrent.has(ci)) continue;
    const cur = normalizedCurrent[ci]!;
    const key = `${cur.method} ${cur.path}`;
    const bucket = currentPathBuckets.get(key);
    if (bucket) {
      bucket.push(ci);
    } else {
      currentPathBuckets.set(key, [ci]);
    }
  }

  for (let bi = 0; bi < normalizedBase.length; bi++) {
    if (matchedBase.has(bi)) continue;
    const base = normalizedBase[bi]!;
    const key = `${base.method} ${base.path}`;
    const bucket = currentPathBuckets.get(key);
    if (!bucket || bucket.length === 0) continue;

    const ci = bucket.shift()!;
    const cur = normalizedCurrent[ci]!;
    matchedBase.add(bi);
    matchedCurrent.add(ci);
    versionChanged.push({
      method: base.method,
      path: base.path,
      ...(base.version !== undefined ? { fromVersion: base.version } : {}),
      ...(cur.version !== undefined ? { toVersion: cur.version } : {}),
      base,
      current: cur,
    });
  }

  // 4. Remaining unmatched routes -> removed / added
  const removed = sortEntries(
    normalizedBase.filter((_, idx) => !matchedBase.has(idx)),
  );
  const added = sortEntries(
    normalizedCurrent.filter((_, idx) => !matchedCurrent.has(idx)),
  );

  paramRenamed.sort((a, b) =>
    `${a.method} ${a.fromPath}`.localeCompare(`${b.method} ${b.fromPath}`),
  );
  versionChanged.sort((a, b) =>
    `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
  );

  const hasChanges =
    added.length > 0 ||
    removed.length > 0 ||
    paramRenamed.length > 0 ||
    versionChanged.length > 0 ||
    unknowns.length > 0;

  return {
    schemaVersion: "1.0",
    hasChanges,
    summary: {
      baseCount: normalizedBase.length,
      currentCount: normalizedCurrent.length,
      added: added.length,
      removed: removed.length,
      paramRenamed: paramRenamed.length,
      versionChanged: versionChanged.length,
      unknowns: unknowns.length,
    },
    added,
    removed,
    paramRenamed,
    versionChanged,
    unknowns: [...unknowns],
  };
}

function extractBodyPayloadFromRawRoute(
  rec: Record<string, unknown>,
): BodyContractPayload | undefined {
  const rawBody = rec.body;
  if (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)) {
    return rawBody as BodyContractPayload;
  }
  if (
    Array.isArray(rec.fields) ||
    Array.isArray(rec.unsupportedReasons) ||
    typeof rec.dtoName === "string"
  ) {
    return {
      ...(typeof rec.dtoName === "string" ? { dtoName: rec.dtoName } : {}),
      ...(typeof rec.dtoSourceFile === "string"
        ? { dtoSourceFile: rec.dtoSourceFile }
        : {}),
      ...(rec.dtoLocation &&
      typeof rec.dtoLocation === "object" &&
      !Array.isArray(rec.dtoLocation)
        ? {
            dtoLocation: rec.dtoLocation as BodyContractPayload["dtoLocation"],
          }
        : {}),
      ...(Array.isArray(rec.fields)
        ? { fields: rec.fields as BodyContractPayload["fields"] }
        : {}),
      ...(Array.isArray(rec.unsupportedReasons)
        ? {
            unsupportedReasons:
              rec.unsupportedReasons as BodyContractPayload["unsupportedReasons"],
          }
        : {}),
    };
  }
  return undefined;
}

interface ParsedRouteManifestDocument {
  readonly routes: RouteManifestEntry[];
  readonly commit?: string;
  readonly bodyMetadataIncluded: boolean;
}

function parseRouteManifestEntriesFromParsed(
  parsed: unknown,
): RouteManifestEntry[] {
  const rawList = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { routes?: unknown }).routes)
      ? (parsed as { routes: unknown[] }).routes
      : null;

  if (!rawList) {
    throw new Error(
      'Invalid route manifest JSON: expected an array of routes or an object with a "routes" array.',
    );
  }

  const out: RouteManifestEntry[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    if (!item || typeof item !== "object") {
      throw new Error(`Invalid route entry at index ${i}: expected an object.`);
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.method !== "string" || typeof rec.path !== "string") {
      throw new Error(
        `Invalid route entry at index ${i}: "method" and "path" must be strings.`,
      );
    }
    const controller =
      typeof rec.controller === "string"
        ? rec.controller
        : typeof rec.controllerName === "string"
          ? rec.controllerName
          : undefined;
    const handler =
      typeof rec.handler === "string"
        ? rec.handler
        : typeof rec.handlerName === "string"
          ? rec.handlerName
          : undefined;
    const sourceFile =
      typeof rec.sourceFile === "string" ? rec.sourceFile : undefined;
    const body = extractBodyPayloadFromRawRoute(rec);

    if (Array.isArray(rec.version)) {
      const versions = rec.version.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      );
      if (versions.length > 0) {
        for (const v of versions) {
          out.push(
            normalizeEntry({
              method: rec.method,
              path: rec.path,
              version: v,
              controller,
              handler,
              sourceFile,
              ...(body !== undefined ? { body } : {}),
            }),
          );
        }
        continue;
      }
    }

    out.push(
      normalizeEntry({
        method: rec.method,
        path: rec.path,
        version: typeof rec.version === "string" ? rec.version : undefined,
        controller,
        handler,
        sourceFile,
        ...(body !== undefined ? { body } : {}),
      }),
    );
  }

  return out;
}

function parseRouteManifestDocument(
  rawJson: string,
): ParsedRouteManifestDocument {
  const parsed: unknown = JSON.parse(rawJson);
  const routes = parseRouteManifestEntriesFromParsed(parsed);
  const obj =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  const commit =
    typeof obj?.commit === "string" && obj.commit.trim().length > 0
      ? obj.commit.trim()
      : undefined;
  const bodyMetadataIncluded =
    obj?.bodyMetadataIncluded === true ||
    routes.some((r) => r.body !== undefined);

  return {
    routes,
    ...(commit !== undefined ? { commit } : {}),
    bodyMetadataIncluded,
  };
}

/**
 * Parses a JSON route manifest file (either `RouteManifestEntry[]` or
 * `{ routes: RouteManifestEntry[] }`).
 */
export function parseRouteManifestJson(rawJson: string): RouteManifestEntry[] {
  return parseRouteManifestEntriesFromParsed(JSON.parse(rawJson));
}

/**
 * Scans current project HTTP routes using `BunestTypegenScanner`, enriched with
 * `@Version` metadata and statically unresolvable/computed route unknowns.
 */
export async function scanProjectRoutes(options: {
  readonly cwd?: string;
  readonly sourceRoot?: string;
  readonly tsconfig?: string;
  readonly config?: string;
  readonly bunestConfig?: BunestConfigLike;
}): Promise<ScanProjectRoutesResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const loaded = await loadCliConfiguration(cwd, options.config);
  const bunestConfig =
    options.bunestConfig ?? (await loadBunestConfig(cwd)).config;
  const sourceRoot =
    options.sourceRoot ??
    bunestConfig.typegen?.sourceRoot ??
    loaded.config.sourceRoot ??
    "src";

  const scanner = new BunestTypegenScanner({
    cwd,
    sourceRoot,
    tsconfigPath: options.tsconfig,
    include: ["routes"],
  });
  const scanResult = scanner.scan();
  const { versionsByHandler, unknowns } = collectRouteVersionsAndUnknowns(
    scanner.getTrackedSourceFiles(),
  );

  const routes: RouteManifestEntry[] = [];
  for (const r of scanResult.routes as readonly ExtractedRouteEntry[]) {
    const relSource = relative(cwd, r.sourceFile).replace(/\\/g, "/");
    const handlerKey = `${r.sourceFile}::${r.controllerName}::${r.handlerName}`;
    const versions = versionsByHandler.get(handlerKey);
    if (versions && versions.length > 0) {
      for (const version of versions) {
        routes.push(
          normalizeEntry({
            method: r.method,
            path: r.path,
            version,
            controller: r.controllerName,
            handler: r.handlerName,
            sourceFile: relSource,
          }),
        );
      }
    } else {
      routes.push(
        normalizeEntry({
          method: r.method,
          path: r.path,
          controller: r.controllerName,
          handler: r.handlerName,
          sourceFile: relSource,
        }),
      );
    }
  }

  return {
    routes: sortEntries(routes),
    unknowns,
  };
}

function toBodyContractPayload(
  scanned: ScannedRouteBodyContract,
): BodyContractPayload {
  return {
    dtoName: scanned.dtoName,
    ...(scanned.dtoSourceFile !== undefined
      ? { dtoSourceFile: scanned.dtoSourceFile }
      : {}),
    ...(scanned.dtoLocation !== undefined
      ? {
          dtoLocation: {
            filePath: scanned.dtoLocation.file,
            sourceFile: scanned.dtoLocation.file,
            line: scanned.dtoLocation.line,
          },
        }
      : {}),
    fields: scanned.fields,
    unsupportedReasons: scanned.unsupportedReasons,
  };
}

function attachBodyContractsToRoutes(
  routes: readonly RouteManifestEntry[],
  scannedBodyRoutes: readonly ScannedRouteBodyContract[],
): RouteManifestEntry[] {
  const byExactKey = new Map<string, BodyContractPayload>();
  const byMethodPath = new Map<string, BodyContractPayload>();

  for (const scanned of scannedBodyRoutes) {
    const method = scanned.method.trim().toUpperCase();
    const path = normalizeRoutePath(scanned.path);
    const version = scanned.version?.trim() || "";
    const payload = toBodyContractPayload(scanned);
    byExactKey.set(`${method} ${path} ${version}`, payload);
    if (!byMethodPath.has(`${method} ${path}`)) {
      byMethodPath.set(`${method} ${path}`, payload);
    }
  }

  return routes.map((route) => {
    const exactKey = routeSortKey(route);
    const body =
      byExactKey.get(exactKey) ??
      byMethodPath.get(`${route.method} ${route.path}`);
    return body !== undefined ? { ...route, body } : route;
  });
}

function mapPipeProfile(raw: unknown): PipeProfileInfo | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const name =
    typeof rec.name === "string"
      ? rec.name
      : typeof rec.label === "string"
        ? rec.label
        : undefined;
  const validationPipeApplied =
    typeof rec.validationPipeApplied === "boolean"
      ? rec.validationPipeApplied
      : typeof rec.applied === "boolean"
        ? rec.applied
        : undefined;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(typeof rec.whitelist === "boolean" ? { whitelist: rec.whitelist } : {}),
    ...(typeof rec.forbidNonWhitelisted === "boolean"
      ? { forbidNonWhitelisted: rec.forbidNonWhitelisted }
      : {}),
    ...(typeof rec.transform === "boolean" ? { transform: rec.transform } : {}),
    ...(validationPipeApplied !== undefined ? { validationPipeApplied } : {}),
  };
}

const VALID_REPLAY_VERDICTS = new Set<ReplayVerdict>([
  "confirmed-breaking",
  "stripped-accepted",
  "no-http-change",
  "environment-error",
]);

interface ParsedEvidenceFile {
  readonly records: DiffReplayEvidenceRecord[];
  readonly inferredBaseCommit?: string;
  readonly inferredHeadCommit?: string;
  readonly pipeProfile?: PipeProfileInfo;
  readonly sampleValues?: Record<string, unknown>;
}

function parseReplayEvidenceJson(rawJson: string): ParsedEvidenceFile {
  const parsed: unknown = JSON.parse(rawJson);
  const envelope =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;

  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(envelope?.records)
      ? envelope.records
      : Array.isArray(envelope?.evidence)
        ? envelope.evidence
        : null;

  if (!rawList) {
    throw new Error(
      'Invalid replay evidence JSON: expected an array of evidence records or an object with a "records" or "evidence" array.',
    );
  }

  const envelopeBaseCommit =
    typeof envelope?.baseCommit === "string" &&
    envelope.baseCommit.trim().length > 0
      ? envelope.baseCommit.trim()
      : undefined;
  const envelopeHeadCommit =
    typeof envelope?.headCommit === "string" &&
    envelope.headCommit.trim().length > 0
      ? envelope.headCommit.trim()
      : undefined;
  const envelopePipeProfile = mapPipeProfile(envelope?.pipeProfile);
  const envelopeSampleValues =
    envelope?.sampleValues &&
    typeof envelope.sampleValues === "object" &&
    !Array.isArray(envelope.sampleValues)
      ? (envelope.sampleValues as Record<string, unknown>)
      : undefined;

  const records: DiffReplayEvidenceRecord[] = [];
  const inferredSamples: Record<string, unknown> = {};
  let firstBaseCommit: string | undefined = envelopeBaseCommit;
  let firstHeadCommit: string | undefined = envelopeHeadCommit;
  let inferredPipeProfile: PipeProfileInfo | undefined = envelopePipeProfile;

  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(
        `Invalid replay evidence entry at index ${i}: expected an object.`,
      );
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.method !== "string" || typeof rec.path !== "string") {
      throw new Error(
        `Invalid replay evidence entry at index ${i}: "method" and "path" must be strings.`,
      );
    }

    const baseCommit =
      typeof rec.baseCommit === "string" && rec.baseCommit.trim().length > 0
        ? rec.baseCommit.trim()
        : (envelopeBaseCommit ?? "");
    const headCommit =
      typeof rec.headCommit === "string" && rec.headCommit.trim().length > 0
        ? rec.headCommit.trim()
        : (envelopeHeadCommit ?? "");

    if (!firstBaseCommit && baseCommit) firstBaseCommit = baseCommit;
    if (!firstHeadCommit && headCommit) firstHeadCommit = headCommit;

    const pipeProfile = mapPipeProfile(rec.pipeProfile);
    if (!inferredPipeProfile && pipeProfile && Object.keys(pipeProfile).length > 0) {
      inferredPipeProfile = pipeProfile;
    }

    const verdict: ReplayVerdict =
      typeof rec.verdict === "string" &&
      VALID_REPLAY_VERDICTS.has(rec.verdict as ReplayVerdict)
        ? (rec.verdict as ReplayVerdict)
        : "environment-error";

    const targetField =
      typeof rec.targetField === "string" ? rec.targetField : undefined;

    if (
      targetField &&
      rec.payload &&
      typeof rec.payload === "object" &&
      !Array.isArray(rec.payload)
    ) {
      for (const [k, v] of Object.entries(
        rec.payload as Record<string, unknown>,
      )) {
        if (k !== targetField && !(k in inferredSamples)) {
          inferredSamples[k] = v;
        }
      }
    }

    records.push({
      method: rec.method,
      path: rec.path,
      ...(typeof rec.version === "string" ? { version: rec.version } : {}),
      payload: rec.payload,
      ...(targetField !== undefined ? { targetField } : {}),
      baseCommit,
      headCommit,
      baseStatus: typeof rec.baseStatus === "number" ? rec.baseStatus : 0,
      headStatus: typeof rec.headStatus === "number" ? rec.headStatus : 0,
      ...(Array.isArray(rec.baseErrorFields)
        ? {
            baseErrorFields: rec.baseErrorFields.filter(
              (f): f is string => typeof f === "string",
            ),
          }
        : {}),
      ...(Array.isArray(rec.headErrorFields)
        ? {
            headErrorFields: rec.headErrorFields.filter(
              (f): f is string => typeof f === "string",
            ),
          }
        : {}),
      ...(pipeProfile !== undefined ? { pipeProfile } : {}),
      verdict,
      ...(typeof rec.environmentError === "string"
        ? { environmentError: rec.environmentError }
        : {}),
    });
  }

  const mergedSamples =
    envelopeSampleValues !== undefined
      ? { ...inferredSamples, ...envelopeSampleValues }
      : Object.keys(inferredSamples).length > 0
        ? inferredSamples
        : undefined;

  return {
    records,
    ...(firstBaseCommit !== undefined
      ? { inferredBaseCommit: firstBaseCommit }
      : {}),
    ...(firstHeadCommit !== undefined
      ? { inferredHeadCommit: firstHeadCommit }
      : {}),
    ...(inferredPipeProfile !== undefined
      ? { pipeProfile: inferredPipeProfile }
      : {}),
    ...(mergedSamples !== undefined ? { sampleValues: mergedSamples } : {}),
  };
}

/**
 * Runs `bunest routes snapshot [--out <file>] [--body] [--commit <sha>]`,
 * scanning project routes (and optional `@Body()` DTO validation contracts)
 * and emitting a deterministic JSON manifest.
 */
export async function runRoutesSnapshotCommand(
  options: RoutesSnapshotCommandOptions = {},
  io?: CliIO,
): Promise<RoutesSnapshotCommandResult> {
  const cwd = resolve(options.cwd ?? io?.cwd ?? process.cwd());
  const loaded = await loadCliConfiguration(cwd, options.config);
  const bunestConfig =
    options.bunestConfig ?? (await loadBunestConfig(cwd)).config;
  const sourceRoot =
    options.sourceRoot ??
    bunestConfig.typegen?.sourceRoot ??
    loaded.config.sourceRoot ??
    "src";

  const scanned = await scanProjectRoutes({
    cwd,
    sourceRoot,
    tsconfig: options.tsconfig,
    config: options.config,
    bunestConfig,
  });

  let routes: readonly RouteManifestEntry[] = scanned.routes;
  if (options.body) {
    const bodyScan = await scanRouteBodyContracts(cwd, { sourceRoot });
    routes = attachBodyContractsToRoutes(scanned.routes, bodyScan.routes);
  }

  const commit =
    options.commit !== undefined && options.commit.trim().length > 0
      ? options.commit.trim()
      : undefined;

  const manifest: RouteSnapshotManifest = {
    schemaVersion: "1.0",
    ...(commit !== undefined ? { commit } : {}),
    ...(options.body ? { bodyMetadataIncluded: true } : {}),
    routes,
    unknowns: scanned.unknowns,
  };

  const formatted = JSON.stringify(manifest, null, 2);

  if (options.out) {
    const outPath = resolve(cwd, options.out);
    mkdirSyncPath(dirname(outPath), { recursive: true });
    writeTextSync(outPath, `${formatted}\n`);
    if (io && !options.silent) {
      io.stdout(`Wrote route snapshot to ${outPath}`);
    }
    return {
      exitCode: 0,
      manifest,
      formatted,
      outPath,
    };
  }

  if (io && !options.silent) {
    io.stdout(formatted);
  }

  return {
    exitCode: 0,
    manifest,
    formatted,
  };
}

function formatRouteLabel(entry: {
  readonly method: string;
  readonly path: string;
  readonly version?: string;
}): string {
  return `${entry.method} ${entry.path}${entry.version ? ` (v${entry.version})` : ""}`;
}

export function formatRoutesDiffReport(
  report: RouteDiffReport,
  format: RoutesDiffFormat = "pretty",
  cwd?: string,
): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }

  const lines: string[] = [];
  lines.push(
    `Routes Diff (base: ${report.summary.baseCount}, current: ${report.summary.currentCount})`,
  );

  const hasRouteChanges =
    report.added.length > 0 ||
    report.removed.length > 0 ||
    report.paramRenamed.length > 0 ||
    report.versionChanged.length > 0 ||
    report.unknowns.length > 0;

  if (!hasRouteChanges) {
    lines.push("No route changes detected.");
  } else {
    if (report.added.length > 0) {
      lines.push("", `Added (${report.added.length}):`);
      for (const r of report.added) {
        lines.push(`  + ${formatRouteLabel(r)}`);
      }
    }

    if (report.removed.length > 0) {
      lines.push("", `Removed (${report.removed.length}):`);
      for (const r of report.removed) {
        lines.push(`  - ${formatRouteLabel(r)}`);
      }
    }

    if (report.paramRenamed.length > 0) {
      lines.push("", `Param Renamed (${report.paramRenamed.length}):`);
      for (const r of report.paramRenamed) {
        const renames = r.paramRenames
          .map((p) => `:${p.from} -> :${p.to}`)
          .join(", ");
        const ver = r.version ? ` (v${r.version})` : "";
        lines.push(
          `  ~ ${r.method} ${r.fromPath} -> ${r.toPath}${ver} [${renames}]`,
        );
      }
    }

    if (report.versionChanged.length > 0) {
      lines.push("", `Version Changed (${report.versionChanged.length}):`);
      for (const r of report.versionChanged) {
        const fromVer = r.fromVersion ? `v${r.fromVersion}` : "unversioned";
        const toVer = r.toVersion ? `v${r.toVersion}` : "unversioned";
        lines.push(`  ~ ${r.method} ${r.path}: ${fromVer} -> ${toVer}`);
      }
    }

    if (report.unknowns.length > 0) {
      lines.push("", `Unknown / Dynamic Routes (${report.unknowns.length}):`);
      for (const u of report.unknowns) {
        const loc = u.location
          ? ` (${(cwd ? relative(cwd, u.location.filePath) : u.location.filePath).replace(/\\/g, "/")}:${u.location.line}:${u.location.column})`
          : "";
        lines.push(`  ? [${u.kind}] ${u.reason}${loc}`);
      }
    }
  }

  if (report.bodyDiff) {
    lines.push("", "Body Contract Diff:", formatBodyContractDiffPretty(report.bodyDiff));
  }

  return lines.join("\n");
}

/**
 * Runs `bunest routes diff`, comparing either two JSON manifests
 * (`<base.json> <head.json>`) or a base manifest against current static-scanned
 * project routes (`--base <manifest>`), with optional `--body` DTO contract
 * diffing and `--evidence <file.json>` replay verification.
 */
export async function runRoutesDiffCommand(
  options: RoutesDiffCommandOptions,
  io?: CliIO,
): Promise<RoutesDiffCommandResult> {
  const cwd = resolve(options.cwd ?? io?.cwd ?? process.cwd());
  const basePath = resolve(cwd, options.base);
  const format = options.format ?? "pretty";

  if (!existsSyncPath(basePath)) {
    const msg = `Base route manifest not found: ${basePath}`;
    if (io && !options.silent) io.stderr(msg);
    return { exitCode: 1, formatted: msg };
  }

  let baseDoc: ParsedRouteManifestDocument;
  try {
    baseDoc = parseRouteManifestDocument(readTextSync(basePath));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (io && !options.silent) io.stderr(`Error reading base manifest: ${msg}`);
    return { exitCode: 1, formatted: msg };
  }

  let headRoutes: readonly RouteManifestEntry[];
  let headUnknowns: readonly RouteDiffUnknown[] = [];
  let headCommitFromDoc: string | undefined;
  let headBodyMetadataIncluded = false;

  if (options.head) {
    const headPath = resolve(cwd, options.head);
    if (!existsSyncPath(headPath)) {
      const msg = `Head route manifest not found: ${headPath}`;
      if (io && !options.silent) io.stderr(msg);
      return { exitCode: 1, formatted: msg };
    }
    try {
      const headDoc = parseRouteManifestDocument(readTextSync(headPath));
      headRoutes = headDoc.routes;
      headCommitFromDoc = headDoc.commit;
      headBodyMetadataIncluded = headDoc.bodyMetadataIncluded;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (io && !options.silent) {
        io.stderr(`Error reading head manifest: ${msg}`);
      }
      return { exitCode: 1, formatted: msg };
    }
  } else {
    const loaded = await loadCliConfiguration(cwd, options.config);
    const bunestConfig =
      options.bunestConfig ?? (await loadBunestConfig(cwd)).config;
    const sourceRoot =
      options.sourceRoot ??
      bunestConfig.typegen?.sourceRoot ??
      loaded.config.sourceRoot ??
      "src";

    const current = await scanProjectRoutes({
      cwd,
      sourceRoot,
      tsconfig: options.tsconfig,
      config: options.config,
      bunestConfig,
    });
    headRoutes = current.routes;
    headUnknowns = current.unknowns;

    if (options.body) {
      const bodyScan = await scanRouteBodyContracts(cwd, { sourceRoot });
      headRoutes = attachBodyContractsToRoutes(current.routes, bodyScan.routes);
      headBodyMetadataIncluded = true;
    }
  }

  let parsedEvidence: ParsedEvidenceFile | undefined;
  if (options.evidence) {
    const evidencePath = resolve(cwd, options.evidence);
    if (!existsSyncPath(evidencePath)) {
      const msg = `Replay evidence file not found: ${evidencePath}`;
      if (io && !options.silent) io.stderr(msg);
      return { exitCode: 1, formatted: msg };
    }
    try {
      parsedEvidence = parseReplayEvidenceJson(readTextSync(evidencePath));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (io && !options.silent) {
        io.stderr(`Error reading replay evidence: ${msg}`);
      }
      return { exitCode: 1, formatted: msg };
    }
  }

  const baseReport = diffRouteManifests(baseDoc.routes, headRoutes, headUnknowns);
  let report: RouteDiffReport = baseReport;

  if (options.body) {
    let baseBodyRoutes: readonly RouteBodyContract[];
    let headBodyRoutes: readonly RouteBodyContract[];

    if (baseDoc.bodyMetadataIncluded && headBodyMetadataIncluded) {
      const keysWithBody = new Set<string>();
      for (const r of baseDoc.routes) {
        if (r.body !== undefined) keysWithBody.add(routeSortKey(r));
      }
      for (const r of headRoutes) {
        if (r.body !== undefined) keysWithBody.add(routeSortKey(r));
      }
      baseBodyRoutes = baseDoc.routes.filter((r) =>
        keysWithBody.has(routeSortKey(r)),
      );
      headBodyRoutes = headRoutes.filter((r) =>
        keysWithBody.has(routeSortKey(r)),
      );
    } else {
      baseBodyRoutes = baseDoc.routes;
      headBodyRoutes = headRoutes;
    }

    const hasAuthoritativeCommit =
      options.baseCommit !== undefined ||
      options.headCommit !== undefined ||
      baseDoc.commit !== undefined ||
      headCommitFromDoc !== undefined;
    const resolvedBaseCommit = hasAuthoritativeCommit
      ? (options.baseCommit ?? baseDoc.commit)
      : parsedEvidence?.inferredBaseCommit;
    const resolvedHeadCommit = hasAuthoritativeCommit
      ? (options.headCommit ?? headCommitFromDoc)
      : parsedEvidence?.inferredHeadCommit;

    const mergedSampleValues =
      options.sampleValues !== undefined ||
      parsedEvidence?.sampleValues !== undefined
        ? {
            ...(parsedEvidence?.sampleValues ?? {}),
            ...(options.sampleValues ?? {}),
          }
        : undefined;

    const bodyDiff = diffBodyContracts(baseBodyRoutes, headBodyRoutes, {
      ...(parsedEvidence !== undefined
        ? { replayEvidence: parsedEvidence.records }
        : {}),
      ...(resolvedBaseCommit !== undefined
        ? { baseCommit: resolvedBaseCommit }
        : {}),
      ...(resolvedHeadCommit !== undefined
        ? { headCommit: resolvedHeadCommit }
        : {}),
      ...(options.pipeProfile ?? parsedEvidence?.pipeProfile
        ? { pipeProfile: options.pipeProfile ?? parsedEvidence?.pipeProfile }
        : {}),
      ...(mergedSampleValues !== undefined
        ? { sampleValues: mergedSampleValues }
        : {}),
    });

    report = {
      ...baseReport,
      hasChanges: baseReport.hasChanges || bodyDiff.staticFindings.length > 0,
      bodyDiff,
    };
  }

  const formatted = formatRoutesDiffReport(report, format, cwd);

  if (io && !options.silent) {
    io.stdout(formatted);
  }

  return {
    exitCode: 0,
    report,
    formatted,
  };
}
