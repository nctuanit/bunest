import { cond } from "@bunest/core/common";
import {
  dirname,
  existsSyncPath,
  join,
  readDirSyncNames,
  readTextSync,
  resolve,
  statSyncPath,
} from "@bunest/core";
import * as vscode from "vscode";
import type { ExtractedRouteEntry } from "@bunest/cli";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

export interface RouteParamSpec {
  readonly name: string;
  readonly location: "path" | "query" | "header";
  readonly type: string;
  readonly required: boolean;
  readonly defaultValue: string;
  readonly description?: string;
  readonly enumValues?: readonly string[];
}

export interface DtoFieldSpec {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "array" | "object" | "enum";
  readonly rawType: string;
  readonly required: boolean;
  readonly example: unknown;
  readonly description?: string;
  readonly constraints: readonly string[];
  readonly enumValues?: readonly string[];
}

export interface ExtractedRouteSchema {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly controllerName: string;
  readonly handlerName: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly isGuarded: boolean;
  readonly pathParams: readonly RouteParamSpec[];
  readonly queryParams: readonly RouteParamSpec[];
  readonly headerParams: readonly RouteParamSpec[];
  readonly bodyTypeName?: string;
  readonly bodyFields: readonly DtoFieldSpec[];
  readonly bodySampleJson: string;
  readonly responseTypeText: string;
}

function readSourceSafe(filePath: string): string | undefined {
  // Prefer open editor buffer (includes unsaved edits)
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === "file" && doc.uri.fsPath === filePath) {
      return doc.getText();
    }
  }
  try {
    if (existsSyncPath(filePath)) {
      return readTextSync(filePath);
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Resolves a TypeScript import specifier relative to `fromFile` (`.ts`, `/index.ts`).
 */
function resolveRelativeTsFile(
  fromFile: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ];
  for (const c of candidates) {
    if (existsSyncPath(c)) return c;
  }
  return undefined;
}

/**
 * Extracts a balanced `{ ... }` block starting at `openBraceIdx`.
 */
function extractBalancedBlock(
  source: string,
  openBraceIdx: number,
): string | undefined {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openBraceIdx; i < source.length; i++) {
    const ch = source[i]!;
    if (quote !== null) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(openBraceIdx + 1, i);
      }
    }
  }
  return undefined;
}

/**
 * Finds the body `{ ... }` of a `class Name`, `interface Name`, or `type Name = { ... }`
 * inside a source file.
 */
