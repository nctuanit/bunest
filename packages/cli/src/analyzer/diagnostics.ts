import { Node, SyntaxKind, type Expression, type SourceFile } from "../ast";
import type { BunestConfigLike } from "../config/bunest-config.loader";
import {
  BUILTIN_DI_CLASS_DECORATORS,
  BUILTIN_ORM_RELATION_DECORATOR_NAMES,
  BUILTIN_SERVICE_AOP_DECORATORS,
  CONFLICTING_CLASS_MACRO_PAIRS,
  parseBaseEntityDecoratorAst,
  resolveComposedDecorators,
  type ResolvedDecoratorEntry,
} from "../decorators";
import { nodeToLocation } from "../typegen/scanner";
import type {
  SourceLocation,
  TypegenScanResult,
} from "../typegen/types";
import {
  runClassMacroDiagnostics,
  type ClassMacroDiagnostic,
} from "./class-macros";
import {
  collectConfiguredDiagnosticRules,
  runCustomDiagnosticRules,
  type CustomDiagnosticRule,
} from "./custom-rules";
import type {
  ConstructorDependencyInfo,
  ProviderScope,
  StaticModuleGraph,
  StaticModuleNode,
  StaticProviderNode,
} from "./module-graph";
import type {
  AnalyzedEntity,
  AnalyzedRepository,
  RepositoryDiagnostic,
} from "./repository-query";

export type CoreDiagnosticCode =
  | "BUNEST001"
  | "BUNEST002"
  | "BUNEST003"
  | "BUNEST004"
  | "BUNEST005"
  | "BUNEST006"
  | "BUNEST007"
  | "BUNEST008"
  | "BUNEST009"
  | "BUNEST010"
  | "BUNEST011";

export type DecoratorDiagnosticCode =
  | "BUNEST_DEC001"
  | "BUNEST_DEC002"
  | "BUNEST_DEC003"
  | "BUNEST_DEC004"
  | "BUNEST_DEC005";

export type BunestDiagnosticCode =
  | CoreDiagnosticCode
  | RepositoryDiagnostic["code"]
  | ClassMacroDiagnostic["code"]
  | DecoratorDiagnosticCode
  | "BUNEST_ARCH001"
  | "BUNEST_ARCH002"
  | (string & {});

export interface BunestDiagnostic {
  readonly code: BunestDiagnosticCode;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly location: SourceLocation;
  readonly suggestion?: string;
  readonly fixData?: Record<string, unknown>;
}

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
  "Request",
  "Response",
  "Headers",
  "URL",
  "AbortSignal",
  "ModuleRef",
  "Reflector",
  "Logger",
  "ConsoleLogger",
  "ClsService",
  "ConfigService",
  "HttpAdapterHost",
  "DiscoveryService",
  "MetadataScanner",
  "ModulesContainer",
  "ApplicationConfig",
  "ExternalContextCreator",
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

const WELL_KNOWN_DI_TOKENS = new Set([
  // Core DI & HTTP runtime tokens
  "Reflector",
  "REFLECTOR",
  "REQUEST",
  "REQUEST_CONTEXT",
  "INQUIRER",
  "HOST_PARAM",
  "HTTP_ADAPTER_HOST",
  "HttpAdapterHost",
  "ModuleRef",
  "MODULE_REF",
  "ApplicationConfig",
  "DiscoveryService",
  "MetadataScanner",
  "ModulesContainer",
  "ExternalContextCreator",
  "APP_GUARD",
  "APP_PIPE",
  "APP_INTERCEPTOR",
  "APP_FILTER",
  "Logger",
  "ConsoleLogger",
  // CLS & Config
  "ClsService",
  "CLS_ID",
  "CLS_REQ",
  "CLS_RES",
  "CLS_MIDDLEWARE_OPTIONS",
  "ConfigService",
  "CONFIG_OPTIONS",
  "CONFIGURATION_TOKEN",
  "CONFIGURATION_SERVICE_TOKEN",
  // ORM / Data / Cache / Events / CQRS / Ecosystem built-ins
  "EventEmitterService",
  "EventEmitter2",
  "CommandBus",
  "QueryBus",
  "EventBus",
  "DataSource",
  "DATA_SOURCE",
  "ORM_DATA_SOURCE",
  "EntityManager",
  "ENTITY_MANAGER",
  "OrmMigrationRunner",
  "CACHE_MANAGER",
  "CacheManager",
  "REDIS_CLIENT",
  "HttpService",
  "ClientProxy",
  "QUEUE_REGISTRY",
  "MAILER_OPTIONS",
  "STORAGE_SERVICE",
  "I18N_SERVICE",
  "AI_SERVICE",
  "AUTH_SERVICE",
  "TRACER",
  "METRICS_REGISTRY",
  "DEVTOOLS_SERVICE",
  "HEALTH_CHECK_SERVICE",
]);

function collectVisibleProvidersForModule(
  mod: StaticModuleNode,
  graph: StaticModuleGraph,
): Set<string> {
  const visible = new Set<string>([
    ...mod.providers,
    ...mod.controllers,
    ...mod.exports,
  ]);

  // Add providers exported by @Global() modules
  for (const m of graph.modules) {
    if (m.isGlobal) {
      for (const p of m.exports) visible.add(p);
      for (const p of m.providers) visible.add(p);
    }
  }

  // BFS over imported modules (plus dynamic `.forFeature([Repo])` items recorded in `mod.imports`)
  const visited = new Set<string>([mod.name]);
  const queue = [...mod.imports];
  while (queue.length > 0) {
    const impName = queue.shift()!;
    visible.add(impName);
    if (visited.has(impName)) continue;
    visited.add(impName);
    const targetMod = graph.moduleByName.get(impName);
    if (!targetMod) continue;
    for (const exp of targetMod.exports) visible.add(exp);
    // Re-exported modules
    for (const exp of targetMod.exports) {
      if (graph.moduleByName.has(exp) && !visited.has(exp)) {
        queue.push(exp);
      }
    }
  }

  return visible;
}

