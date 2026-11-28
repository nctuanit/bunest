import {
  capitalize,
  escapeRegExp,
  uncapitalize,
} from "@bunest/core/common";
import {
  dirname,
  ensureDir,
  existsSyncPath,
  readTextSync,
  relative,
  resolve,
  writeTextSync,
} from "@bunest/core";
import type {
  ExtractedClassMacroEntry,
  ExtractedImportRef,
  ExtractedMacroAccessors,
  ExtractedMacroField,
  TypegenClientTypesResult,
  TypegenResult,
  TypegenScanResult,
  TypegenSummary,
} from "./types";

export interface EmitDeclarationOptions {
  readonly outputPath: string;
  readonly cwd: string;
  readonly includeGlobalNamespace?: boolean;
}

export interface EmitClientRouteTypesOptions {
  readonly outputPath: string;
  readonly cwd: string;
  /**
   * Whether to emit runtime `export const appRouteManifest = ... as const`.
   * Defaults to `true` for `.ts`/`.mts`/`.cts` files and `false` for `.d.ts`/`.d.mts`/`.d.cts` files.
   */
  readonly includeManifest?: boolean;
}

function formatImportSpecifier(fromDir: string, filePath: string): string {
  // Package bare specifier (e.g. "@bunest/mongoose")
  if (!filePath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(filePath)) {
    return filePath;
  }
  let rel = relative(fromDir, filePath)
    .replace(/\\/g, "/")
    .replace(/\.(?:mts|cts|tsx|ts)$/, "");
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel;
}

function formatPropKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

const CLOSING_TO_OPENING_BRACKET: Readonly<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
  ">": "<",
};

function stripAccessorPrefix(
  fieldName: string,
  accessors?: ExtractedMacroAccessors,
): string {
  const prefixes = accessors?.prefix ?? [];
  for (const prefix of prefixes) {
    if (
      prefix &&
      fieldName.startsWith(prefix) &&
      fieldName.length > prefix.length
    ) {
      return uncapitalize(fieldName.slice(prefix.length));
    }
  }
  return fieldName;
}

function toUpperSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
}

function singularizeName(name: string): string {
  if (name.endsWith("ies") && name.length > 3) return `${name.slice(0, -3)}y`;
  if (/(?:ches|shes|xes|zes|ses)$/i.test(name) && name.length > 3) {
    return name.slice(0, -2);
  }
  if (name.endsWith("s") && !name.endsWith("ss") && name.length > 1) {
    return name.slice(0, -1);
  }
  return name;
}

const LEADING_INVALID_TYPE_RE = /^[;,:=\])}>]/;
const TRAILING_INCOMPLETE_TYPE_RE =
  /(?:[|&:,=.<(]|\b(?:typeof|keyof|readonly|extends|infer|is|asserts|in|new))$/;

/**
 * Validates and sanitizes an extracted TypeScript type expression so
 * mid-keystroke partial edits (e.g. `phone:` before typing `string`) never
 * produce syntactically invalid `.d.ts` output.
 */
export function sanitizeTypeText(
  raw: string | undefined,
  fallback = "unknown",
): string {
  const text = raw?.trim() ?? "";
  if (!text) return fallback;
  if (LEADING_INVALID_TYPE_RE.test(text)) return fallback;
  if (TRAILING_INCOMPLETE_TYPE_RE.test(text)) return fallback;

  const stack: string[] = [];
  let quote: "'" | '"' | "`" | null = null;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (quote !== null) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && next === "{") {
        stack.push("${");
        quote = null;
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i++;
      continue;
    }

    // Comments
    if (ch === "/" && next === "/") {
      const nl = text.indexOf("\n", i + 2);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return fallback;
      i = end + 2;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      i++;
      continue;
    }

    // Arrow function `=>` (do not confuse `>` with closing generic bracket)
    if (ch === "=" && next === ">") {
      i += 2;
      continue;
    }

    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") {
      stack.push(ch);
      i++;
      continue;
    }

    if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
      const top = stack.pop();
      if (ch === "}" && top === "${") {
        quote = "`";
        i++;
        continue;
      }
      const expected = CLOSING_TO_OPENING_BRACKET[ch];
      if (top !== expected) {
        return fallback;
      }
      i++;
      continue;
    }

    if (ch === ";" && stack.length === 0) {
      return fallback;
    }

    i++;
  }

  if (quote !== null || stack.length > 0) {
    return fallback;
  }

  return text;
}

/**
 * Performs a fast lexical/structural sanity check on a generated `.d.ts` file
 * so live unsaved-buffer typegen never overwrites disk with broken syntax.
 */
export function validateGeneratedDeclaration(content: string): boolean {
  const stack: string[] = [];
  let quote: "'" | '"' | "`" | null = null;
  let lastSigChar = "";
  let i = 0;

  while (i < content.length) {
    const ch = content[i]!;
    const next = content[i + 1];

    if (quote !== null) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && next === "{") {
        stack.push("${");
        quote = null;
        lastSigChar = "{";
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        lastSigChar = "S";
      }
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      const nl = content.indexOf("\n", i + 2);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = content.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 2;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      i++;
      continue;
    }

    if (ch === "=" && next === ">") {
      lastSigChar = ">";
      i += 2;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }

    // Detect empty type annotations such as `: }`, `: )`, `: ;`, `: ,`
    if (
      lastSigChar === ":" &&
      (ch === "}" || ch === ")" || ch === "]" || ch === ";" || ch === ",")
    ) {
      return false;
    }

    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") {
      stack.push(ch);
    } else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
      const top = stack.pop();
      if (ch === "}" && top === "${") {
        quote = "`";
        lastSigChar = "}";
        i++;
        continue;
      }
      const expected = CLOSING_TO_OPENING_BRACKET[ch];
      if (top !== expected) {
        return false;
      }
    }

    lastSigChar = ch;
    i++;
  }

  return quote === null && stack.length === 0;
}

