import {
  basename,
  existsSyncPath,
  extname,
  join,
  readDirSyncEntries,
  readTextSync,
  relative,
  resolve,
} from "@bunest/core";
import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type MethodDeclaration,
  type Type as TsType,
} from "../ast";
import type {
  BunestTypegenPlugin,
  TypegenPluginEmitContext,
  TypegenPluginScanContext,
} from "./types";

// ============================================================================
// Extensible Typegen Plugin API
// ============================================================================

export type {
  BunestTypegenPlugin,
  TypegenPluginEmitContext,
  TypegenPluginScanContext,
};

export function defineTypegenPlugin<TData = unknown>(
  plugin: BunestTypegenPlugin<TData>,
): BunestTypegenPlugin<TData> {
  return plugin;
}

// ============================================================================
// Shared AST Helpers for Built-in Ecosystem Plugins
// ============================================================================

function getDecoratorShortName(dec: Decorator): string {
  const name = dec.getName();
  const dot = name.lastIndexOf(".");
  return dot !== -1 ? name.slice(dot + 1) : name;
}

function unwrapExpr(expr: Expression | undefined): Expression | undefined {
  let cur = expr;
  while (cur) {
    if (Node.isParenthesizedExpression(cur)) {
      cur = cur.getExpression();
    } else if (Node.isAsExpression(cur) || Node.isSatisfiesExpression(cur)) {
      cur = cur.getExpression();
    } else {
      break;
    }
  }
  return cur;
}

function extractStringLiteral(expr: Expression | undefined): string | undefined {
  const cur = unwrapExpr(expr);
  if (!cur) return undefined;
  if (
    Node.isStringLiteral(cur) ||
    Node.isNoSubstitutionTemplateLiteral(cur)
  ) {
    return cur.getLiteralValue();
  }
  return undefined;
}

function getObjectPropInit(
  expr: Expression | undefined,
  propName: string,
): Expression | undefined {
  const cur = unwrapExpr(expr);
  if (!cur || !Node.isObjectLiteralExpression(cur)) return undefined;
  const prop = cur.getProperty(propName);
  if (prop && Node.isPropertyAssignment(prop)) {
    return prop.getInitializer();
  }
  if (prop && Node.isShorthandPropertyAssignment(prop)) {
    return prop.getNameNode();
  }
  return undefined;
}

function extractNameArg(expr: Expression | undefined): string | undefined {
  return (
    extractStringLiteral(expr) ??
    extractStringLiteral(getObjectPropInit(expr, "name"))
  );
}

function unwrapPromiseType(tsType: TsType): TsType {
  const symName = tsType.getSymbol()?.getName();
  if (symName === "Promise" || symName === "PromiseLike") {
    const arg0 = tsType.getTypeArguments()[0];
    if (arg0) return unwrapPromiseType(arg0);
  }
  return tsType;
}

function printMethodParamAndReturn(
  method: MethodDeclaration,
  ctx: TypegenPluginScanContext,
  unwrapJobWrapper = false,
): { readonly inputType: string; readonly outputType: string } {
  const params = method.getParameters();
  let inputType = "unknown";
  if (params.length > 0) {
    const p0 = params[0]!;
    let pType = p0.getType();
    if (unwrapJobWrapper) {
      const symName = pType.getSymbol()?.getName();
      if (
        (symName === "Job" || symName === "QueueJob" || symName === "BullJob") &&
        pType.getTypeArguments().length > 0
      ) {
        pType = pType.getTypeArguments()[0]!;
      }
    }
    inputType = ctx.printType(pType, "unknown");
  }

  let outputType = "unknown";
  const retNode = method.getReturnTypeNode();
  if (retNode) {
    outputType = ctx.printType(unwrapPromiseType(method.getReturnType()), "unknown");
  } else {
    const ret = unwrapPromiseType(method.getReturnType());
    const printed = ctx.printType(ret, "unknown");
    if (printed && printed !== "any") {
      outputType = printed;
    }
  }

  return { inputType, outputType };
}

// ============================================================================
// 1. i18nTypegenPlugin — Locales JSON/JSONC/YAML/TOML -> BunestI18nRegistry
// ============================================================================

export interface ExtractedI18nKeyEntry {
  readonly key: string;
  readonly params: readonly string[];
  readonly hasCount: boolean;
}