const BUILTIN_REQUEST_TOKENS = new Set(["REQUEST", "REQUEST_CONTEXT"]);

interface ScopeChainEntry {
  readonly name: string;
  readonly scope: ProviderScope;
}

function isAutoModuleNode(mod: StaticModuleNode): boolean {
  return mod.isAutoModule ?? mod.autoDiscover;
}

function resolveDependencyProvider(
  dep: ConstructorDependencyInfo,
  graph: StaticModuleGraph,
): StaticProviderNode | undefined {
  if (dep.isForwardRef && dep.token) {
    const byToken = graph.providerByName.get(dep.token);
    if (byToken) return byToken;
  }
  if (dep.token) {
    return graph.providerByName.get(dep.token);
  }
  if (PRIMITIVE_OR_BUILTIN_TYPES.has(dep.typeName)) {
    return undefined;
  }
  return graph.providerByName.get(dep.typeName);
}

/**
 * Finds the shortest dependency chain from a SINGLETON root through a direct
 * constructor dependency (`firstDep`) to any REQUEST-scoped provider or
 * built-in request token (`REQUEST` / `REQUEST_CONTEXT`).
 *
 * Matches ADR-012 §3: a SINGLETON consumer MUST NEVER depend (directly or
 * transitively, including through SINGLETON or TRANSIENT intermediates) on a
 * REQUEST-scoped dependency.
 */
function findScopeLeakChain(
  root: StaticProviderNode,
  firstDep: ConstructorDependencyInfo,
  graph: StaticModuleGraph,
): ScopeChainEntry[] | undefined {
  const rootEntry: ScopeChainEntry = { name: root.name, scope: root.scope };

  if (firstDep.token && BUILTIN_REQUEST_TOKENS.has(firstDep.token)) {
    return [rootEntry, { name: firstDep.token, scope: "REQUEST" }];
  }

  const firstTarget = resolveDependencyProvider(firstDep, graph);
  if (!firstTarget) return undefined;

  if (firstTarget.scope === "REQUEST") {
    return [rootEntry, { name: firstTarget.name, scope: "REQUEST" }];
  }

  // BFS for shortest transitive chain from firstTarget -> ... -> REQUEST provider
  const visited = new Set<string>([root.name, firstTarget.name]);
  const queue: Array<{
    readonly node: StaticProviderNode;
    readonly chain: readonly ScopeChainEntry[];
  }> = [
    {
      node: firstTarget,
      chain: [
        rootEntry,
        { name: firstTarget.name, scope: firstTarget.scope },
      ],
    },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const nextDep of current.node.dependencies) {
      if (nextDep.token && BUILTIN_REQUEST_TOKENS.has(nextDep.token)) {
        return [
          ...current.chain,
          { name: nextDep.token, scope: "REQUEST" },
        ];
      }

      const nextProv = resolveDependencyProvider(nextDep, graph);
      if (!nextProv) continue;

      if (nextProv.scope === "REQUEST") {
        return [
          ...current.chain,
          { name: nextProv.name, scope: "REQUEST" },
        ];
      }

      if (visited.has(nextProv.name)) continue;
      visited.add(nextProv.name);
      queue.push({
        node: nextProv,
        chain: [
          ...current.chain,
          { name: nextProv.name, scope: nextProv.scope },
        ],
      });
    }
  }

  return undefined;
}

function formatScopeLeakMessage(chain: readonly ScopeChainEntry[]): string {
  const consumer = chain[0]!;
  const dependency = chain[chain.length - 1]!;
  const formattedChain = chain
    .map((node) => `${node.name} [${node.scope}]`)
    .join(" -> ");
  const nonRequestNodes = chain
    .filter((node) => node.scope !== "REQUEST")
    .map((node) => `"${node.name}"`);
  const targetList =
    nonRequestNodes.length > 0
      ? nonRequestNodes.join(" and ")
      : `"${consumer.name}"`;

  return (
    `Scope leak (BUNEST_E003 / ScopeLeakException): ${consumer.scope} "${consumer.name}" cannot depend on ${dependency.scope}-scoped "${dependency.name}" — Bunest fails fast at bootstrap (ADR-012). ` +
    `Chain: ${formattedChain}. ` +
    `Fix: Mark ${targetList} with { scope: Scope.REQUEST }, or read ambient RequestContext/ClsService inside methods.`
  );
}

function expandWithTokenConstants(
  tokens: Iterable<string>,
  constants?: ReadonlyMap<string, string>,
): Set<string> {
  const expanded = new Set<string>();
  for (const t of tokens) {
    expanded.add(t);
    const resolved = constants?.get(t);
    if (resolved !== undefined) {
      expanded.add(resolved);
    }
  }
  return expanded;
}