function buildFieldsObjectType(
  fields: readonly ExtractedMacroField[],
  mode: "props" | "json",
  maskFields: ReadonlySet<string>,
): string {
  const entries: string[] = [];
  for (const f of fields) {
    if (mode === "json") {
      if ((f.isSecret && f.secretOmitFromJson) || maskFields.has(f.name)) {
        continue;
      }
    }
    const opt = f.optional || f.hasDefault ? "?" : "";
    entries.push(`${formatPropKey(f.name)}${opt}: ${sanitizeTypeText(f.typeText)}`);
  }
  return entries.length > 0 ? `{ ${entries.join("; ")} }` : "Record<string, never>";
}

export function buildTypegenSummary(scan: TypegenScanResult): TypegenSummary {
  const pluginCounts: Record<string, number> = {};
  for (const res of scan.pluginResults ?? []) {
    if (res.entryCount > 0) {
      pluginCounts[res.pluginName] = res.entryCount;
    }
  }
  return {
    models: scan.models.length,
    connections: scan.connections.length,
    configNamespaces: scan.configNamespaces.length,
    envKeys: scan.envKeys.length,
    events: scan.events.length,
    messagePatterns: scan.messagePatterns.length,
    eventPatterns: scan.eventPatterns.length,
    routes: scan.routes.length,
    commands: scan.commands.length,
    queries: scan.queries.length,
    tokens: scan.tokens.length,
    classMacros: scan.classMacros.length,
    ...(Object.keys(pluginCounts).length > 0 ? { plugins: pluginCounts } : {}),
  };
}

export function formatTypegenSummary(summary: TypegenSummary): string {
  const parts: string[] = [];
  if (summary.models > 0)
    parts.push(`${summary.models} model${summary.models === 1 ? "" : "s"}`);
  if (summary.connections > 0)
    parts.push(
      `${summary.connections} connection${summary.connections === 1 ? "" : "s"}`,
    );
  const totalConfig = summary.configNamespaces + summary.envKeys;
  if (totalConfig > 0) {
    parts.push(`${totalConfig} config key${totalConfig === 1 ? "" : "s"}`);
  }
  if (summary.events > 0)
    parts.push(`${summary.events} event${summary.events === 1 ? "" : "s"}`);
  const totalRpc = summary.messagePatterns + summary.eventPatterns;
  if (totalRpc > 0)
    parts.push(`${totalRpc} RPC pattern${totalRpc === 1 ? "" : "s"}`);
  if (summary.routes > 0)
    parts.push(`${summary.routes} route${summary.routes === 1 ? "" : "s"}`);
  const totalCqrs = summary.commands + summary.queries;
  if (totalCqrs > 0)
    parts.push(`${totalCqrs} CQRS handler${totalCqrs === 1 ? "" : "s"}`);
  if (summary.tokens > 0)
    parts.push(`${summary.tokens} DI token${summary.tokens === 1 ? "" : "s"}`);
  if (summary.classMacros > 0)
    parts.push(
      `${summary.classMacros} macro class${summary.classMacros === 1 ? "" : "es"}`,
    );
  if (summary.plugins) {
    for (const [pluginName, count] of Object.entries(summary.plugins)) {
      if (count > 0) {
        parts.push(`${count} ${pluginName}`);
      }
    }
  }
  return parts.length > 0 ? parts.join(", ") : "0 entries";
}