const PLURAL_CATEGORIES = new Set([
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
]);

function isPluralLeafObject(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (keys.length === 0 || !("other" in value)) return false;
  return keys.every(
    (k) => PLURAL_CATEGORIES.has(k) && typeof value[k] === "string",
  );
}

function extractInterpolationParams(template: string): string[] {
  const params = new Set<string>();
  // Extract `{{param}}` first, then single `{param}` / ICU `{param, number}`
  const stripped = template.replace(
    /\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}/g,
    (_m, name: string) => {
      params.add(name);
      return " ";
    },
  );
  for (const m of stripped.matchAll(
    /\{\s*([A-Za-z_$][\w$]*)(?:\s*,[^}]*)?\s*\}/g,
  )) {
    if (m[1]) params.add(m[1]);
  }
  return [...params];
}

const LOCALE_EXTENSIONS = new Set([".json", ".jsonc", ".yaml", ".yml", ".toml"]);

function scanLocaleFilesInDir(rootDir: string): string[] {
  if (typeof Bun !== "undefined" && typeof Bun.Glob === "function") {
    const glob = new Bun.Glob("**/*.{json,jsonc,yaml,yml,toml}");
    return [...glob.scanSync({ cwd: rootDir, onlyFiles: true })].sort();
  }
  const found: string[] = [];
  const walk = (currentDir: string): void => {
    let entries;
    try {
      entries = readDirSyncEntries(currentDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && LOCALE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        found.push(relative(rootDir, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(rootDir);
  return found.sort();
}

function parseLocaleFile(filePath: string): unknown {
  const ext = extname(filePath).toLowerCase();
  const raw = readTextSync(filePath);
  if (ext === ".json") return JSON.parse(raw);
  if (typeof Bun === "undefined") return undefined;
  if (ext === ".jsonc") return Bun.JSONC.parse(raw);
  if (ext === ".toml") return Bun.TOML.parse(raw);
  if (ext === ".yaml" || ext === ".yml") return Bun.YAML.parse(raw);
  return undefined;
}

function flattenLocaleObject(
  value: unknown,
  prefix: string,
  acc: Map<string, { params: Set<string>; hasCount: boolean }>,
): void {
  if (typeof value === "string") {
    if (!prefix) return;
    let entry = acc.get(prefix);
    if (!entry) {
      entry = { params: new Set(), hasCount: false };
      acc.set(prefix, entry);
    }
    for (const p of extractInterpolationParams(value)) {
      entry.params.add(p);
    }
    return;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const record = value as Record<string, unknown>;
  if (prefix && isPluralLeafObject(record)) {
    let entry = acc.get(prefix);
    if (!entry) {
      entry = { params: new Set(), hasCount: true };
      acc.set(prefix, entry);
    } else {
      entry.hasCount = true;
    }
    for (const v of Object.values(record)) {
      if (typeof v === "string") {
        for (const p of extractInterpolationParams(v)) {
          entry.params.add(p);
        }
      }
    }
    return;
  }

  for (const [k, v] of Object.entries(record)) {
    const nextPrefix = prefix ? `${prefix}.${k}` : k;
    flattenLocaleObject(v, nextPrefix, acc);
  }
}

export const i18nTypegenPlugin: BunestTypegenPlugin<
  readonly ExtractedI18nKeyEntry[]
> = defineTypegenPlugin<readonly ExtractedI18nKeyEntry[]>({
  name: "i18n",
  target: "i18n",
  scan(ctx) {
    const acc = new Map<string, { params: Set<string>; hasCount: boolean }>();
    const candidateRoots = new Set<string>([
      join(ctx.cwd, "locales"),
      join(ctx.cwd, "i18n"),
      join(ctx.sourceRootDir, "locales"),
      join(ctx.sourceRootDir, "i18n"),
    ]);

    const seenFiles = new Set<string>();

    for (const rootDir of candidateRoots) {
      if (!existsSyncPath(rootDir)) continue;
      let matches: string[];
      try {
        matches = scanLocaleFilesInDir(rootDir);
      } catch {
        continue;
      }

      for (const relMatch of matches) {
        const absFile = resolve(rootDir, relMatch);
        if (seenFiles.has(absFile)) continue;
        seenFiles.add(absFile);

        let parsed: unknown;
        try {
          parsed = parseLocaleFile(absFile);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object") continue;

        const normalizedRel = relative(rootDir, absFile).replace(/\\/g, "/");
        const parts = normalizedRel.split("/").filter(Boolean);
        let nsPrefix = "";
        if (parts.length >= 2) {
          // Format: `<locale>/<namespace>.<ext>` or `<locale>/nested/<ns>.<ext>`
          const nsSegments = parts.slice(1);
          const last = nsSegments[nsSegments.length - 1]!;
          const stem = basename(last, extname(last));
          nsSegments[nsSegments.length - 1] = stem;
          nsPrefix = nsSegments.filter(Boolean).join(".");
        }
        flattenLocaleObject(parsed, nsPrefix, acc);
      }
    }

    return [...acc.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, info]) => ({
        key,
        params: [...info.params].sort(),
        hasCount: info.hasCount,
      }));
  },
  emit(entries) {
    if (entries.length === 0) return "";
    const lines: string[] = [
      'declare module "@bunest/core/i18n" {',
      "  interface BunestI18nRegistry {",
    ];
    for (const entry of entries) {
      const paramNames = new Set(entry.params);
      if (entry.hasCount) paramNames.add("count");
      const sortedParams = [...paramNames].sort();
      if (sortedParams.length === 0) {
        lines.push(`    ${JSON.stringify(entry.key)}: Record<string, never>;`);
      } else {
        const fields = sortedParams.map((p) => {
          const typeStr =
            entry.hasCount && p === "count" ? "number" : "string | number";
          return `readonly ${/^[A-Za-z_$][\w$]*$/.test(p) ? p : JSON.stringify(p)}: ${typeStr}`;
        });
        lines.push(
          `    ${JSON.stringify(entry.key)}: { ${fields.join("; ")} };`,
        );
      }
    }
    lines.push("  }");
    lines.push("}");
    return lines.join("\n");
  },
});

// ============================================================================
// 2. jobsTypegenPlugin — @Processor/@Queue/@Process -> BunestQueueRegistry
// ============================================================================

export interface ExtractedQueueJobEntry {
  readonly jobName: string;
  readonly dataType: string;
  readonly resultType: string;
}

export interface ExtractedQueueEntry {
  readonly queueName: string;
  readonly jobs: readonly ExtractedQueueJobEntry[];
}

export const jobsTypegenPlugin: BunestTypegenPlugin<
  readonly ExtractedQueueEntry[]
> = defineTypegenPlugin<readonly ExtractedQueueEntry[]>({
  name: "jobs",
  target: "jobs",
  scan(ctx) {
    const queues = new Map<string, Map<string, ExtractedQueueJobEntry>>();

    for (const sf of ctx.sourceFiles) {
      for (const cls of sf.getClasses()) {
        const queueDec = cls.getDecorators().find((d) => {
          const s = getDecoratorShortName(d);
          return s === "Processor" || s === "Queue";
        });
        if (!queueDec) continue;

        const queueName = extractNameArg(
          queueDec.getArguments()[0] as Expression | undefined,
        );
        if (!queueName) continue;

        let jobsMap = queues.get(queueName);
        if (!jobsMap) {
          jobsMap = new Map();
          queues.set(queueName, jobsMap);
        }

        for (const method of cls.getMethods()) {
          const procDec = method
            .getDecorators()
            .find((d) => getDecoratorShortName(d) === "Process");
          if (!procDec) continue;

          const jobName =
            extractNameArg(
              procDec.getArguments()[0] as Expression | undefined,
            ) ?? method.getName();
          const { inputType, outputType } = printMethodParamAndReturn(
            method,
            ctx,
            true,
          );
          jobsMap.set(jobName, {
            jobName,
            dataType: inputType,
            resultType: outputType,
          });
        }
      }
    }

    return [...queues.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([queueName, jobsMap]) => ({
        queueName,
        jobs: [...jobsMap.values()].sort((a, b) =>
          a.jobName.localeCompare(b.jobName),
        ),
      }));
  },
  emit(entries) {
    if (entries.length === 0) return "";
    const lines: string[] = [
      'declare module "@bunest/jobs" {',
      "  interface BunestQueueRegistry {",
    ];
    for (const q of entries) {
      if (q.jobs.length === 0) {
        lines.push(
          `    ${JSON.stringify(q.queueName)}: Record<string, { readonly data: unknown; readonly result: unknown }>;`,
        );
      } else {
        lines.push(`    ${JSON.stringify(q.queueName)}: {`);
        for (const job of q.jobs) {
          lines.push(
            `      readonly ${JSON.stringify(job.jobName)}: { readonly data: ${job.dataType}; readonly result: ${job.resultType} };`,
          );
        }
        lines.push("    };");
      }
    }
    lines.push("  }");
    lines.push("}");
    return lines.join("\n");
  },
});

// ============================================================================
// 3. workflowsTypegenPlugin — @Workflow / defineWorkflow -> BunestWorkflowRegistry
// ============================================================================

export interface ExtractedWorkflowEntry {
  readonly name: string;
  readonly inputType: string;
  readonly outputType: string;
}

function findWorkflowHandlerMethod(
  cls: ClassDeclaration,
): MethodDeclaration | undefined {
  for (const preferred of ["run", "execute", "handle", "start"]) {
    const m = cls.getMethods().find((method) => method.getName() === preferred);
    if (m) return m;
  }
  return cls.getMethods().find((m) => !m.isStatic());
}

export const workflowsTypegenPlugin: BunestTypegenPlugin<
  readonly ExtractedWorkflowEntry[]
> = defineTypegenPlugin<readonly ExtractedWorkflowEntry[]>({
  name: "workflows",
  target: "workflows",
  scan(ctx) {
    const workflows = new Map<string, ExtractedWorkflowEntry>();

    for (const sf of ctx.sourceFiles) {
      // 1. @Workflow("name") / @Workflow({ name: "name" }) classes
      for (const cls of sf.getClasses()) {
        const wfDec = cls
          .getDecorators()
          .find((d) => getDecoratorShortName(d) === "Workflow");
        if (!wfDec) continue;

        const name =
          extractNameArg(wfDec.getArguments()[0] as Expression | undefined) ??
          cls.getName();
        if (!name) continue;

        const handler = findWorkflowHandlerMethod(cls);
        const { inputType, outputType } = handler
          ? printMethodParamAndReturn(handler, ctx)
          : { inputType: "unknown", outputType: "unknown" };

        workflows.set(name, { name, inputType, outputType });
      }

      // 2. defineWorkflow({ name: "..." }) / defineWorkflow("...", ...)
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        const calleeName = Node.isIdentifier(callee)
          ? callee.getText()
          : Node.isPropertyAccessExpression(callee)
            ? callee.getName()
            : "";
        if (calleeName !== "defineWorkflow") continue;

        const arg0 = call.getArguments()[0] as Expression | undefined;
        const name = extractNameArg(arg0);
        if (!name) continue;

        let inputType = "unknown";
        let outputType = "unknown";

        const typeArgs = call.getTypeArguments();
        if (typeArgs[0]) {
          inputType = ctx.printType(typeArgs[0].getType(), "unknown");
        }
        if (typeArgs[1]) {
          outputType = ctx.printType(typeArgs[1].getType(), "unknown");
        }

        if (inputType === "unknown" && outputType === "unknown") {
          const runFn =
            getObjectPropInit(arg0, "run") ??
            getObjectPropInit(arg0, "execute") ??
            getObjectPropInit(arg0, "handler");
          if (runFn) {
            const sig = runFn.getType().getCallSignatures()[0];
            if (sig) {
              const sigParams = sig.getParameters();
              const inputParam =
                sigParams.length >= 2 ? sigParams[1] : sigParams[0];
              if (inputParam) {
                const decl = inputParam.getValueDeclaration();
                if (decl) {
                  inputType = ctx.printType(
                    inputParam.getTypeAtLocation(decl),
                    "unknown",
                  );
                }
              }
              outputType = ctx.printType(
                unwrapPromiseType(sig.getReturnType()),
                "unknown",
              );
            }
          }
        }

        workflows.set(name, { name, inputType, outputType });
      }
    }

    return [...workflows.values()].sort((a, b) => a.name.localeCompare(b.name));
  },
  emit(entries) {
    if (entries.length === 0) return "";
    const lines: string[] = [
      'declare module "@bunest/workflows" {',
      "  interface BunestWorkflowRegistry {",
    ];
    for (const wf of entries) {
      lines.push(
        `    ${JSON.stringify(wf.name)}: { readonly input: ${wf.inputType}; readonly output: ${wf.outputType} };`,
      );
    }
    lines.push("  }");
    lines.push("}");
    return lines.join("\n");
  },
});

// ============================================================================
// 4. authzTypegenPlugin — @RequirePermissions/@Permissions/@CheckPolicies -> BunestPermissionRegistry
// ============================================================================

const AUTHZ_DECORATORS = new Set([
  "RequirePermissions",
  "Permissions",
  "CheckPolicies",
]);

function extractPermissionTokens(
  dec: Decorator,
  shortName: string,
): string[] {
  const out: string[] = [];
  for (const rawArg of dec.getArguments()) {
    const arg = unwrapExpr(rawArg as Expression | undefined);
    if (!arg) continue;
    const str = extractStringLiteral(arg);
    if (str) {
      out.push(str);
      continue;
    }
    if (Node.isArrayLiteralExpression(arg)) {
      for (const el of arg.getElements()) {
        const elStr = extractStringLiteral(el as Expression | undefined);
        if (elStr) out.push(elStr);
        else if (shortName === "CheckPolicies" && Node.isIdentifier(el)) {
          out.push(el.getText());
        }
      }
      continue;
    }
    if (shortName === "CheckPolicies") {
      if (Node.isIdentifier(arg)) {
        out.push(arg.getText());
      } else if (Node.isNewExpression(arg)) {
        const ctorText = arg.getExpression().getText().trim();
        if (ctorText) out.push(ctorText);
      }
    }
  }
  return out;
}

export const authzTypegenPlugin: BunestTypegenPlugin<readonly string[]> =
  defineTypegenPlugin<readonly string[]>({
    name: "authz",
    target: "authz",
    scan(ctx) {
      const permissions = new Set<string>();

      for (const sf of ctx.sourceFiles) {
        for (const dec of sf.getDescendantsOfKind(SyntaxKind.Decorator)) {
          const short = getDecoratorShortName(dec);
          if (!AUTHZ_DECORATORS.has(short)) continue;
          for (const perm of extractPermissionTokens(dec, short)) {
            if (perm.length > 0) permissions.add(perm);
          }
        }
      }

      return [...permissions].sort((a, b) => a.localeCompare(b));
    },
    emit(permissions) {
      if (permissions.length === 0) return "";
      const lines: string[] = [
        'declare module "@bunest/security/authz" {',
        "  interface BunestPermissionRegistry {",
      ];
      for (const perm of permissions) {
        lines.push(`    ${JSON.stringify(perm)}: true;`);
      }
      lines.push("  }");
      lines.push("}");
      return lines.join("\n");
    },
  });

// ============================================================================
// 5. aiToolsTypegenPlugin — @AiTool/@McpTool/defineTool -> BunestAiToolRegistry
// ============================================================================

export interface ExtractedAiToolEntry {
  readonly name: string;
  readonly description?: string;
  readonly inputType: string;
  readonly outputType: string;
}

export const aiToolsTypegenPlugin: BunestTypegenPlugin<
  readonly ExtractedAiToolEntry[]
> = defineTypegenPlugin<readonly ExtractedAiToolEntry[]>({
  name: "ai-tools",
  target: "ai",
  scan(ctx) {
    const tools = new Map<string, ExtractedAiToolEntry>();

    for (const sf of ctx.sourceFiles) {
      // 1. @AiTool / @McpTool on methods or classes
      for (const cls of sf.getClasses()) {
        const clsDec = cls.getDecorators().find((d) => {
          const s = getDecoratorShortName(d);
          return s === "AiTool" || s === "McpTool";
        });
        if (clsDec) {
          const arg0 = clsDec.getArguments()[0] as Expression | undefined;
          const name = extractNameArg(arg0) ?? cls.getName();
          if (name) {
            const description = extractStringLiteral(
              getObjectPropInit(arg0, "description"),
            );
            const execMethod =
              cls.getMethods().find((m) => m.getName() === "execute") ??
              cls.getMethods().find((m) => m.getName() === "run") ??
              cls.getMethods().find((m) => !m.isStatic());
            const { inputType, outputType } = execMethod
              ? printMethodParamAndReturn(execMethod, ctx)
              : { inputType: "unknown", outputType: "unknown" };
            tools.set(name, { name, description, inputType, outputType });
          }
        }

        for (const method of cls.getMethods()) {
          const toolDec = method.getDecorators().find((d) => {
            const s = getDecoratorShortName(d);
            return s === "AiTool" || s === "McpTool";
          });
          if (!toolDec) continue;

          const arg0 = toolDec.getArguments()[0] as Expression | undefined;
          const name = extractNameArg(arg0) ?? method.getName();
          const description = extractStringLiteral(
            getObjectPropInit(arg0, "description"),
          );
          const { inputType, outputType } = printMethodParamAndReturn(
            method,
            ctx,
          );
          tools.set(name, { name, description, inputType, outputType });
        }
      }

      // 2. defineTool({ name: "..." }) / defineTool("...", ...)
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        const calleeName = Node.isIdentifier(callee)
          ? callee.getText()
          : Node.isPropertyAccessExpression(callee)
            ? callee.getName()
            : "";
        if (calleeName !== "defineTool") continue;

        const arg0 = call.getArguments()[0] as Expression | undefined;
        const name = extractNameArg(arg0);
        if (!name) continue;

        const description = extractStringLiteral(
          getObjectPropInit(arg0, "description"),
        );

        let inputType = "unknown";
        let outputType = "unknown";
        const typeArgs = call.getTypeArguments();
        if (typeArgs[0]) {
          inputType = ctx.printType(typeArgs[0].getType(), "unknown");
        }
        if (typeArgs[1]) {
          outputType = ctx.printType(typeArgs[1].getType(), "unknown");
        }

        if (inputType === "unknown" && outputType === "unknown") {
          const execFn =
            getObjectPropInit(arg0, "execute") ??
            getObjectPropInit(arg0, "handler") ??
            getObjectPropInit(arg0, "run");
          if (execFn) {
            const sig = execFn.getType().getCallSignatures()[0];
            if (sig) {
              const p0 = sig.getParameters()[0];
              if (p0) {
                const decl = p0.getValueDeclaration();
                if (decl) {
                  inputType = ctx.printType(
                    p0.getTypeAtLocation(decl),
                    "unknown",
                  );
                }
              }
              outputType = ctx.printType(
                unwrapPromiseType(sig.getReturnType()),
                "unknown",
              );
            }
          }
        }

        tools.set(name, { name, description, inputType, outputType });
      }
    }

    return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  },
  emit(entries) {
    if (entries.length === 0) return "";
    const lines: string[] = [
      'declare module "@bunest/ai" {',
      "  interface BunestAiToolRegistry {",
    ];
    for (const tool of entries) {
      const descField = tool.description
        ? ` readonly description: ${JSON.stringify(tool.description)};`
        : "";
      lines.push(
        `    ${JSON.stringify(tool.name)}: { readonly input: ${tool.inputType}; readonly output: ${tool.outputType};${descField} };`,
      );
    }
    lines.push("  }");
    lines.push("}");
    return lines.join("\n");
  },
});

// ============================================================================
// Built-in Plugin Registry & Runner
// ============================================================================

export const BUILTIN_TYPEGEN_PLUGINS: readonly BunestTypegenPlugin<any>[] = [
  i18nTypegenPlugin,
  jobsTypegenPlugin,
  workflowsTypegenPlugin,
  authzTypegenPlugin,
  aiToolsTypegenPlugin,
] as const;

export function selectActiveTypegenPlugins(
  userPlugins: readonly BunestTypegenPlugin<any>[] = [],
  include?: readonly string[],
): BunestTypegenPlugin<any>[] {
  const includeSet = include ? new Set(include) : null;
  const byName = new Map<string, BunestTypegenPlugin<any>>();

  for (const plugin of BUILTIN_TYPEGEN_PLUGINS) {
    if (
      !includeSet ||
      includeSet.has(plugin.name) ||
      (plugin.target && includeSet.has(plugin.target))
    ) {
      byName.set(plugin.name, plugin);
    }
  }

  for (const plugin of userPlugins) {
    if (
      !includeSet ||
      !plugin.target ||
      includeSet.has(plugin.name) ||
      includeSet.has(plugin.target)
    ) {
      byName.set(plugin.name, plugin);
    }
  }

  return [...byName.values()];
}