function collectVisibleTokensForModule(
  mod: StaticModuleNode,
  graph: StaticModuleGraph,
): Set<string> {
  const raw = new Set<string>([...mod.providers, ...mod.controllers]);

  for (const m of graph.modules) {
    if (m.isGlobal) {
      for (const p of m.exports) raw.add(p);
      for (const p of m.providers) raw.add(p);
    }
  }

  const visited = new Set<string>([mod.name]);
  const queue = [...mod.imports];
  while (queue.length > 0) {
    const impName = queue.shift()!;
    raw.add(impName);
    if (visited.has(impName)) continue;
    visited.add(impName);
    const targetMod = graph.moduleByName.get(impName);
    if (!targetMod) continue;
    for (const exp of targetMod.exports) raw.add(exp);
    for (const exp of targetMod.exports) {
      if (graph.moduleByName.has(exp) && !visited.has(exp)) {
        queue.push(exp);
      }
    }
  }

  return expandWithTokenConstants(raw, graph.stringTokenConstants);
}

function collectExportableTokensForModule(
  mod: StaticModuleNode,
  graph: StaticModuleGraph,
): Set<string> {
  const raw = new Set<string>([...mod.providers, ...mod.imports]);

  const visited = new Set<string>([mod.name]);
  const queue = [...mod.imports];
  while (queue.length > 0) {
    const impName = queue.shift()!;
    if (visited.has(impName)) continue;
    visited.add(impName);
    const targetMod = graph.moduleByName.get(impName);
    if (!targetMod) continue;
    for (const exp of targetMod.exports) {
      raw.add(exp);
      if (graph.moduleByName.has(exp) && !visited.has(exp)) {
        queue.push(exp);
      }
    }
  }

  return expandWithTokenConstants(raw, graph.stringTokenConstants);
}

function toUpperSnakeTokenHint(typeName: string): string {
  const stripped = /^I[A-Z]/.test(typeName) ? typeName.slice(1) : typeName;
  return (
    stripped
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .toUpperCase() + "_TOKEN"
  );
}

function isWellKnownToken(token: string): boolean {
  if (WELL_KNOWN_DI_TOKENS.has(token)) return true;
  if (token.startsWith("bunest:") || token.startsWith("BUNEST_")) return true;
  return false;
}