function emitClassMacroLines(entry: ExtractedClassMacroEntry): string[] {
  const out: string[] = [];
  const ownMethods = new Set(entry.ownMethodNames);
  const ownProps = new Set(entry.ownPropertyNames);
  const maskSet = new Set(entry.maskFields);
  const fieldsShape = buildFieldsObjectType(entry.fields, "props", maskSet);
  const jsonShape = buildFieldsObjectType(entry.fields, "json", maskSet);

  const instanceLines: string[] = [];
  const builderLines: string[] = [];
  const staticLines: string[] = [];
  const addedInstance = new Set<string>();

  const pushInstance = (name: string, decl: string): void => {
    if (ownMethods.has(name) || addedInstance.has(name)) return;
    addedInstance.add(name);
    instanceLines.push(`    ${decl}`);
  };

  // @Repository<TEntity, TKey>(Entity) / @Repository<TEntity, TKey>(Entity)
  // Synthesizes CrudRepository<TEntity, TKey> methods onto decorator-only repositories
  if (entry.isDeclarativeRepository) {
    const entityType = sanitizeTypeText(
      entry.repositoryEntityType ?? "Record<string, unknown>",
      "Record<string, unknown>",
    );
    const keyType = sanitizeTypeText(entry.repositoryKeyType ?? "number", "number");
    pushInstance("findById", `findById(id: ${keyType}): Promise<${entityType} | null>;`);
    pushInstance("findByIdOrFail", `findByIdOrFail(id: ${keyType}): Promise<${entityType}>;`);
    pushInstance("findAll", `findAll(): Promise<${entityType}[]>;`);
    pushInstance("save", `save(entity: Partial<${entityType}>): Promise<${entityType}>;`);
    pushInstance(
      "saveMany",
      `saveMany(entities: readonly Partial<${entityType}>[]): Promise<${entityType}[]>;`,
    );
    pushInstance("deleteById", `deleteById(id: ${keyType}): Promise<void>;`);
    pushInstance("count", "count(): Promise<number>;");
    pushInstance("existsById", `existsById(id: ${keyType}): Promise<boolean>;`);
    pushInstance(
      "query",
      "query<TRow = Record<string, unknown>>(sql: string, params?: OrmSqlParams): Promise<TRow[]>;",
    );
    pushInstance(
      "queryOne",
      "queryOne<TRow = Record<string, unknown>>(sql: string, params?: OrmSqlParams): Promise<TRow | null>;",
    );
    pushInstance(
      "execute",
      "execute(sql: string, params?: OrmSqlParams): Promise<OrmQueryResult>;",
    );
  }

  // @BaseEntity<Key> synthesized entity columns (`id`, `createdAt`, `updatedAt`, `deletedAt`)
  if (
    entry.isBaseEntity &&
    entry.baseEntityFields &&
    entry.baseEntityFields.length > 0
  ) {
    for (const bf of entry.baseEntityFields) {
      if (!ownProps.has(bf.name) && !addedInstance.has(bf.name)) {
        addedInstance.add(bf.name);
        const safeType = sanitizeTypeText(bf.typeText);
        instanceLines.push(
          `    ${formatPropKey(bf.name)}${bf.optional ? "?" : ""}: ${safeType};`,
        );
      }
    }
  }

  // @WithLogger
  if (entry.isWithLogger && !ownProps.has(entry.loggerPropertyName)) {
    addedInstance.add(entry.loggerPropertyName);
    instanceLines.push(
      `    readonly ${formatPropKey(entry.loggerPropertyName)}: Logger;`,
    );
  }

  // Per-field accessors, withers, withBy
  const wantsGetters =
    entry.isGetter ||
    entry.isValue ||
    (entry.isData && entry.accessorsEnabled);
  const wantsSetters =
    !entry.isValue &&
    (entry.isSetter || (entry.isData && entry.accessorsEnabled));
  const wantsWith = entry.isWith || entry.isData || entry.isValue;
  const wantsWithBy = entry.isWithBy;
  const fluent = entry.accessors.fluent === true;
  const chain = entry.accessors.chain !== false;

  for (const field of entry.fields) {
    const clean = stripAccessorPrefix(field.name, entry.accessors);
    const hasGet = wantsGetters || field.hasGetter;
    const hasSet = !entry.isValue && (wantsSetters || field.hasSetter);
    const safeType = sanitizeTypeText(field.typeText);
    const valType = field.optional ? `${safeType} | undefined` : safeType;

    if (fluent && hasGet && hasSet) {
      if (!ownMethods.has(clean) && !ownProps.has(clean) && !addedInstance.has(clean)) {
        addedInstance.add(clean);
        instanceLines.push(`    ${formatPropKey(clean)}(): ${valType};`);
        instanceLines.push(
          `    ${formatPropKey(clean)}(value: ${valType}): ${chain ? "this" : "void"};`,
        );
      }
    } else {
      if (hasGet) {
        const gName = fluent ? clean : `get${capitalize(clean)}`;
        if (!ownProps.has(gName)) {
          pushInstance(gName, `${formatPropKey(gName)}(): ${valType};`);
        }
      }
      if (hasSet) {
        const sName = fluent ? clean : `set${capitalize(clean)}`;
        if (!ownProps.has(sName)) {
          pushInstance(
            sName,
            `${formatPropKey(sName)}(value: ${valType}): ${chain ? "this" : "void"};`,
          );
        }
      }
    }

    if (wantsWith || field.hasWith) {
      const wName = `with${capitalize(field.name)}`;
      pushInstance(
        wName,
        `${formatPropKey(wName)}(value: ${valType}): ${entry.className};`,
      );
    }

    if (wantsWithBy || field.hasWithBy) {
      const wbName = `with${capitalize(field.name)}By`;
      pushInstance(
        wbName,
        `${formatPropKey(wbName)}(updater: (current: ${valType}) => ${valType}): ${entry.className};`,
      );
    }
  }

  // Patch-based `with(patch)`
  if (wantsWith) {
    pushInstance(
      "with",
      `with(patch: Partial<${fieldsShape}>): ${entry.className};`,
    );
  }

  // @EqualsAndHashCode / @Data / @Value
  if (entry.isEqualsAndHashCode || entry.isData || entry.isValue) {
    pushInstance("equals", "equals(other: unknown): boolean;");
    pushInstance("hashCode", "hashCode(): number;");
  }

  // @ToString / @Data / @Value
  if (entry.isToString || entry.isData || entry.isValue) {
    pushInstance("toString", "toString(): string;");
  }

  // @JsonSerializable / @Data / @Value
  if (entry.isJsonSerializable || entry.isData || entry.isValue) {
    pushInstance("toJSON", `toJSON(): ${jsonShape};`);
    staticLines.push(
      `    export function fromJSON(raw: string | Record<string, unknown>): ${entry.className};`,
    );
  }

  // @Data / @Value factories & clone
  if (entry.isData || entry.isValue) {
    pushInstance("clone", `clone(): ${entry.className};`);
    staticLines.push(
      `    export function of(props: ${fieldsShape}): ${entry.className};`,
    );
    staticLines.push(
      `    export function from(source: Partial<${fieldsShape}>): ${entry.className};`,
    );
  }

  // @Delegate forwarded methods
  for (const del of entry.delegates) {
    for (const mem of del.members) {
      pushInstance(mem.name, `${formatPropKey(mem.name)}${mem.signatureText};`);
    }
  }

  // @Builder / @SuperBuilder
  const builderInterfaceName = `${entry.className}Builder`;
  if (entry.isBuilder || entry.isSuperBuilder) {
    const prefix = entry.setterPrefix;
    const seenBuilderMethods = new Set<string>();
    const pushBuilder = (name: string, decl: string): void => {
      if (seenBuilderMethods.has(name)) return;
      seenBuilderMethods.add(name);
      builderLines.push(`    ${decl}`);
    };

    for (const field of entry.fields) {
      const safeType = sanitizeTypeText(field.typeText);
      const valType = field.optional ? `${safeType} | undefined` : safeType;
      const setterName = prefix
        ? `${prefix}${capitalize(field.name)}`
        : field.name;

      if (field.isSingular) {
        const sBase = field.singularName ?? singularizeName(field.name);
        const sMethod = prefix ? `${prefix}${capitalize(sBase)}` : sBase;
        if (field.collectionKind === "map") {
          const kType = sanitizeTypeText(field.collectionKeyTypeText);
          const vType = sanitizeTypeText(field.collectionValueTypeText);
          pushBuilder(
            sMethod,
            `${formatPropKey(sMethod)}(key: ${kType}, value: ${vType}): this;`,
          );
        } else {
          const itemType = sanitizeTypeText(field.collectionItemTypeText);
          pushBuilder(sMethod, `${formatPropKey(sMethod)}(item: ${itemType}): this;`);
        }
        pushBuilder(setterName, `${formatPropKey(setterName)}(value: ${valType}): this;`);
        const clearName = `clear${capitalize(field.name)}`;
        pushBuilder(clearName, `${formatPropKey(clearName)}(): this;`);
      } else {
        pushBuilder(setterName, `${formatPropKey(setterName)}(value: ${valType}): this;`);
      }
    }

    builderLines.push(
      `    ${formatPropKey(entry.buildMethodName)}(): ${entry.className};`,
    );
    staticLines.push(
      `    export function ${formatPropKey(entry.builderMethodName)}(): ${builderInterfaceName};`,
    );

    if (entry.toBuilder) {
      pushInstance("toBuilder", `toBuilder(): ${builderInterfaceName};`);
    }
  }

  // @FieldNameConstants
  if (entry.isFieldNameConstants) {
    const constEntries: string[] = [];
    for (const field of entry.fields) {
      if (field.fieldConstantExclude) continue;
      if (entry.fieldConstantsOnlyExplicit && !field.fieldConstantInclude) {
        continue;
      }
      const key = entry.fieldConstantsUppercase
        ? toUpperSnake(field.name)
        : field.name;
      constEntries.push(
        `readonly ${formatPropKey(key)}: ${JSON.stringify(field.name)}`,
      );
    }
    const shape =
      constEntries.length > 0
        ? `{ ${constEntries.join("; ")} }`
        : "Record<string, never>";
    staticLines.push(
      `    export const ${formatPropKey(entry.fieldConstantsInnerName)}: ${shape};`,
    );
  }

  // @StandardException
  if (entry.isStandardException) {
    staticLines.push(
      `    export function from(message: string, cause?: unknown): ${entry.className};`,
    );
    if (!ownProps.has("code")) {
      instanceLines.push("    code?: string;");
    }
    if (!ownProps.has("statusCode")) {
      instanceLines.push("    statusCode?: number;");
    }
  }

  // Custom macros (`defineClassMacro` fields, methods, statics, and `typegen()` hooks)
  if (entry.customMembers && entry.customMembers.length > 0) {
    const addedStatic = new Set<string>();
    const addedBuilder = new Set<string>();
    for (const mem of entry.customMembers) {
      const cleanSig = mem.signature.trim().replace(/;+$/, "");
      if (!cleanSig) continue;

      if (mem.kind === "instance") {
        const isMethodSig = /^[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(/.test(
          cleanSig,
        );
        if (isMethodSig) {
          pushInstance(mem.name, `${cleanSig};`);
        } else if (!ownProps.has(mem.name) && !addedInstance.has(mem.name)) {
          addedInstance.add(mem.name);
          instanceLines.push(`    ${cleanSig};`);
        }
      } else if (mem.kind === "builder") {
        if (!addedBuilder.has(mem.name)) {
          addedBuilder.add(mem.name);
          builderLines.push(`    ${cleanSig};`);
        }
      } else if (mem.kind === "static") {
        if (!addedStatic.has(mem.name)) {
          addedStatic.add(mem.name);
          const stripped = cleanSig.replace(/^static\s+/, "").trim();
          const isFn =
            /^(?:function\s+)?[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(/.test(
              stripped,
            );
          if (stripped.startsWith("export ")) {
            staticLines.push(`    ${stripped};`);
          } else if (isFn) {
            const withoutFn = stripped.replace(/^function\s+/, "");
            staticLines.push(`    export function ${withoutFn};`);
          } else {
            const withoutReadonly = stripped.replace(/^(?:readonly|const)\s+/, "");
            staticLines.push(`    export const ${withoutReadonly};`);
          }
        }
      }
    }
  }

  if (instanceLines.length > 0) {
    out.push(`  interface ${entry.className} {`);
    out.push(...instanceLines);
    out.push("  }");
  }
  if (builderLines.length > 0) {
    out.push(`  interface ${builderInterfaceName} {`);
    out.push(...builderLines);
    out.push("  }");
  }
  if (staticLines.length > 0) {
    out.push(`  namespace ${entry.className} {`);
    out.push(...staticLines);
    out.push("  }");
  }

  return out;
}

/**
 * Renders a deterministic, `verbatimModuleSyntax`-compliant `.d.ts` file
 * augmenting only the `@bunest/*` modules and macro-decorated user classes
 * that have discovered entries.
 */
export function emitBunestDeclaration(
  scan: TypegenScanResult,
  options: EmitDeclarationOptions,
): string {
  const outputDir = dirname(resolve(options.outputPath));
  const includeGlobal = options.includeGlobalNamespace ?? true;
  const exportedMacros = scan.classMacros.filter((m) => m.isExported);

  // Collect & deduplicate all `import type` references
  const allImports: ExtractedImportRef[] = [
    ...scan.models.flatMap((m) => m.imports),
    ...scan.configNamespaces.flatMap((c) => c.imports),
    ...scan.events.flatMap((e) => e.imports),
    ...scan.messagePatterns.flatMap((m) => m.imports),
    ...scan.eventPatterns.flatMap((e) => e.imports),
    ...scan.routes.flatMap((r) => r.imports),
    ...scan.commands.flatMap((c) => c.imports),
    ...scan.queries.flatMap((q) => q.imports),
    ...scan.tokens.flatMap((t) => t.imports),
    ...exportedMacros.flatMap((m) => m.imports),
    ...(scan.pluginResults ?? []).flatMap((p) => p.imports),
  ];

  const needsConfigTypeHelper = scan.configNamespaces.some(
    (c) => c.usesConfigTypeHelper,
  );
  if (needsConfigTypeHelper) {
    allImports.push({
      filePath: "@bunest/core/config",
      exportName: "ConfigType",
      isTypeOnly: true,
    });
  }

  const needsLoggerImport = exportedMacros.some(
    (m) => m.isWithLogger && !m.ownPropertyNames.includes(m.loggerPropertyName),
  );
  if (needsLoggerImport) {
    allImports.push({
      filePath: "@bunest/core",
      exportName: "Logger",
      isTypeOnly: true,
    });
  }

  const needsOrmRepoImports = exportedMacros.some(
    (m) => m.isDeclarativeRepository,
  );
  if (needsOrmRepoImports) {
    allImports.push(
      {
        filePath: "@bunest/orm",
        exportName: "OrmQueryResult",
        isTypeOnly: true,
      },
      {
        filePath: "@bunest/orm",
        exportName: "OrmSqlParams",
        isTypeOnly: true,
      },
    );
  }

  // Group imports by resolved specifier
  const importsBySpecifier = new Map<string, Map<string, string | undefined>>();
  for (const imp of allImports) {
    const spec = formatImportSpecifier(outputDir, imp.filePath);
    let namedMap = importsBySpecifier.get(spec);
    if (!namedMap) {
      namedMap = new Map();
      importsBySpecifier.set(spec, namedMap);
    }
    const localKey = imp.alias
      ? `${imp.exportName} as ${imp.alias}`
      : imp.exportName;
    namedMap.set(localKey, imp.alias);
  }

  const lines: string[] = [
    "// ============================================================================",
    "// AUTO-GENERATED BY BUNEST TYPEGEN — DO NOT EDIT MANUALLY.",
    "// Regenerated automatically during `bunest dev` / `bunest typegen`.",
    "// ============================================================================",
    "/* eslint-disable */",
    "",
  ];

  // Emit sorted `import type` statements (package imports first, then relative imports)
  const sortedSpecifiers = [...importsBySpecifier.keys()].sort((a, b) => {
    const aRel = a.startsWith(".") ? 1 : 0;
    const bRel = b.startsWith(".") ? 1 : 0;
    if (aRel !== bRel) return aRel - bRel;
    return a.localeCompare(b);
  });

  if (sortedSpecifiers.length > 0) {
    for (const spec of sortedSpecifiers) {
      const names = [...importsBySpecifier.get(spec)!.keys()].sort();
      lines.push(
        `import type { ${names.join(", ")} } from ${JSON.stringify(spec)};`,
      );
    }
    lines.push("");
  }

  const routeTextsForStdHelpers = scan.routes.flatMap((r) => [
    r.paramsTypeText,
    r.queryTypeText,
    r.bodyTypeText,
    r.responseTypeText,
  ]);
  const needsStdInputHelper = routeTextsForStdHelpers.some((t) =>
    t.includes("StandardSchemaInferInput<"),
  );
  const needsStdOutputHelper = routeTextsForStdHelpers.some((t) =>
    t.includes("StandardSchemaInferOutput<"),
  );
  if (needsStdInputHelper || needsStdOutputHelper) {
    if (needsStdInputHelper) {
      lines.push(
        'type StandardSchemaInferInput<T> = T extends { readonly "~standard": { readonly types?: { readonly input: infer I } | undefined } } ? I : unknown;',
      );
    }
    if (needsStdOutputHelper) {
      lines.push(
        'type StandardSchemaInferOutput<T> = T extends { readonly "~standard": { readonly types?: { readonly output: infer O } | undefined } } ? O : unknown;',
      );
    }
    lines.push("");
  }

  let hasAnyAugmentation = false;

  // 1. @bunest/mongoose augmentation
  if (scan.models.length > 0 || scan.connections.length > 0) {
    hasAnyAugmentation = true;
    lines.push('declare module "@bunest/mongoose" {');
    if (scan.models.length > 0) {
      lines.push("  interface BunestModelRegistry {");
      for (const m of scan.models) {
        lines.push(`    ${formatPropKey(m.name)}: ${m.typeText};`);
      }
      lines.push("  }");
    }
    if (scan.connections.length > 0) {
      if (scan.models.length > 0) lines.push("");
      lines.push("  interface BunestConnectionRegistry {");
      for (const c of scan.connections) {
        lines.push(`    ${formatPropKey(c.name)}: true;`);
      }
      lines.push("  }");
    }
    lines.push("}");
    lines.push("");
  }

  // 2. @bunest/config augmentation
  if (scan.configNamespaces.length > 0 || scan.envKeys.length > 0) {
    hasAnyAugmentation = true;
    lines.push('declare module "@bunest/core/config" {');
    lines.push("  interface BunestConfigRegistry {");
    for (const env of scan.envKeys) {
      lines.push(`    ${formatPropKey(env.key)}: string;`);
    }
    for (const ns of scan.configNamespaces) {
      lines.push(`    ${formatPropKey(ns.namespace)}: ${ns.typeText};`);
    }
    lines.push("  }");
    lines.push("}");
    lines.push("");
  }

  // 3. @bunest/events augmentation
  if (scan.events.length > 0) {
    hasAnyAugmentation = true;
    lines.push('declare module "@bunest/messaging/events" {');
    lines.push("  interface BunestEventRegistry {");
    for (const ev of scan.events) {
      lines.push(`    ${JSON.stringify(ev.eventName)}: ${ev.payloadTypeText};`);
    }
    lines.push("  }");
    lines.push("}");
    lines.push("");
  }

  // 4. @bunest/microservices augmentation
  if (scan.messagePatterns.length > 0 || scan.eventPatterns.length > 0) {
    hasAnyAugmentation = true;
    lines.push('declare module "@bunest/microservices" {');
    if (scan.messagePatterns.length > 0) {
      lines.push("  interface BunestMessagePatternRegistry {");
      for (const mp of scan.messagePatterns) {
        lines.push(
          `    ${JSON.stringify(mp.patternKey)}: { readonly request: ${mp.requestTypeText}; readonly response: ${mp.responseTypeText} };`,
        );
      }
      lines.push("  }");
    }
    if (scan.eventPatterns.length > 0) {
      if (scan.messagePatterns.length > 0) lines.push("");
      lines.push("  interface BunestEventPatternRegistry {");
      for (const ep of scan.eventPatterns) {
        lines.push(
          `    ${JSON.stringify(ep.patternKey)}: ${ep.payloadTypeText};`,
        );
      }
      lines.push("  }");
    }
    lines.push("}");
    lines.push("");
  }

  // 5. @bunest/common augmentation (Routes + DI Tokens)
  if (scan.routes.length > 0 || scan.tokens.length > 0) {
    hasAnyAugmentation = true;
    lines.push('declare module "@bunest/core" {');
    if (scan.routes.length > 0) {
      lines.push("  interface BunestRouteRegistry {");
      for (const r of scan.routes) {
        lines.push(`    ${JSON.stringify(r.key)}: {`);
        lines.push(`      readonly method: ${JSON.stringify(r.method)};`);
        lines.push(`      readonly path: ${JSON.stringify(r.path)};`);
        lines.push(`      readonly params: ${r.paramsTypeText};`);
        lines.push(`      readonly query: ${r.queryTypeText};`);
        lines.push(`      readonly body: ${r.bodyTypeText};`);
        lines.push(`      readonly response: ${r.responseTypeText};`);
        lines.push(
          `      readonly controller: ${JSON.stringify(r.controllerName)};`,
        );
        lines.push(`      readonly handler: ${JSON.stringify(r.handlerName)};`);
        lines.push("    };");
      }
      lines.push("  }");
    }
    if (scan.tokens.length > 0) {
      if (scan.routes.length > 0) lines.push("");
      lines.push("  interface BunestTokenRegistry {");
      for (const t of scan.tokens) {
        lines.push(`    ${JSON.stringify(t.token)}: ${t.valueTypeText};`);
      }
      lines.push("  }");
    }
    lines.push("}");
    lines.push("");
  }

  // 6. @bunest/cqrs augmentation
  if (scan.commands.length > 0 || scan.queries.length > 0) {
    hasAnyAugmentation = true;
    lines.push('declare module "@bunest/messaging/cqrs" {');
    if (scan.commands.length > 0) {
      lines.push("  interface BunestCommandRegistry {");
      for (const cmd of scan.commands) {
        lines.push(
          `    ${formatPropKey(cmd.key)}: { readonly command: ${cmd.commandTypeText}; readonly result: ${cmd.resultTypeText} };`,
        );
      }
      lines.push("  }");
    }
    if (scan.queries.length > 0) {
      if (scan.commands.length > 0) lines.push("");
      lines.push("  interface BunestQueryRegistry {");
      for (const q of scan.queries) {
        lines.push(
          `    ${formatPropKey(q.key)}: { readonly query: ${q.queryTypeText}; readonly result: ${q.resultTypeText} };`,
        );
      }
      lines.push("  }");
    }
    lines.push("}");
    lines.push("");
  }

  // 7. Class Macros per-module augmentation (`@Data`, `@Value`, `@Builder`, `@WithLogger`, `@Delegate`, `@FieldNameConstants`, ...)
  if (exportedMacros.length > 0) {
    const byFile = new Map<string, ExtractedClassMacroEntry[]>();
    for (const macro of exportedMacros) {
      const list = byFile.get(macro.sourceFile) ?? [];
      list.push(macro);
      byFile.set(macro.sourceFile, list);
    }
    for (const [filePath, entries] of [...byFile.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const blocks: string[] = [];
      for (const entry of entries) {
        const emitted = emitClassMacroLines(entry);
        if (emitted.length > 0) {
          blocks.push(...emitted);
        }
      }
      if (blocks.length > 0) {
        hasAnyAugmentation = true;
        const spec = formatImportSpecifier(outputDir, filePath);
        lines.push(`declare module ${JSON.stringify(spec)} {`);
        lines.push(...blocks);
        lines.push("}");
        lines.push("");
      }
    }
  }

  // 7a. Auto-injected `logger` on `@Injectable()` classes
  if (scan.injectableLoggers && scan.injectableLoggers.length > 0) {
    const byFile = new Map<string, string[]>();
    for (const entry of scan.injectableLoggers) {
      const list = byFile.get(entry.sourceFile) ?? [];
      if (!list.includes(entry.className)) {
        list.push(entry.className);
      }
      byFile.set(entry.sourceFile, list);
    }
    for (const [filePath, classNames] of [...byFile.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      hasAnyAugmentation = true;
      const spec = formatImportSpecifier(outputDir, filePath);
      lines.push(`declare module ${JSON.stringify(spec)} {`);
      for (const className of classNames) {
        lines.push(`  interface ${className} {`);
        lines.push(`    readonly logger: import("@bunest/core").Logger;`);
        lines.push(`  }`);
      }
      lines.push("}");
      lines.push("");
    }
  }

  // 7b. Typegen Plugin Augmentations (i18n, jobs, workflows, authz, ai-tools, and custom plugins)
  if (scan.pluginResults && scan.pluginResults.length > 0) {
    for (const pluginRes of scan.pluginResults) {
      for (const block of pluginRes.blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        hasAnyAugmentation = true;
        lines.push(trimmed);
        lines.push("");
      }
    }
  }

  // 8. Global convenience namespace (`Bunest.*`) for quick DX inspection
  if (includeGlobal && hasAnyAugmentation) {
    const globalLines: string[] = [];
    if (scan.models.length > 0) {
      globalLines.push(
        `    export type ModelName = ${scan.models.map((m) => JSON.stringify(m.name)).join(" | ")};`,
      );
      globalLines.push("    export interface Models {");
      for (const m of scan.models) {
        globalLines.push(`      ${formatPropKey(m.name)}: ${m.typeText};`);
      }
      globalLines.push("    }");
    }
    if (scan.configNamespaces.length > 0 || scan.envKeys.length > 0) {
      globalLines.push("    export interface Config {");
      for (const env of scan.envKeys) {
        globalLines.push(`      ${formatPropKey(env.key)}: string;`);
      }
      for (const ns of scan.configNamespaces) {
        globalLines.push(`      ${formatPropKey(ns.namespace)}: ${ns.typeText};`);
      }
      globalLines.push("    }");
    }
    if (scan.events.length > 0) {
      globalLines.push(
        `    export type EventName = ${scan.events.map((e) => JSON.stringify(e.eventName)).join(" | ")};`,
      );
      globalLines.push("    export interface Events {");
      for (const ev of scan.events) {
        globalLines.push(
          `      ${JSON.stringify(ev.eventName)}: ${ev.payloadTypeText};`,
        );
      }
      globalLines.push("    }");
    }
    if (scan.routes.length > 0) {
      const uniquePaths = [...new Set(scan.routes.map((r) => r.path))].sort();
      globalLines.push(
        `    export type RoutePath = ${uniquePaths.map((p) => JSON.stringify(p)).join(" | ")};`,
      );
      globalLines.push(
        `    export type RouteKey = ${scan.routes.map((r) => JSON.stringify(r.key)).join(" | ")};`,
      );
    }
    if (scan.tokens.length > 0) {
      globalLines.push(
        `    export type TokenName = ${scan.tokens.map((t) => JSON.stringify(t.token)).join(" | ")};`,
      );
    }
    if (globalLines.length > 0) {
      lines.push("declare global {");
      lines.push("  namespace Bunest {");
      lines.push(...globalLines);
      lines.push("  }");
      lines.push("}");
      lines.push("");
    }
  }

  if (!hasAnyAugmentation) {
    lines.push(
      "// No Bunest schemas, routes, events, configs, patterns, tokens, or class macros discovered yet.",
    );
    lines.push("");
  }

  lines.push("export {};");
  lines.push("");

  return lines.join("\n");
}

/**
 * Writes generated declaration content to disk only when content differs from
 * the existing file (avoids unnecessary TypeScript language server reloads).
 */
export async function writeTypegenOutput(
  scan: TypegenScanResult,
  options: {
    readonly cwd: string;
    readonly outputPath: string;
    readonly includeGlobalNamespace?: boolean;
    readonly dryRun?: boolean;
    readonly check?: boolean;
  },
): Promise<TypegenResult> {
  const outputPath = resolve(options.outputPath);
  const relativePath = relative(options.cwd, outputPath).replace(/\\/g, "/");
  const content = emitBunestDeclaration(scan, {
    outputPath,
    cwd: options.cwd,
    includeGlobalNamespace: options.includeGlobalNamespace,
  });
  const summary = buildTypegenSummary(scan);

  let existingContent: string | undefined;
  try {
    if (typeof Bun !== "undefined") {
      const existingFile = Bun.file(outputPath);
      if (await existingFile.exists()) {
        existingContent = await existingFile.text();
      }
    } else if (existsSyncPath(outputPath)) {
      existingContent = readTextSync(outputPath);
    }
  } catch {
    existingContent = undefined;
  }

  const upToDate = existingContent === content;
  const dryRun = options.dryRun === true || options.check === true;
  let changed = false;

  if (!dryRun && !upToDate) {
    if (typeof Bun !== "undefined") {
      await Bun.write(outputPath, content);
    } else {
      await ensureDir(dirname(outputPath));
      writeTextSync(outputPath, content);
    }
    changed = true;
  }

  return {
    outputPath,
    relativePath,
    content,
    changed,
    upToDate,
    dryRun,
    summary,
    scannedFiles: scan.scannedFiles,
    durationMs: scan.durationMs,
  };
}

function isBunestPackageSpecifier(filePath: string): boolean {
  return filePath === "@bunest/core" || filePath.startsWith("@bunest/");
}

function sanitizeClientRouteTypeText(
  raw: string,
  excludedSymbols: ReadonlySet<string>,
): string {
  // Strip any inline `import("@bunest/...").Symbol` type queries so the emitted
  // file has zero references to `@bunest/core` or other server-side `@bunest/*` packages.
  let cleaned = raw.replace(
    /import\((["'])@bunest\/[^"']+\1\)\.[A-Za-z_$][\w$]*/g,
    "unknown",
  );
  for (const sym of excludedSymbols) {
    cleaned = cleaned.replace(
      new RegExp(`\\b${escapeRegExp(sym)}\\b`, "g"),
      "unknown",
    );
  }
  return sanitizeTypeText(cleaned, "unknown");
}

/**
 * Emits a standalone, frontend-portable TypeScript file exporting `AppRoutes`
 * (and `appRouteManifest` for `.ts` targets) with ZERO imports from `@bunest/core`
 * or other `@bunest/*` server packages.
 *
 * Designed for monorepo frontends (React, Next.js, Vue, Vite, etc.) passing
 * `AppRoutes` into `createTypedClient<AppRoutes>({ baseUrl, manifest: appRouteManifest })`.
 */
export function emitClientRouteTypes(
  scan: TypegenScanResult,
  options: EmitClientRouteTypesOptions,
): string {
  const outputPath = resolve(options.outputPath);
  const outputDir = dirname(outputPath);
  const isDeclarationFile = /\.d\.[mc]?ts$/i.test(outputPath);
  const includeManifest = options.includeManifest ?? !isDeclarationFile;

  const excludedSymbols = new Set<string>();
  const importsBySpecifier = new Map<string, Map<string, string | undefined>>();

  for (const route of scan.routes) {
    for (const imp of route.imports) {
      if (isBunestPackageSpecifier(imp.filePath)) {
        excludedSymbols.add(imp.alias ?? imp.exportName);
        continue;
      }
      const spec = formatImportSpecifier(outputDir, imp.filePath);
      if (isBunestPackageSpecifier(spec)) {
        excludedSymbols.add(imp.alias ?? imp.exportName);
        continue;
      }
      let namedMap = importsBySpecifier.get(spec);
      if (!namedMap) {
        namedMap = new Map();
        importsBySpecifier.set(spec, namedMap);
      }
      const localKey = imp.alias
        ? `${imp.exportName} as ${imp.alias}`
        : imp.exportName;
      namedMap.set(localKey, imp.alias);
    }
  }

  const lines: string[] = [
    "// ============================================================================",
    "// AUTO-GENERATED BY BUNEST TYPEGEN — DO NOT EDIT MANUALLY.",
    "// Standalone frontend-portable route types for `createTypedClient<AppRoutes>()`.",
    "// Regenerated automatically via `bunest typegen --client-types <path>`.",
    "// ============================================================================",
    "/* eslint-disable */",
    "",
  ];

  const sortedSpecifiers = [...importsBySpecifier.keys()].sort((a, b) => {
    const aRel = a.startsWith(".") ? 1 : 0;
    const bRel = b.startsWith(".") ? 1 : 0;
    if (aRel !== bRel) return aRel - bRel;
    return a.localeCompare(b);
  });

  if (sortedSpecifiers.length > 0) {
    for (const spec of sortedSpecifiers) {
      const names = [...importsBySpecifier.get(spec)!.keys()].sort();
      lines.push(
        `import type { ${names.join(", ")} } from ${JSON.stringify(spec)};`,
      );
    }
    lines.push("");
  }

  const routeTextsForStdHelpers = scan.routes.flatMap((r) => [
    r.paramsTypeText,
    r.queryTypeText,
    r.bodyTypeText,
    r.responseTypeText,
  ]);
  const needsStdInputHelper = routeTextsForStdHelpers.some((t) =>
    t.includes("StandardSchemaInferInput<"),
  );
  const needsStdOutputHelper = routeTextsForStdHelpers.some((t) =>
    t.includes("StandardSchemaInferOutput<"),
  );
  if (needsStdInputHelper || needsStdOutputHelper) {
    if (needsStdInputHelper) {
      lines.push(
        'type StandardSchemaInferInput<T> = T extends { readonly "~standard": { readonly types?: { readonly input: infer I } | undefined } } ? I : unknown;',
      );
    }
    if (needsStdOutputHelper) {
      lines.push(
        'type StandardSchemaInferOutput<T> = T extends { readonly "~standard": { readonly types?: { readonly output: infer O } | undefined } } ? O : unknown;',
      );
    }
    lines.push("");
  }

  if (scan.routes.length === 0) {
    lines.push("// No HTTP controller routes discovered yet.");
    lines.push("export interface AppRoutes {}");
    lines.push("");
    lines.push("export type AppRouteKey = keyof AppRoutes;");
    lines.push("export type AppRoutePath = never;");
    if (includeManifest) {
      lines.push("");
      lines.push("export const appRouteManifest = {} as const;");
    }
    lines.push("");
    return lines.join("\n");
  }

  lines.push("export interface AppRoutes {");
  for (const r of scan.routes) {
    const paramsType = sanitizeClientRouteTypeText(
      r.paramsTypeText,
      excludedSymbols,
    );
    const queryType = sanitizeClientRouteTypeText(
      r.queryTypeText,
      excludedSymbols,
    );
    const bodyType = sanitizeClientRouteTypeText(
      r.bodyTypeText,
      excludedSymbols,
    );
    const responseType = sanitizeClientRouteTypeText(
      r.responseTypeText,
      excludedSymbols,
    );

    lines.push(`  ${JSON.stringify(r.key)}: {`);
    lines.push(`    readonly method: ${JSON.stringify(r.method)};`);
    lines.push(`    readonly path: ${JSON.stringify(r.path)};`);
    lines.push(`    readonly params: ${paramsType};`);
    lines.push(`    readonly query: ${queryType};`);
    lines.push(`    readonly body: ${bodyType};`);
    lines.push(`    readonly response: ${responseType};`);
    lines.push(
      `    readonly controller: ${JSON.stringify(r.controllerName)};`,
    );
    lines.push(`    readonly handler: ${JSON.stringify(r.handlerName)};`);
    lines.push("  };");
  }
  lines.push("}");
  lines.push("");

  const uniquePaths = [...new Set(scan.routes.map((r) => r.path))].sort();
  lines.push("export type AppRouteKey = keyof AppRoutes;");
  lines.push(
    `export type AppRoutePath = ${uniquePaths.map((p) => JSON.stringify(p)).join(" | ")};`,
  );

  if (includeManifest) {
    lines.push("");
    lines.push("export const appRouteManifest = {");
    for (const r of scan.routes) {
      lines.push(`  ${JSON.stringify(r.key)}: {`);
      lines.push(`    method: ${JSON.stringify(r.method)},`);
      lines.push(`    path: ${JSON.stringify(r.path)},`);
      lines.push(`    controller: ${JSON.stringify(r.controllerName)},`);
      lines.push(`    handler: ${JSON.stringify(r.handlerName)},`);
      lines.push("  },");
    }
    lines.push("} as const;");
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Writes standalone frontend-portable client route types to disk only when
 * content differs from the existing file.
 */
export async function writeClientRouteTypes(
  scan: TypegenScanResult,
  options: {
    readonly cwd: string;
    readonly outputPath: string;
    readonly includeManifest?: boolean;
    readonly dryRun?: boolean;
    readonly check?: boolean;
  },
): Promise<TypegenClientTypesResult> {
  const outputPath = resolve(options.cwd, options.outputPath);
  const relativePath = relative(options.cwd, outputPath).replace(/\\/g, "/");
  const content = emitClientRouteTypes(scan, {
    outputPath,
    cwd: options.cwd,
    includeManifest: options.includeManifest,
  });

  let existingContent: string | undefined;
  try {
    if (typeof Bun !== "undefined") {
      const existingFile = Bun.file(outputPath);
      if (await existingFile.exists()) {
        existingContent = await existingFile.text();
      }
    } else if (existsSyncPath(outputPath)) {
      existingContent = readTextSync(outputPath);
    }
  } catch {
    existingContent = undefined;
  }

  const upToDate = existingContent === content;
  const dryRun = options.dryRun === true || options.check === true;
  let changed = false;

  if (!dryRun && !upToDate) {
    if (typeof Bun !== "undefined") {
      await Bun.write(outputPath, content);
    } else {
      await ensureDir(dirname(outputPath));
      writeTextSync(outputPath, content);
    }
    changed = true;
  }

  return {
    outputPath,
    relativePath,
    content,
    changed,
    upToDate,
  };
}