function findTypeDefinitionInSource(
  source: string,
  typeName: string,
): string | undefined {
  const escaped = typeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\b(?:export\\s+)?(?:abstract\\s+)?class\\s+${escaped}\\b[^{]*\\{`),
    new RegExp(`\\b(?:export\\s+)?interface\\s+${escaped}\\b[^{]*\\{`),
    new RegExp(`\\b(?:export\\s+)?type\\s+${escaped}\\b\\s*=\\s*\\{`),
  ];
  for (const re of patterns) {
    const m = re.exec(source);
    if (m) {
      const openIdx = m.index + m[0].length - 1;
      const body = extractBalancedBlock(source, openIdx);
      if (body !== undefined) return body;
    }
  }
  return undefined;
}

/**
 * Searches the controller file, its relative imports, open editor buffers,
 * and workspace `src/` files for a DTO / interface / type definition.
 */
function resolveTypeDefinitionBody(
  typeName: string,
  controllerFile: string | undefined,
  controllerSource: string | undefined,
  index: BunestWorkspaceIndex,
): string | undefined {
  const cleanName = typeName
    .replace(/^Partial<(.+)>$/, "$1")
    .replace(/^Required<(.+)>$/, "$1")
    .replace(/^Readonly<(.+)>$/, "$1")
    .replace(/<.*>$/, "")
    .replace(/\[\]$/, "")
    .trim();
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(cleanName)) return undefined;

  // 1. Same file as controller
  if (controllerSource) {
    const local = findTypeDefinitionInSource(controllerSource, cleanName);
    if (local !== undefined) return local;
  }

  // 2. Follow explicit import statements in controller file
  if (controllerFile && controllerSource) {
    const importRe =
      /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(controllerSource)) !== null) {
      const names = m[1]!.split(",").map((s) =>
        s
          .replace(/\btype\b/g, "")
          .split(/\bas\b/)[0]!
          .trim(),
      );
      if (!names.includes(cleanName)) continue;
      const resolved = resolveRelativeTsFile(controllerFile, m[2]!);
      if (resolved) {
        const importedSrc = readSourceSafe(resolved);
        if (importedSrc) {
          const found = findTypeDefinitionInSource(importedSrc, cleanName);
          if (found !== undefined) return found;
        }
      }
    }
  }

  // 3. Open editor documents
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== "file") continue;
    const found = findTypeDefinitionInSource(doc.getText(), cleanName);
    if (found !== undefined) return found;
  }

  // 4. Scan workspace project directories (dto / types / model files first)
  const visited = new Set<string>();
  const scanDir = (dir: string, depth: number): string | undefined => {
    if (depth > 5) return undefined;
    let entries: string[];
    try {
      entries = readDirSyncNames(dir);
    } catch {
      return undefined;
    }
    for (const name of entries) {
      if (
        name === "node_modules" ||
        name === "dist" ||
        name === ".git" ||
        name === ".bunest"
      ) {
        continue;
      }
      const full = join(dir, name);
      if (visited.has(full)) continue;
      visited.add(full);
      try {
        const st = statSyncPath(full);
        if (st.isDirectory()) {
          const res = scanDir(full, depth + 1);
          if (res !== undefined) return res;
        } else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".spec.ts")) {
          const text = readSourceSafe(full);
          if (text && text.includes(cleanName)) {
            const found = findTypeDefinitionInSource(text, cleanName);
            if (found !== undefined) return found;
          }
        }
      } catch {
        // ignore
      }
    }
    return undefined;
  };

  for (const ctx of index.getAllContexts()) {
    const found = scanDir(ctx.sourceRoot || ctx.cwd, 0);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Parses a DTO class or interface body into structured Swagger-grade fields
 * (types, required flags, examples, descriptions, enums, validation constraints).
 */
export function parseDtoFields(classBody: string): DtoFieldSpec[] {
  const fields: DtoFieldSpec[] = [];
  const lines = classBody.split(/\r?\n/);
  let pendingDecorators: string[] = [];
  let pendingComment = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/**")) {
      const cleaned = line
        .replace(/^\/\*\*?/, "")
        .replace(/\*\/$/, "")
        .replace(/^\*/, "")
        .replace(/^\/\//, "")
        .trim();
      if (cleaned) {
        pendingComment = pendingComment ? `${pendingComment} ${cleaned}` : cleaned;
      }
      continue;
    }
    if (line.startsWith("@")) {
      pendingDecorators.push(line);
      continue;
    }

    // Skip method declarations inside class
    if (/^(?:public|private|protected|async|static)?\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(line)) {
      pendingDecorators = [];
      pendingComment = "";
      continue;
    }

    const fieldMatch =
      /^(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*([!?])?\s*:\s*([^;=]+?)(?:\s*=\s*([^;]+))?;?$/.exec(
        line,
      );
    if (!fieldMatch) {
      pendingDecorators = [];
      pendingComment = "";
      continue;
    }

    const name = fieldMatch[1]!;
    const modifier = fieldMatch[2] ?? "";
    const rawType = fieldMatch[3]!.trim();
    const defaultInit = fieldMatch[4]?.trim();
    const decs = pendingDecorators.join(" ");
    const docComment = pendingComment || undefined;
    pendingDecorators = [];
    pendingComment = "";

    const isOptional =
      modifier === "?" ||
      /@IsOptional\b/.test(decs) ||
      /@ApiPropertyOptional\b/.test(decs) ||
      /\bundefined\b/.test(rawType);

    const constraints: string[] = [];
    const minMatch = /@Min\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/.exec(decs);
    const maxMatch = /@Max\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/.exec(decs);
    const minLenMatch = /@MinLength\s*\(\s*(\d+)\s*\)/.exec(decs);
    const maxLenMatch = /@MaxLength\s*\(\s*(\d+)\s*\)/.exec(decs);
    if (minMatch) constraints.push(`min: ${minMatch[1]}`);
    if (maxMatch) constraints.push(`max: ${maxMatch[1]}`);
    if (minLenMatch) constraints.push(`minLength: ${minLenMatch[1]}`);
    if (maxLenMatch) constraints.push(`maxLength: ${maxLenMatch[1]}`);
    if (/@IsEmail\b/.test(decs)) constraints.push("format: email");
    if (/@IsUUID\b/.test(decs)) constraints.push("format: uuid");
    if (/@IsUrl\b/i.test(decs)) constraints.push("format: uri");
    if (/@IsInt\b/.test(decs)) constraints.push("integer");

    // Extract @ApiProperty({ description, example, enum })
    const apiDescMatch = /description\s*:\s*["'`]([^"'`]+)["'`]/.exec(decs);
    const apiExampleStrMatch = /example\s*:\s*["'`]([^"'`]+)["'`]/.exec(decs);
    const apiExampleNumMatch = /example\s*:\s*(-?\d+(?:\.\d+)?)\b/.exec(decs);
    const apiExampleBoolMatch = /example\s*:\s*(true|false)\b/.exec(decs);
    const apiEnumMatch = /enum\s*:\s*\[([^\]]+)\]/.exec(decs);

    // Extract string union literals like `"open" | "closed"`
    const unionLiterals = [...rawType.matchAll(/["']([^"']+)["']/g)].map(
      (m) => m[1]!,
    );
    const enumValues: string[] | undefined = apiEnumMatch
      ? apiEnumMatch[1]!
          .split(",")
          .map((s) => s.trim().replace(/^["'`]|["'`]$/g, ""))
          .filter(Boolean)
      : unionLiterals.length >= 2
        ? unionLiterals
        : undefined;

    let type: DtoFieldSpec["type"] = "string";
    let example: unknown = "example";

    if (enumValues && enumValues.length > 0) {
      type = "enum";
      example = enumValues[0];
    } else if (/@IsBoolean\b/.test(decs) || /^boolean\b/.test(rawType)) {
      type = "boolean";
      example = defaultInit === "false" ? false : true;
    } else if (
      /@IsInt\b|@IsNumber\b/.test(decs) ||
      /^number\b/.test(rawType)
    ) {
      type = "number";
      const minVal = minMatch ? Number(minMatch[1]) : 1;
      example =
        defaultInit && !Number.isNaN(Number(defaultInit))
          ? Number(defaultInit)
          : Math.max(minVal, 1);
    } else if (
      /@IsArray\b/.test(decs) ||
      rawType.endsWith("[]") ||
      /^Array</.test(rawType)
    ) {
      type = "array";
      example = ["example"];
    } else if (
      rawType.startsWith("{") ||
      /^Record</.test(rawType) ||
      /^[A-Z][A-Za-z0-9_]*$/.test(rawType)
    ) {
      type = "object";
      example = {};
    } else {
      type = "string";
      if (/@IsEmail\b/.test(decs) || /email/i.test(name)) {
        example = "user@example.com";
      } else if (/@IsUUID\b/.test(decs) || /uuid/i.test(name)) {
        example = "550e8400-e29b-41d4-a716-446655440000";
      } else if (/password/i.test(name)) {
        example = "P@ssword123!";
      } else if (/name|title/i.test(name)) {
        example = "Sample Item";
      } else if (/desc/i.test(name)) {
        example = "Sample description";
      } else if (defaultInit) {
        example = defaultInit.replace(/^["'`]|["'`]$/g, "");
      } else {
        example = "example";
      }
    }

    if (apiExampleStrMatch) example = apiExampleStrMatch[1];
    else if (apiExampleNumMatch) example = Number(apiExampleNumMatch[1]);
    else if (apiExampleBoolMatch) example = apiExampleBoolMatch[1] === "true";

    fields.push({
      name,
      type,
      rawType,
      required: !isOptional,
      example,
      description: apiDescMatch?.[1] ?? docComment,
      constraints,
      enumValues,
    });
  }

  return fields;
}

export function buildSampleObjectFromFields(
  fields: readonly DtoFieldSpec[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    out[f.name] = f.example;
  }
  return out;
}

/**
 * Splits a top-level comma-separated parameter list from a controller handler.
 */
function splitTopLevelParams(raw: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "(" || ch === "{" || ch === "[" || ch === "<") depth++;
    else if (ch === ")" || ch === "}" || ch === "]" || ch === ">") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * Extracts complete Swagger-grade metadata (Path Params, Query Params, Headers,
 * Body DTO fields, Auth guards, Summary/Tags) for a Bunest route.
 */
export function extractRouteSchema(
  index: BunestWorkspaceIndex,
  route: ExtractedRouteEntry,
): ExtractedRouteSchema {
  const controllerSource = route.sourceFile
    ? readSourceSafe(route.sourceFile)
    : undefined;

  const pathParamsMap = new Map<string, RouteParamSpec>();
  for (const m of route.path.matchAll(/:([A-Za-z0-9_]+)/g)) {
    const name = m[1]!;
    pathParamsMap.set(name, {
      name,
      location: "path",
      type: /id$/i.test(name) ? "number" : "string",
      required: true,
      defaultValue: /id$/i.test(name) ? "1" : "example",
    });
  }

  const queryParamsMap = new Map<string, RouteParamSpec>();
  const headerParamsMap = new Map<string, RouteParamSpec>();
  let summary: string | undefined;
  let description: string | undefined;
  const tags: string[] = [];
  let isGuarded = false;
  let detectedBodyType =
    route.bodyTypeText &&
    route.bodyTypeText !== "unknown" &&
    route.bodyTypeText !== "void"
      ? route.bodyTypeText
      : undefined;

  if (controllerSource) {
    // Check class-level decorators (@ApiTags, @UseGuards, @ApiBearerAuth)
    const ctrlRe = new RegExp(
      `([\\s\\S]{0,600})class\\s+${route.controllerName}\\b`,
    );
    const ctrlMatch = ctrlRe.exec(controllerSource);
    if (ctrlMatch) {
      const ctrlHead = ctrlMatch[1]!;
      if (/@UseGuards\b|@ApiBearerAuth\b|@Roles\b/.test(ctrlHead)) {
        isGuarded = true;
      }
      for (const tm of ctrlHead.matchAll(/@ApiTags\s*\(([^)]+)\)/g)) {
        for (const s of tm[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)) {
          tags.push(s[1]!);
        }
      }
    }

    // Locate handler method around route.location.line
    const lines = controllerSource.split(/\r?\n/);
    const targetLineIdx = Math.max(0, (route.location?.line ?? 1) - 1);
    const startLineIdx = Math.max(0, targetLineIdx - 14);
    const endLineIdx = Math.min(lines.length, targetLineIdx + 20);
    const windowText = lines.slice(startLineIdx, endLineIdx).join("\n");

    if (/@UseGuards\b|@ApiBearerAuth\b|@Roles\b/.test(windowText)) {
      isGuarded = true;
    }
    const opMatch = /@ApiOperation\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(windowText);
    if (opMatch) {
      summary = /summary\s*:\s*["'`]([^"'`]+)["'`]/.exec(opMatch[1]!)?.[1];
      description = /description\s*:\s*["'`]([^"'`]+)["'`]/.exec(
        opMatch[1]!,
      )?.[1];
    }

    // Parse handler signature parameters
    const handlerRe = new RegExp(
      `(?:async\\s+)?${route.handlerName}\\s*\\(([\\s\\S]*?)\\)\\s*(?::|\\{)`,
    );
    const handlerMatch = handlerRe.exec(windowText);
    if (handlerMatch) {
      const paramSegments = splitTopLevelParams(handlerMatch[1]!);
      for (const seg of paramSegments) {
        const cleanDecl = seg
          .replace(/@[A-Za-z_$][A-Za-z0-9_$]*\s*(?:\([^)]*\))?\s*/g, "")
          .trim();
        const declMatch =
          /^([A-Za-z_$][A-Za-z0-9_$]*)\s*(\?)?\s*(?::\s*([^=]+))?(?:\s*=\s*(.+))?$/.exec(
            cleanDecl,
          );
        const varName = declMatch?.[1] ?? "";
        const isOpt = Boolean(declMatch?.[2]) || Boolean(declMatch?.[4]);
        const paramType = declMatch?.[3]?.trim() ?? "string";
        const defVal = declMatch?.[4]?.trim()?.replace(/^["'`]|["'`]$/g, "");

        // @Param("id") or @Param()
        const paramDec = /@Param\s*\(\s*(?:["'`]([^"'`]+)["'`])?/.exec(seg);
        if (paramDec) {
          const pName = paramDec[1] || varName;
          if (pName && pathParamsMap.has(pName)) {
            pathParamsMap.set(pName, {
              name: pName,
              location: "path",
              type: paramType,
              required: true,
              defaultValue: defVal ?? (/number|int/i.test(paramType) ? "1" : "example"),
            });
          } else if (!paramDec[1] && /^[A-Z]/.test(paramType)) {
            const dtoBody = resolveTypeDefinitionBody(
              paramType,
              route.sourceFile,
              controllerSource,
              index,
            );
            if (dtoBody) {
              for (const f of parseDtoFields(dtoBody)) {
                pathParamsMap.set(f.name, {
                  name: f.name,
                  location: "path",
                  type: f.rawType,
                  required: f.required,
                  defaultValue: String(f.example ?? "1"),
                  description: f.description,
                  enumValues: f.enumValues,
                });
              }
            }
          }
          continue;
        }

        // @Query("page") or @Query() query: ListQueryDto
        const queryDec = /@Query\s*\(\s*(?:["'`]([^"'`]+)["'`])?/.exec(seg);
        if (queryDec) {
          if (queryDec[1]) {
            queryParamsMap.set(queryDec[1], {
              name: queryDec[1],
              location: "query",
              type: paramType,
              required: !isOpt,
              defaultValue:
                defVal ??
                cond(
                  [
                    [/number/i.test(paramType), "1"],
                    [/boolean/i.test(paramType), "true"],
                  ],
                  "",
                ),
            });
          } else if (paramType && /^[A-Z{]/.test(paramType)) {
            const dtoBody = paramType.startsWith("{")
              ? paramType.slice(1, -1)
              : resolveTypeDefinitionBody(
                  paramType,
                  route.sourceFile,
                  controllerSource,
                  index,
                );
            if (dtoBody) {
              for (const f of parseDtoFields(dtoBody)) {
                queryParamsMap.set(f.name, {
                  name: f.name,
                  location: "query",
                  type: f.rawType,
                  required: f.required,
                  defaultValue:
                    typeof f.example === "object"
                      ? JSON.stringify(f.example)
                      : String(f.example ?? ""),
                  description: f.description,
                  enumValues: f.enumValues,
                });
              }
            }
          }
          continue;
        }

        // @Headers("x-api-key")
        const headerDec = /@Headers\s*\(\s*(?:["'`]([^"'`]+)["'`])?/.exec(seg);
        if (headerDec && headerDec[1]) {
          headerParamsMap.set(headerDec[1], {
            name: headerDec[1],
            location: "header",
            type: paramType,
            required: !isOpt,
            defaultValue: defVal ?? "",
          });
          continue;
        }

        // @Body() dto: CreateItemDto
        const bodyDec = /@Body\s*\(/.exec(seg);
        if (bodyDec && paramType && paramType !== "unknown") {
          detectedBodyType = paramType;
        }
      }
    }
  }

  // Also expand route.queryTypeText if present and not yet expanded
  if (
    queryParamsMap.size === 0 &&
    route.queryTypeText &&
    route.queryTypeText !== "unknown" &&
    route.queryTypeText !== "void" &&
    route.queryTypeText !== "Record<string, string>"
  ) {
    const qBody = route.queryTypeText.startsWith("{")
      ? route.queryTypeText.slice(1, -1)
      : resolveTypeDefinitionBody(
          route.queryTypeText,
          route.sourceFile,
          controllerSource,
          index,
        );
    if (qBody) {
      for (const f of parseDtoFields(qBody)) {
        queryParamsMap.set(f.name, {
          name: f.name,
          location: "query",
          type: f.rawType,
          required: f.required,
          defaultValue: String(f.example ?? ""),
          description: f.description,
          enumValues: f.enumValues,
        });
      }
    }
  }

  // Resolve Body DTO fields
  let bodyFields: DtoFieldSpec[] = [];
  if (detectedBodyType) {
    const bodyDef = detectedBodyType.startsWith("{")
      ? detectedBodyType.slice(1, -1)
      : resolveTypeDefinitionBody(
          detectedBodyType,
          route.sourceFile,
          controllerSource,
          index,
        );
    if (bodyDef) {
      bodyFields = parseDtoFields(bodyDef);
    }
  }

  const hasBody =
    route.method === "POST" ||
    route.method === "PUT" ||
    route.method === "PATCH";
  const bodySampleJson = hasBody
    ? JSON.stringify(buildSampleObjectFromFields(bodyFields), null, 2)
    : "";

  return {
    key: route.key,
    method: route.method === "ALL" ? "GET" : route.method,
    path: route.path,
    controllerName: route.controllerName,
    handlerName: route.handlerName,
    summary,
    description,
    tags,
    isGuarded,
    pathParams: [...pathParamsMap.values()],
    queryParams: [...queryParamsMap.values()],
    headerParams: [...headerParamsMap.values()],
    bodyTypeName: detectedBodyType,
    bodyFields,
    bodySampleJson,
    responseTypeText: route.responseTypeText,
  };
}