function runCoreDiagnostics(
  sourceFiles: readonly SourceFile[],
  scan: TypegenScanResult,
  graph: StaticModuleGraph,
): BunestDiagnostic[] {
  const diagnostics: BunestDiagnostic[] = [];

  // Map each provider/controller -> declaring modules
  const modulesForClass = new Map<string, StaticModuleNode[]>();
  for (const mod of graph.modules) {
    for (const name of [...mod.providers, ...mod.controllers, ...mod.imports]) {
      const list = modulesForClass.get(name) ?? [];
      list.push(mod);
      modulesForClass.set(name, list);
    }
  }

  // BUNEST001, BUNEST003, BUNEST004, BUNEST008, BUNEST009 on every provider/controller constructor
  for (const prov of graph.providers) {
    const declaringModules = modulesForClass.get(prov.name) ?? [];
    // Scope BUNEST001 / BUNEST009 bypass strictly to modules decorated with @AutoModule
    const explicitDeclaringModules = declaringModules.filter(
      (m) => !isAutoModuleNode(m),
    );
    const explicitVisibleSets = explicitDeclaringModules.map((m) =>
      collectVisibleProvidersForModule(m, graph),
    );
    const explicitVisibleTokenSets = explicitDeclaringModules.map((m) =>
      collectVisibleTokensForModule(m, graph),
    );

    for (const dep of prov.dependencies) {
      // BUNEST008: Interface or type alias injected without @Inject(TOKEN) (erased at runtime!)
      if (
        (prov.kind === "provider" || prov.kind === "controller") &&
        !prov.isAbstract &&
        !dep.isOptional &&
        !dep.token &&
        !dep.injectDecorator &&
        dep.erasedTypeKind !== undefined &&
        !PRIMITIVE_OR_BUILTIN_TYPES.has(dep.typeName)
      ) {
        const kindLabel =
          dep.erasedTypeKind === "interface" ? "interface" : "type alias";
        const suggestedToken = toUpperSnakeTokenHint(dep.typeName);
        const suggestion = `Add @Inject(${suggestedToken}) (or @Inject("${suggestedToken}")) and register { provide: ${suggestedToken}, useClass | useValue | useFactory }, or replace the ${kindLabel} with an abstract class token.`;
        diagnostics.push({
          code: "BUNEST008",
          severity: "error",
          message: `Constructor parameter "${dep.paramName}: ${dep.typeName}" in "${prov.name}" is typed as a TypeScript ${kindLabel}, which is erased at runtime (\`design:paramtypes\` emits \`Object\`). Fix: ${suggestion}`,
          location: dep.location,
          suggestion,
          fixData: {
            kind: "addInjectToken",
            paramName: dep.paramName,
            typeName: dep.typeName,
            erasedTypeKind: dep.erasedTypeKind,
            suggestedToken,
          },
        });
      } else if (
        // BUNEST004: `import type` breaks `emitDecoratorMetadata` constructor injection (for runtime classes)
        dep.isTypeOnlyImport &&
        !dep.token &&
        !dep.injectDecorator &&
        !PRIMITIVE_OR_BUILTIN_TYPES.has(dep.typeName)
      ) {
        diagnostics.push({
          code: "BUNEST004",
          severity: "error",
          message: `Constructor dependency "${dep.paramName}: ${dep.typeName}" in "${prov.name}" is imported with \`import type\`. With \`verbatimModuleSyntax\` + \`emitDecoratorMetadata\`, Bunest DI will receive \`Object\` at runtime instead of \`${dep.typeName}\`.`,
          location: dep.location,
          fixData: {
            kind: "convertTypeImport",
            symbolName: dep.typeName,
            importLocation: dep.importDeclarationLocation,
          },
        });
      }

      // BUNEST003: Direct or transitive scope leak (SINGLETON -> ... -> REQUEST)
      if (prov.scope === "SINGLETON") {
        const leakChain = findScopeLeakChain(prov, dep, graph);
        if (leakChain) {
          diagnostics.push({
            code: "BUNEST003",
            severity: "error",
            message: formatScopeLeakMessage(leakChain),
            location: dep.location,
          });
        }
      }

      // BUNEST009: Unregistered @Inject("TOKEN") or @Inject(SYMBOL_TOKEN)
      if (
        dep.injectDecorator === "Inject" &&
        !dep.isOptional &&
        !dep.isForwardRef &&
        dep.token &&
        dep.tokenKind !== "call" &&
        !isWellKnownToken(dep.token) &&
        explicitDeclaringModules.length > 0 &&
        explicitDeclaringModules.every((m) => !m.hasDynamicProviders)
      ) {
        const resolvedConst = graph.stringTokenConstants?.get(dep.token);
        const isTokenVisible = explicitVisibleTokenSets.some(
          (set) =>
            set.has(dep.token!) ||
            (resolvedConst !== undefined && set.has(resolvedConst)),
        );
        if (!isTokenVisible) {
          const primaryMod = explicitDeclaringModules[0]!;
          const formattedToken =
            dep.tokenKind === "string"
              ? JSON.stringify(dep.token)
              : dep.token;
          const suggestion = `Register { provide: ${formattedToken}, useValue | useClass | useFactory } in "${primaryMod.name}" providers, or import a module that exports it.`;
          diagnostics.push({
            code: "BUNEST009",
            severity: "warning",
            message: `"${prov.name}" injects token ${formattedToken} via @Inject(${formattedToken}), which is not provided or exported to "${primaryMod.name}". Fix: ${suggestion}`,
            location: dep.location,
            suggestion,
            fixData: {
              kind: "registerInjectToken",
              token: dep.token,
              tokenKind: dep.tokenKind,
              moduleName: primaryMod.name,
              moduleFile: primaryMod.sourceFile,
            },
          });
        }
      }

      // Skip primitive / explicit string-token deps for BUNEST001 module visibility checks
      if (dep.token || PRIMITIVE_OR_BUILTIN_TYPES.has(dep.typeName)) {
        continue;
      }

      const targetProv = graph.providerByName.get(dep.typeName);
      if (!targetProv) continue;

      // BUNEST001: Missing provider/export in declaring explicit @Module
      if (!dep.isOptional && explicitDeclaringModules.length > 0) {
        const isVisibleSomewhere = explicitVisibleSets.some((set) =>
          set.has(targetProv.name),
        );
        if (!isVisibleSomewhere) {
          const primaryMod = explicitDeclaringModules[0]!;
          diagnostics.push({
            code: "BUNEST001",
            severity: "error",
            message: `"${prov.name}" injects "${targetProv.name}", which is not registered in or exported to "${primaryMod.name}".`,
            location: dep.location,
            fixData: {
              kind: "addProviderToModule",
              providerName: targetProv.name,
              providerFile: targetProv.sourceFile,
              moduleName: primaryMod.name,
              moduleFile: primaryMod.sourceFile,
            },
          });
        }
      }
    }
  }

  // BUNEST002: Circular DI dependency cycles
  for (const cycle of graph.cycles) {
    const first = graph.providerByName.get(cycle[0]!);
    if (!first) continue;
    diagnostics.push({
      code: "BUNEST002",
      severity: "error",
      message: `Circular DI dependency detected: ${cycle.join(" -> ")}. Break the cycle using \`@Inject(forwardRef(() => ...))\` or extract a shared service.`,
      location: first.location,
    });
  }

  // BUNEST010: Direct or transitive circular @Module({ imports: [...] }) cycles without forwardRef
  for (const cycle of graph.moduleCycles) {
    const firstMod = graph.moduleByName.get(cycle[0]!);
    if (!firstMod) continue;
    const nextMod = cycle[1] ?? cycle[0]!;
    const cyclePath = cycle.join(" -> ");
    const suggestion = `Wrap one side of the cycle in \`forwardRef(() => ${nextMod})\` inside \`@Module({ imports: [...] })\`, or extract shared providers into a common module.`;
    diagnostics.push({
      code: "BUNEST010",
      severity: "error",
      message: `Circular @Module() import detected: ${cyclePath}. Fix: ${suggestion}`,
      location: firstMod.importsLocation ?? firstMod.decoratorLocation,
      suggestion,
      fixData: {
        kind: "breakModuleCycle",
        cycle: [...cycle],
        moduleName: firstMod.name,
        targetModule: nextMod,
      },
    });
  }

  // BUNEST011: @Module({ exports: [X] }) exporting a provider or module not in providers or imports (static BUNEST_E007)
  for (const mod of graph.modules) {
    if (
      isAutoModuleNode(mod) ||
      mod.hasDynamicProviders ||
      mod.hasUnresolvedImportSpread
    ) {
      continue;
    }
    const exportable = collectExportableTokensForModule(mod, graph);
    const exportItems =
      mod.exportItems ??
      mod.exports.map((name) => ({
        name,
        location: mod.exportsLocation ?? mod.decoratorLocation,
      }));
    const reported = new Set<string>();

    for (const item of exportItems) {
      if (reported.has(item.name)) continue;
      const resolvedConst = graph.stringTokenConstants?.get(item.name);
      const isExportable =
        exportable.has(item.name) ||
        (resolvedConst !== undefined && exportable.has(resolvedConst));
      if (isExportable) continue;

      // Skip well-known external framework tokens when module imports an external dynamic module (e.g. ConfigModule.forRoot())
      if (
        mod.hasExternalDynamicImports &&
        !graph.providerByName.has(item.name) &&
        !graph.moduleByName.has(item.name) &&
        isWellKnownToken(item.name)
      ) {
        continue;
      }

      reported.add(item.name);
      const suggestion = `Add "${item.name}" to \`${mod.name}\`'s \`providers\` array before exporting it, or import the module that provides it in \`imports\`.`;
      diagnostics.push({
        code: "BUNEST011",
        severity: "error",
        message: `Invalid export (BUNEST_E007 / InvalidExportException): "${mod.name}" exports "${item.name}", which is neither declared in \`providers\` nor imported via \`imports\`. Fix: ${suggestion}`,
        location: item.location,
        suggestion,
        fixData: {
          kind: "invalidModuleExport",
          moduleName: mod.name,
          moduleFile: mod.sourceFile,
          exportName: item.name,
        },
      });
    }
  }

  // BUNEST005: Duplicate HTTP routes, RPC patterns, or CQRS handlers
  const seenRoutes = new Map<string, SourceLocation>();
  const seenRpc = new Map<string, SourceLocation>();
  const seenCqrs = new Map<string, SourceLocation>();

  for (const sf of sourceFiles) {
    for (const cls of sf.getClasses()) {
      const decs = cls.getDecorators();
      const ctrlDec = decs.find((d) => d.getName() === "Controller");
      if (ctrlDec) {
        const arg0 = ctrlDec.getArguments()[0];
        const prefix =
          arg0 && Node.isStringLiteral(arg0) ? arg0.getLiteralValue() : "";
        for (const m of cls.getMethods()) {
          for (const md of m.getDecorators()) {
            const dn = md.getName();
            if (
              dn === "Get" ||
              dn === "Post" ||
              dn === "Put" ||
              dn === "Patch" ||
              dn === "Delete" ||
              dn === "All"
            ) {
              const pArg = md.getArguments()[0];
              const sub =
                pArg && Node.isStringLiteral(pArg) ? pArg.getLiteralValue() : "";
              const fullPath =
                "/" +
                [prefix, sub]
                  .map((s) => s.replace(/^\/+|\/+$/g, ""))
                  .filter(Boolean)
                  .join("/");
              const key = `${dn.toUpperCase()} ${fullPath}`;
              const loc = nodeToLocation(m.getNameNode());
              if (seenRoutes.has(key)) {
                diagnostics.push({
                  code: "BUNEST005",
                  severity: "error",
                  message: `Duplicate HTTP route "${key}" (already defined in ${seenRoutes.get(key)!.filePath}:${seenRoutes.get(key)!.line}).`,
                  location: loc,
                });
              } else {
                seenRoutes.set(key, loc);
              }
            } else if (dn === "MessagePattern" || dn === "EventPattern") {
              const pArg = md.getArguments()[0];
              const pat =
                pArg && Node.isStringLiteral(pArg)
                  ? pArg.getLiteralValue()
                  : pArg?.getText();
              if (!pat) continue;
              const key = `${dn}:${pat}`;
              const loc = nodeToLocation(m.getNameNode());
              if (seenRpc.has(key)) {
                diagnostics.push({
                  code: "BUNEST005",
                  severity: "error",
                  message: `Duplicate ${dn} "${pat}" (already handled at line ${seenRpc.get(key)!.line}).`,
                  location: loc,
                });
              } else {
                seenRpc.set(key, loc);
              }
            }
          }
        }
      }

      for (const cd of decs) {
        const dn = cd.getName();
        if (dn === "CommandHandler" || dn === "QueryHandler") {
          const arg0 = cd.getArguments()[0];
          const target = arg0?.getText();
          if (!target) continue;
          const key = `${dn}:${target}`;
          const loc = nodeToLocation(cls.getNameNode() ?? cls);
          if (seenCqrs.has(key)) {
            diagnostics.push({
              code: "BUNEST005",
              severity: "error",
              message: `Duplicate @${dn}(${target}) registration (already defined at line ${seenCqrs.get(key)!.line}).`,
              location: loc,
            });
          } else {
            seenCqrs.set(key, loc);
          }
        }
      }
    }
  }

  // BUNEST006: Mongoose @Prop() pitfalls (union without explicit `type`, or bare `ref` without `type: Schema.Types.ObjectId`)
  for (const sf of sourceFiles) {
    for (const cls of sf.getClasses()) {
      const hasSchema = cls
        .getDecorators()
        .some((d) => d.getName() === "Schema");
      if (!hasSchema) continue;

      for (const prop of cls.getProperties()) {
        const propDec = prop
          .getDecorators()
          .find((d) => d.getName() === "Prop");
        if (!propDec) continue;

        const arg0 = propDec.getArguments()[0];
        const hasExplicitType =
          arg0 &&
          Node.isObjectLiteralExpression(arg0) &&
          Boolean(arg0.getProperty("type"));
        const hasBareRef =
          arg0 &&
          Node.isObjectLiteralExpression(arg0) &&
          Boolean(arg0.getProperty("ref")) &&
          !hasExplicitType;

        if (hasBareRef) {
          diagnostics.push({
            code: "BUNEST006",
            severity: "warning",
            message: `@Prop() on "${cls.getName()}.${prop.getName()}" specifies \`ref\` without \`type: Schema.Types.ObjectId\`. Add explicit \`type\` for Mongoose population safety.`,
            location: nodeToLocation(propDec),
            fixData: {
              kind: "wrapMongooseRef",
              decoratorStart: propDec.getStart(),
              decoratorEnd: propDec.getEnd(),
            },
          });
        }

        const typeNode = prop.getTypeNode();
        if (
          typeNode &&
          Node.isUnionTypeNode(typeNode) &&
          !hasExplicitType
        ) {
          const nonNullBranches = typeNode
            .getTypeNodes()
            .filter(
              (n) =>
                n.getKind() !== SyntaxKind.NullKeyword &&
                n.getKind() !== SyntaxKind.UndefinedKeyword,
            );
          if (nonNullBranches.length > 1) {
            diagnostics.push({
              code: "BUNEST006",
              severity: "warning",
              message: `@Prop() on "${cls.getName()}.${prop.getName()}" uses union type "${typeNode.getText()}" without an explicit \`type\` option (TypeScript emits \`Object\` for unions in \`design:type\`).`,
              location: nodeToLocation(prop.getNameNode()),
            });
          }
        }
      }
    }
  }

  // BUNEST007: Orphan events (emitted with no @OnEvent listener, or listened with no emitter)
  const listenedEvents = new Set<string>();
  const emittedEvents = new Map<string, SourceLocation[]>();
  const listenerLocations = new Map<string, SourceLocation[]>();

  for (const cs of scan.callSites) {
    if (cs.kind !== "event") continue;
    if (cs.key.includes("*")) continue;
    if (
      cs.context === "@OnEvent" ||
      cs.context === ".on()" ||
      cs.context === ".once()" ||
      cs.context === ".waitFor()"
    ) {
      listenedEvents.add(cs.key);
      const list = listenerLocations.get(cs.key) ?? [];
      list.push(cs.location);
      listenerLocations.set(cs.key, list);
    } else {
      const list = emittedEvents.get(cs.key) ?? [];
      list.push(cs.location);
      emittedEvents.set(cs.key, list);
    }
  }

  for (const [ev, locs] of emittedEvents) {
    if (!listenedEvents.has(ev)) {
      for (const loc of locs) {
        diagnostics.push({
          code: "BUNEST007",
          severity: "info",
          message: `Event "${ev}" is emitted but has no static @OnEvent("${ev}") listener in this workspace.`,
          location: loc,
        });
      }
    }
  }
  for (const [ev, locs] of listenerLocations) {
    if (!emittedEvents.has(ev) && emittedEvents.size > 0) {
      for (const loc of locs) {
        diagnostics.push({
          code: "BUNEST007",
          severity: "info",
          message: `Listener @OnEvent("${ev}") has no static emit call site found in this workspace.`,
          location: loc,
        });
      }
    }
  }

  return diagnostics;
}

