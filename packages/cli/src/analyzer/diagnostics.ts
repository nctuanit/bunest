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
import type { StaticModuleGraph, StaticModuleNode } from "./module-graph";
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
  | "BUNEST007";

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

function runCoreDiagnostics(
  sourceFiles: readonly SourceFile[],
  scan: TypegenScanResult,
  graph: StaticModuleGraph,
): BunestDiagnostic[] {
  const diagnostics: BunestDiagnostic[] = [];
  const hasAutoDiscoverModule = graph.modules.some((m) => m.autoDiscover);

  // Map each provider/controller -> declaring modules
  const modulesForClass = new Map<string, StaticModuleNode[]>();
  for (const mod of graph.modules) {
    for (const name of [...mod.providers, ...mod.controllers, ...mod.imports]) {
      const list = modulesForClass.get(name) ?? [];
      list.push(mod);
      modulesForClass.set(name, list);
    }
  }

  // BUNEST001, BUNEST003, BUNEST004 on every provider/controller constructor
  for (const prov of graph.providers) {
    const declaringModules = modulesForClass.get(prov.name) ?? [];
    const visibleSets = declaringModules.map((m) =>
      collectVisibleProvidersForModule(m, graph),
    );

    for (const dep of prov.dependencies) {
      // BUNEST004: `import type` breaks `emitDecoratorMetadata` constructor injection
      if (
        dep.isTypeOnlyImport &&
        !dep.token &&
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

      // Skip primitive / explicit string-token deps for provider-graph checks
      if (dep.token || PRIMITIVE_OR_BUILTIN_TYPES.has(dep.typeName)) {
        continue;
      }

      const targetProv = graph.providerByName.get(dep.typeName);
      if (!targetProv) continue;

      // BUNEST003: Scope leak (SINGLETON injecting REQUEST-scoped provider)
      if (prov.scope === "SINGLETON" && targetProv.scope === "REQUEST") {
        diagnostics.push({
          code: "BUNEST003",
          severity: "warning",
          message: `Scope leak: SINGLETON "${prov.name}" injects REQUEST-scoped "${targetProv.name}". This forces "${prov.name}" (and its dependents) to be instantiated per request.`,
          location: dep.location,
        });
      }

      // BUNEST001: Missing provider/export in declaring @Module
      if (
        !dep.isOptional &&
        !hasAutoDiscoverModule &&
        declaringModules.length > 0
      ) {
        const isVisibleSomewhere = visibleSets.some((set) =>
          set.has(targetProv.name),
        );
        if (!isVisibleSomewhere) {
          const primaryMod = declaringModules[0]!;
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
 * - Core (`BUNEST001`–`BUNEST007`)
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