function extractStringProp(
  expr: Expression | undefined,
  propName: string,
): string | undefined {
  if (!expr || !Node.isObjectLiteralExpression(expr)) return undefined;
  const prop = expr.getProperty(propName);
  if (!prop || !Node.isPropertyAssignment(prop)) return undefined;
  const init = prop.getInitializer();
  if (
    init &&
    (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))
  ) {
    return init.getLiteralValue();
  }
  return undefined;
}

const TDZ_SAFE_WRAPPER_TYPES = new Set([
  "Relation",
  "Nested",
  "Ref",
  "Promise",
  "Array",
  "ReadonlyArray",
  "Set",
  "Map",
  "Partial",
  "Pick",
  "Omit",
  "Record",
]);

/**
 * Runs static decorator safety & semantics diagnostics (`BUNEST_DEC001`–`BUNEST_DEC005`):
 * - `BUNEST_DEC001`: Conflicting class macros (e.g. `@Value()` + `@Setter()`, `@Value()` + `@Data()`, `@UtilityClass()` + `@Data()`/`@Builder()`).
 * - `BUNEST_DEC002`: `@SoftDelete()` incompatible with `@BaseEntity({ deletedAt: false })` or missing soft-delete column on entity.
 * - `BUNEST_DEC003`: Service-layer AOP decorator (`@Transactional`, `@Cacheable`, `@Retry`, etc.) on non-DI class.
 * - `BUNEST_DEC004`: `@UtilityClass()` combined with DI-managed decorators (`@Injectable`, `@Controller`, `@Module`, etc.).
 * - `BUNEST_DEC005`: Same-file forward-reference TDZ risk on `@ManyToOne`/`@OneToOne`/`@Embedded` property under `emitDecoratorMetadata`.
 */
export function runDecoratorDiagnostics(
  sourceFiles: readonly SourceFile[],
  repositories: readonly AnalyzedRepository[] = [],
): BunestDiagnostic[] {
  const diagnostics: BunestDiagnostic[] = [];

  for (const sf of sourceFiles) {
    const classes = sf.getClasses();
    const classStartByName = new Map<string, number>();
    for (const cls of classes) {
      const name = cls.getName();
      if (name) {
        classStartByName.set(name, cls.getStart());
      }
    }

    for (const cls of classes) {
      const className = cls.getName() ?? "AnonymousClass";
      const resolvedClassDecs = resolveComposedDecorators(cls);
      const classDecByName = new Map<string, ResolvedDecoratorEntry>();
      for (const entry of resolvedClassDecs) {
        if (!classDecByName.has(entry.name) || !entry.composedFrom) {
          classDecByName.set(entry.name, entry);
        }
      }

      // 1. BUNEST_DEC001: Conflicting class macros
      const reportedPairs = new Set<string>();
      for (const pair of CONFLICTING_CLASS_MACRO_PAIRS) {
        const firstEntry = classDecByName.get(pair.first);
        const secondEntry = classDecByName.get(pair.second);
        if (firstEntry && secondEntry) {
          const key = `${pair.first}:${pair.second}`;
          if (!reportedPairs.has(key)) {
            reportedPairs.add(key);
            diagnostics.push({
              code: "BUNEST_DEC001",
              severity: "error",
              message: `Conflicting decorators on "${className}": ${pair.reason}`,
              location: nodeToLocation(secondEntry.sourceDecorator),
            });
          }
        }
      }

      // Also check @Value() class + property-level @Setter()
      if (classDecByName.has("Value")) {
        for (const prop of cls.getProperties()) {
          const propSetter = resolveComposedDecorators(prop).find(
            (d) => d.name === "Setter",
          );
          if (propSetter) {
            diagnostics.push({
              code: "BUNEST_DEC001",
              severity: "error",
              message: `Conflicting decorators on "${className}.${prop.getName()}": @Setter() cannot be used inside an immutable @Value() class.`,
              location: nodeToLocation(propSetter.sourceDecorator),
            });
          }
        }
      }

      // 2. BUNEST_DEC004: @UtilityClass() combined with DI-managed decorators
      const utilityEntry = classDecByName.get("UtilityClass");
      if (utilityEntry) {
        for (const diName of BUILTIN_DI_CLASS_DECORATORS) {
          const diEntry = classDecByName.get(diName);
          if (diEntry) {
            diagnostics.push({
              code: "BUNEST_DEC004",
              severity: "warning",
              message: `"${className}" combines @UtilityClass() with @${diName}(). @UtilityClass() throws TypeError on \`new\`, preventing the DI container from instantiating it.`,
              location: nodeToLocation(utilityEntry.sourceDecorator),
            });
            break;
          }
        }
      }

      // 3. BUNEST_DEC002: @SoftDelete() on an entity whose @BaseEntity({ deletedAt: false }) disabled it or lacks soft-delete column
      const softDeleteEntry = classDecByName.get("SoftDelete");
      const baseEntityEntry = classDecByName.get("BaseEntity");
      const entityEntry = classDecByName.get("Entity");
      if (softDeleteEntry && (baseEntityEntry || entityEntry)) {
        const expectedProp =
          extractStringProp(softDeleteEntry.resolvedArgs[0], "property") ??
          "deletedAt";
        const ownProps = cls.getProperties();
        const hasOwnProp = ownProps.some(
          (p) =>
            p.getName() === expectedProp ||
            p
              .getDecorators()
              .some((d) => {
                const n = d.getName();
                return n === "DeleteDateColumn" || n.endsWith(".DeleteDateColumn");
              }),
        );

        if (!hasOwnProp) {
          if (baseEntityEntry) {
            const parsed = parseBaseEntityDecoratorAst({
              decorator: baseEntityEntry.sourceDecorator,
              arg0: baseEntityEntry.resolvedArgs[0],
              typeArgNode: baseEntityEntry.resolvedTypeArgNodes[0],
            });
            if (parsed.deletedAtDisabled) {
              diagnostics.push({
                code: "BUNEST_DEC002",
                severity: "error",
                message: `@SoftDelete() on "${className}" expects column "${expectedProp}", but @BaseEntity() explicitly disabled it ({ deletedAt: false }).`,
                location: nodeToLocation(softDeleteEntry.sourceDecorator),
              });
            } else if (
              parsed.deletedAtProperty &&
              parsed.deletedAtProperty !== expectedProp
            ) {
              diagnostics.push({
                code: "BUNEST_DEC002",
                severity: "error",
                message: `@SoftDelete() on "${className}" expects property "${expectedProp}", but @BaseEntity() configured soft-delete property "${parsed.deletedAtProperty}".`,
                location: nodeToLocation(softDeleteEntry.sourceDecorator),
              });
            }
          } else if (!cls.getExtends()) {
            diagnostics.push({
              code: "BUNEST_DEC002",
              severity: "error",
              message: `@SoftDelete() on "${className}" requires a "${expectedProp}" / @DeleteDateColumn() column, which was not found on this entity.`,
              location: nodeToLocation(softDeleteEntry.sourceDecorator),
            });
          }
        }
      }

      // 4. BUNEST_DEC003: Service-layer AOP decorator on a non-abstract, non-DI class
      const isAbstractClass = cls.isAbstract();
      const hasDiDecorator = [...classDecByName.keys()].some((name) =>
        BUILTIN_DI_CLASS_DECORATORS.has(name),
      );
      if (!isAbstractClass && !hasDiDecorator) {
        let reportedAopOnClass = false;
        for (const [name, entry] of classDecByName) {
          if (BUILTIN_SERVICE_AOP_DECORATORS.has(name)) {
            diagnostics.push({
              code: "BUNEST_DEC003",
              severity: "warning",
              message: `Service-layer AOP decorator @${name}() on "${className}" will not weave unless the class is managed by DI (add @Injectable(), @Controller(), or @Resolver()).`,
              location: nodeToLocation(entry.sourceDecorator),
            });
            reportedAopOnClass = true;
            break;
          }
        }
        if (!reportedAopOnClass) {
          for (const method of cls.getMethods()) {
            const aopDec = resolveComposedDecorators(method).find((d) =>
              BUILTIN_SERVICE_AOP_DECORATORS.has(d.name),
            );
            if (aopDec) {
              diagnostics.push({
                code: "BUNEST_DEC003",
                severity: "warning",
                message: `Service-layer AOP decorator @${aopDec.name}() on "${className}.${method.getName()}()" requires a DI-managed class (add @Injectable(), @Controller(), or @Resolver() to "${className}").`,
                location: nodeToLocation(aopDec.sourceDecorator),
              });
            }
          }
        }
      }

      // 5. BUNEST_DEC005: Same-file forward-reference TDZ risk on ORM relation/embedded properties
      const clsStart = cls.getStart();
      for (const prop of cls.getProperties()) {
        if (prop.isStatic()) continue;
        const relDec = resolveComposedDecorators(prop).find((d) =>
          BUILTIN_ORM_RELATION_DECORATOR_NAMES.has(d.name),
        );
        if (!relDec) continue;

        const typeText = prop.getTypeNode()?.getText().trim();
        if (!typeText) continue;

        // Arrays (`Foo[]` / `Array<Foo>`) emit `Array` in `design:type`, NOT `Foo` (TDZ-safe).
        if (typeText.endsWith("[]")) continue;
        const genericMatch = /^([A-Za-z_$][\w$]*)\s*</.exec(typeText);
        if (genericMatch && TDZ_SAFE_WRAPPER_TYPES.has(genericMatch[1]!)) {
          continue;
        }

        // Unwrap nullable union (`Profile | null | undefined` -> `Profile`)
        const parts = typeText
          .split("|")
          .map((p) => p.trim())
          .filter((p) => p !== "null" && p !== "undefined");
        if (parts.length !== 1) continue;
        const bareType = parts[0]!;
        if (!/^[A-Za-z_$][\w$]*$/.test(bareType)) continue;

        const targetStart = classStartByName.get(bareType);
        if (targetStart !== undefined && targetStart > clsStart) {
          diagnostics.push({
            code: "BUNEST_DEC005",
            severity: "warning",
            message: `Property "${className}.${prop.getName()}: ${typeText}" has @${relDec.name}() and directly references same-file class "${bareType}" declared below it. Under \`emitDecoratorMetadata\`, wrap the type in \`Relation<${bareType}>\` / \`Nested<${bareType}>\` or use a class-level decorator (\`@HasOne\`/\`@BelongsTo\`/\`@Embeds\`) to avoid runtime TDZ ReferenceError.`,
            location: nodeToLocation(prop.getNameNode()),
          });
        }
      }
    }
  }

  // Also validate @SoftDelete() on repositories against their resolved AnalyzedEntity
  for (const repo of repositories) {
    if (!repo.entity || !repo.scopes) continue;
    for (const scope of repo.scopes) {
      if (scope.kind !== "softDelete") continue;
      const expectedProp = scope.property ?? "deletedAt";
      const hasField = repo.entity.fields.some(
        (f) => f.propertyName === expectedProp || f.columnName === scope.column,
      );
      if (!hasField) {
        diagnostics.push({
          code: "BUNEST_DEC002",
          severity: "error",
          message: `Repository "${repo.className}" uses @SoftDelete() expecting "${expectedProp}", but entity "${repo.entity.className}" has no "${expectedProp}" column.`,
          location: repo.location,
        });
      }
    }
  }

  return diagnostics;
}

export interface AnalyzeProjectDiagnosticsOptions {
  readonly sourceFiles: readonly SourceFile[];
  readonly scan: TypegenScanResult;
  readonly moduleGraph: StaticModuleGraph;
  readonly repositoryDiagnostics: readonly RepositoryDiagnostic[];
  readonly entities?: readonly AnalyzedEntity[];
  readonly repositories?: readonly AnalyzedRepository[];
  readonly customRules?: readonly CustomDiagnosticRule[];
  readonly presetRules?: readonly string[];
  readonly bunestConfig?: BunestConfigLike;
}

/**
 * Runs all Bunest static diagnostics:
 * - Core (`BUNEST001`–`BUNEST011`)
 * - Declarative Repositories (`BUNEST_REPO001`–`BUNEST_REPO007`)
 * - Class Macros (`BUNEST_MACRO001`–`BUNEST_MACRO005`)
 * - Decorator Semantics & Safety (`BUNEST_DEC001`–`BUNEST_DEC005`)
 * - Custom Architecture & Project Rules (`BUNEST_ARCH001`–`BUNEST_ARCH002`, user rules from `bunest.config.ts`)
 */
export function runAllBunestDiagnostics(
  options: AnalyzeProjectDiagnosticsOptions,
): BunestDiagnostic[] {
  const core = runCoreDiagnostics(
    options.sourceFiles,
    options.scan,
    options.moduleGraph,
  );
  const macro = runClassMacroDiagnostics(
    options.scan.classMacros,
    options.sourceFiles,
  );
  const decorators = runDecoratorDiagnostics(
    options.sourceFiles,
    options.repositories ?? [],
  );
  const activeCustomRules = collectConfiguredDiagnosticRules(
    options.bunestConfig,
    options.customRules,
    options.presetRules,
  );
  const custom =
    activeCustomRules.length > 0
      ? runCustomDiagnosticRules(activeCustomRules, {
          sourceFiles: options.sourceFiles,
          scan: options.scan,
          moduleGraph: options.moduleGraph,
          entities: options.entities ?? [],
          repositories: options.repositories ?? [],
        })
      : [];

  return [
    ...core,
    ...options.repositoryDiagnostics,
    ...macro,
    ...decorators,
    ...custom,
  ];
}

/**
 * Alias for `runAllBunestDiagnostics` used by CLI & IDE architecture checks.
 */
export function analyzeProjectDiagnostics(
  options: AnalyzeProjectDiagnosticsOptions,
): BunestDiagnostic[] {
  return runAllBunestDiagnostics(options);
}
