import { createHash } from "node:crypto";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  DecoratorRegistry,
  METADATA_KEYS,
  MetadataRegistry,
  Module,
  Scope,
  isDynamicModule,
  isForwardReference,
  type AutoDiscoverOptions,
  type ClassProvider,
  type DynamicModule,
  type ExistingProvider,
  type FactoryProvider,
  type InjectableMetadata,
  type InjectionToken,
  type ModuleExport,
  type ModuleImport,
  type ModuleMetadata,
  type Provider,
  type Type,
  type ValueProvider,
} from "@bunest/common";
import {
  AmbiguousProviderException,
  CircularDependencyException,
  DuplicateProviderException,
  InvalidExportException,
  InvalidModuleException,
} from "../errors/core.exceptions";
import { formatToken } from "../errors/token-formatter";
import type {
  IEntryNestModule,
  NormalizedProvider,
} from "../interfaces/core-types.interface";
import { ModuleNode } from "./module-node";

function isPlainModuleMetadata(value: unknown): value is ModuleMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (isDynamicModule(value) || isForwardReference(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    "imports" in obj ||
    "controllers" in obj ||
    "providers" in obj ||
    "exports" in obj ||
    "autoDiscover" in obj ||
    Object.keys(obj).length === 0
  );
}

function hashDynamicModuleDefinition(
  metatype: Type<unknown>,
  dynamicMeta: DynamicModule,
): string {
  const tokenName = (t: unknown): string => {
    if (typeof t === "function") return t.name || "fn";
    if (typeof t === "symbol") return t.toString();
    if (typeof t === "string") return t;
    if (t && typeof t === "object" && "provide" in t) {
      return tokenName((t as { provide: unknown }).provide);
    }
    return String(t);
  };
  const payload = JSON.stringify({
    module: metatype.name || "Module",
    global: Boolean(dynamicMeta.global),
    controllers: (dynamicMeta.controllers ?? []).map(tokenName),
    providers: (dynamicMeta.providers ?? []).map(tokenName),
    exports: (dynamicMeta.exports ?? []).map(tokenName),
    importsCount: (dynamicMeta.imports ?? []).length,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export const MULTI_PROVIDER_TOKENS: ReadonlySet<InjectionToken> = new Set([
  APP_GUARD,
  APP_PIPE,
  APP_INTERCEPTOR,
  APP_FILTER,
]);

export function getInjectableScope(target: Type<unknown>): Scope {
  const meta = MetadataRegistry.get<InjectableMetadata>(
    METADATA_KEYS.INJECTABLE,
    target,
  );
  return meta?.scope ?? Scope.SINGLETON;
}

export function isInjectableDurable(target: Type<unknown>): boolean {
  const meta = MetadataRegistry.get<InjectableMetadata>(
    METADATA_KEYS.INJECTABLE,
    target,
  );
  return meta?.durable === true;
}

export function isProviderObject(
  value: unknown,
): value is ClassProvider | ValueProvider | FactoryProvider | ExistingProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    "provide" in value &&
    ("useClass" in value ||
      "useValue" in value ||
      "useFactory" in value ||
      "useExisting" in value)
  );
}

export function normalizeProvider<T = unknown>(
  provider: Provider<T>,
): NormalizedProvider<T> {
  if (typeof provider === "function") {
    const durable = isInjectableDurable(provider);
    return {
      token: provider,
      kind: "class",
      useClass: provider,
      scope: getInjectableScope(provider),
      ...(durable ? { durable: true } : {}),
      isMulti: MULTI_PROVIDER_TOKENS.has(provider),
    };
  }

  const isMulti = MULTI_PROVIDER_TOKENS.has(provider.provide);

  if ("useValue" in provider) {
    return {
      token: provider.provide,
      kind: "value",
      useValue: provider.useValue,
      scope: Scope.SINGLETON,
      isMulti,
    };
  }

  if ("useClass" in provider) {
    const durable =
      provider.durable !== undefined
        ? provider.durable
        : isInjectableDurable(provider.useClass);
    return {
      token: provider.provide,
      kind: "class",
      useClass: provider.useClass,
      scope: provider.scope ?? getInjectableScope(provider.useClass),
      ...(durable ? { durable: true } : {}),
      inject: provider.inject,
      isMulti,
    };
  }

  if ("useFactory" in provider) {
    return {
      token: provider.provide,
      kind: "factory",
      useFactory: provider.useFactory,
      inject: provider.inject,
      scope: provider.scope ?? Scope.SINGLETON,
      ...(provider.durable ? { durable: true } : {}),
      isMulti,
    };
  }

  if ("useExisting" in provider) {
    return {
      token: provider.provide,
      kind: "existing",
      useExisting: provider.useExisting,
      scope: Scope.SINGLETON,
      isMulti,
    };
  }

  throw new Error(
    `Invalid provider definition: ${formatToken(provider)}. Expected a class or { provide, useClass | useValue | useFactory | useExisting }.`,
  );
}

export interface ModuleScanOptions {
  moduleOverrides?: Map<
    Type<unknown> | DynamicModule,
    Type<unknown> | DynamicModule
  >;
  /**
   * Optional pre-existing static modules to reuse without rescanning
   * (used by `LazyModuleLoader` to share singletons with the live app).
   */
  existingStaticNodes?: ReadonlyMap<Type<unknown>, ModuleNode>;
  /**
   * Optional pre-existing dynamic modules to reuse without rescanning.
   */
  existingDynamicNodes?: ReadonlyMap<DynamicModule, ModuleNode>;
  /**
   * Optional ID prefix ensuring newly scanned lazy module IDs never collide
   * with existing module graph IDs.
   */
  idPrefix?: string;
  /**
   * Module ID generation algorithm (`"reference"` or `"deep-hash"`).
   * @default "reference"
   */
  moduleIdGeneratorAlgorithm?: "deep-hash" | "reference";
}

export interface ScannedModuleGraph {
  readonly root: ModuleNode;
  readonly modules: ReadonlyMap<string, ModuleNode>;
  readonly topologicalOrder: readonly ModuleNode[];
  readonly globalModules: readonly ModuleNode[];
  readonly staticModuleMap?: ReadonlyMap<Type<unknown>, ModuleNode>;
  readonly dynamicModuleMap?: ReadonlyMap<DynamicModule, ModuleNode>;
}

interface PendingModuleWork {
  node: ModuleNode;
  rawImports: ModuleImport[];
  rawExports: ModuleExport[];
  autoDiscover?: boolean | AutoDiscoverOptions;
}

/**
 * Recursively scans static `@Module()` classes, `DynamicModule`s (sync/async),
 * `@Global()` modules, `forwardRef()` module cycles, validates exports, and computes
 * deterministic topological bootstrap ordering per ADR-007.
 */
export class ModuleScanner {
  private readonly staticNodes = new Map<Type<unknown>, ModuleNode>();
  private readonly dynamicNodes = new Map<DynamicModule, ModuleNode>();
  private readonly allNodes = new Map<string, ModuleNode>();
  private readonly pendingWork = new Map<ModuleNode, PendingModuleWork>();
  private moduleOverrides?: Map<
    Type<unknown> | DynamicModule,
    Type<unknown> | DynamicModule
  >;
  private idPrefix = "";
  private dynamicCounter = 0;
  private idAlgorithm: "deep-hash" | "reference" = "reference";

  async scan(
    rootModule: IEntryNestModule,
    options?: ModuleScanOptions,
  ): Promise<ScannedModuleGraph> {
    this.moduleOverrides = options?.moduleOverrides;
    this.idPrefix = options?.idPrefix ?? "";
    this.idAlgorithm = options?.moduleIdGeneratorAlgorithm ?? "reference";

    if (options?.existingStaticNodes) {
      for (const [cls, node] of options.existingStaticNodes.entries()) {
        this.staticNodes.set(cls, node);
        this.allNodes.set(node.id, node);
      }
    }
    if (options?.existingDynamicNodes) {
      for (const [dyn, node] of options.existingDynamicNodes.entries()) {
        this.dynamicNodes.set(dyn, node);
        this.allNodes.set(node.id, node);
      }
    }

    let resolvedRoot: unknown = await rootModule;
    if (isForwardReference(resolvedRoot)) {
      resolvedRoot = resolvedRoot.forwardRef();
    }
    if (isPlainModuleMetadata(resolvedRoot)) {
      class InlineRootModule {}
      Module(resolvedRoot)(InlineRootModule);
      resolvedRoot = InlineRootModule;
    }

    const rootNode = await this.scanModule(
      resolvedRoot as ModuleImport,
      [],
      false,
    );

    // Second pass: link deferred forwardRef imports now that nodes exist
    await this.linkDeferredForwardRefImports();

    // Pass 2.5: expand @AutoModule / autoDiscover modules from DecoratorRegistry
    this.applyAutoDiscovery();

    // Third pass: register & validate exports across all scanned modules
    await this.processAndValidateExports();

    const topologicalOrder = this.computeTopologicalOrder(rootNode);
    const globalModules = topologicalOrder.filter((node) => node.isGlobal);

    return {
      root: rootNode,
      modules: this.allNodes,
      topologicalOrder,
      globalModules,
      staticModuleMap: this.staticNodes,
      dynamicModuleMap: this.dynamicNodes,
    };
  }

  private resolveModuleOverride(target: unknown): unknown {
    if (!this.moduleOverrides || this.moduleOverrides.size === 0) {
      return target;
    }

    let current = target;
    const visited = new Set<unknown>();

    while (
      current !== undefined &&
      current !== null &&
      !visited.has(current)
    ) {
      visited.add(current);

      if (isDynamicModule(current)) {
        if (this.moduleOverrides.has(current)) {
          current = this.moduleOverrides.get(current)!;
          continue;
        }
        if (this.moduleOverrides.has(current.module)) {
          current = this.moduleOverrides.get(current.module)!;
          continue;
        }
        break;
      }

      if (typeof current === "function") {
        const asType = current as Type<unknown>;
        if (this.moduleOverrides.has(asType)) {
          current = this.moduleOverrides.get(asType)!;
          continue;
        }
        break;
      }

      break;
    }

    return current;
  }

  private async scanModule(
    rawInput: ModuleImport,
    activeStack: Array<{ key: object; name: string }>,
    viaForwardRef: boolean,
  ): Promise<ModuleNode> {
    let target: unknown = rawInput;
    let usedForwardRef = viaForwardRef;

    if (isForwardReference(target)) {
      usedForwardRef = true;
      target = target.forwardRef();
    }

    if (target instanceof Promise) {
      target = await target;
    }

    if (isForwardReference(target)) {
      usedForwardRef = true;
      target = target.forwardRef();
    }

    // Apply module overrides before scanning/deduplication (supports static, DynamicModule ref, DynamicModule.module class, and chained overrides)
    target = this.resolveModuleOverride(target);

    if (target instanceof Promise) {
      target = await target;
      target = this.resolveModuleOverride(target);
    }

    let metatype: Type<unknown>;
    let dynamicMeta: DynamicModule | undefined;
    let staticMeta: ModuleMetadata | undefined;
    let identityKey: object;

    if (isDynamicModule(target)) {
      dynamicMeta = target;
      metatype = target.module;
      if (typeof metatype !== "function") {
        throw new InvalidModuleException(
          target,
          "DynamicModule.module must be a class constructor",
        );
      }
      staticMeta = MetadataRegistry.get<ModuleMetadata>(
        METADATA_KEYS.MODULE,
        metatype,
      );
      identityKey = target;
    } else if (typeof target === "function") {
      metatype = target as Type<unknown>;
      staticMeta = MetadataRegistry.get<ModuleMetadata>(
        METADATA_KEYS.MODULE,
        metatype,
      );
      if (!staticMeta) {
        throw new InvalidModuleException(metatype);
      }
      identityKey = metatype;
    } else {
      throw new InvalidModuleException(
        target,
        "expected a @Module() class or DynamicModule",
      );
    }

    // Check unwrapped circular module import
    const cycleIdx = activeStack.findIndex((item) => item.key === identityKey);
    if (cycleIdx !== -1) {
      if (!usedForwardRef) {
        const chain = [
          ...activeStack.slice(cycleIdx).map((item) => item.name),
          metatype.name || "<anonymous>",
        ];
        throw new CircularDependencyException({
          chain,
          kind: "module",
        });
      }
      // Permitted forwardRef cycle: return the already-created node
      const existing = dynamicMeta
        ? this.dynamicNodes.get(dynamicMeta)
        : this.staticNodes.get(metatype);
      if (existing) {
        return existing;
      }
    }

    // Deduplicate existing registrations (ADR-007 §3)
    if (dynamicMeta) {
      const existing = this.dynamicNodes.get(dynamicMeta);
      if (existing) {
        return existing;
      }
    } else {
      const existing = this.staticNodes.get(metatype);
      if (existing) {
        return existing;
      }
    }

    const isGlobal = Boolean(
      dynamicMeta?.global ||
        MetadataRegistry.get<boolean>(METADATA_KEYS.GLOBAL_MODULE, metatype),
    );
    const id =
      this.idAlgorithm === "deep-hash"
        ? dynamicMeta
          ? `${this.idPrefix}hash:${metatype.name || "Module"}:${hashDynamicModuleDefinition(metatype, dynamicMeta)}`
          : `${this.idPrefix}hash:${metatype.name || "Module"}`
        : dynamicMeta
          ? `${this.idPrefix}dynamic:${metatype.name || "Module"}#${++this.dynamicCounter}`
          : `${this.idPrefix}static:${metatype.name || "Module"}#${this.allNodes.size + 1}`;

    const node = new ModuleNode(id, metatype, isGlobal, Boolean(dynamicMeta));
    this.allNodes.set(id, node);
    if (dynamicMeta) {
      this.dynamicNodes.set(dynamicMeta, node);
    } else {
      this.staticNodes.set(metatype, node);
    }

    // Merge static @Module metadata with DynamicModule fields
    const mergedImports: ModuleImport[] = [
      ...(staticMeta?.imports ?? []),
      ...(dynamicMeta?.imports ?? []),
    ];
    const mergedControllers: Type<unknown>[] = [
      ...(staticMeta?.controllers ?? []),
      ...(dynamicMeta?.controllers ?? []),
    ];
    const mergedProviders: Provider[] = [
      ...(staticMeta?.providers ?? []),
      ...(dynamicMeta?.providers ?? []),
    ];
    const mergedExports: ModuleExport[] = [
      ...(staticMeta?.exports ?? []),
      ...(dynamicMeta?.exports ?? []),
    ];

    // Register controllers (deduplicated per module)
    const seenControllers = new Set<Type<unknown>>();
    for (const ctrl of mergedControllers) {
      if (!seenControllers.has(ctrl)) {
        seenControllers.add(ctrl);
        node.controllers.push(ctrl);
      }
    }

    // Register local providers (detect duplicates for non-multi tokens)
    for (const rawProvider of mergedProviders) {
      this.registerProviderOnNode(node, rawProvider);
    }

    const autoDiscover =
      dynamicMeta?.autoDiscover !== undefined
        ? dynamicMeta.autoDiscover
        : staticMeta?.autoDiscover;

    this.pendingWork.set(node, {
      node,
      rawImports: mergedImports,
      rawExports: mergedExports,
      ...(autoDiscover !== undefined ? { autoDiscover } : {}),
    });

    const nextStack = [
      ...activeStack,
      { key: identityKey, name: node.name },
    ];

    // Scan eager (non-forwardRef) imports immediately; defer forwardRef imports to pass 2
    for (const imp of mergedImports) {
      if (isForwardReference(imp)) {
        continue;
      }
      const importedNode = await this.scanModule(imp, nextStack, false);
      if (!node.imports.includes(importedNode)) {
        node.imports.push(importedNode);
      }
    }

    return node;
  }

  private async linkDeferredForwardRefImports(): Promise<void> {
    // Repeat until fixed point in case a forwardRef points to a not-yet-scanned module
    const processed = new Set<string>();
    let changed = true;

    while (changed) {
      changed = false;
      for (const work of [...this.pendingWork.values()]) {
        for (let i = 0; i < work.rawImports.length; i++) {
          const imp = work.rawImports[i];
          if (!imp || !isForwardReference(imp)) {
            continue;
          }
          const edgeKey = `${work.node.id}::${i}`;
          if (processed.has(edgeKey)) {
            continue;
          }
          processed.add(edgeKey);
          changed = true;
          const importedNode = await this.scanModule(
            imp,
            [{ key: work.node.metatype, name: work.node.name }],
            true,
          );
          if (!work.node.imports.includes(importedNode)) {
            work.node.imports.push(importedNode);
          }
        }
      }
    }
  }

  private applyAutoDiscovery(): void {
    const autoModules: PendingModuleWork[] = [];
    for (const work of this.pendingWork.values()) {
      if (work.autoDiscover) {
        autoModules.push(work);
      }
    }
    if (autoModules.length === 0) {
      return;
    }

    const declaredControllers = new Set<Type<unknown>>();
    const declaredProviders = new Set<InjectionToken>();

    for (const node of this.allNodes.values()) {
      for (const ctrl of node.controllers) {
        declaredControllers.add(ctrl);
      }
      for (const [token, prov] of node.providers.entries()) {
        declaredProviders.add(token);
        if (prov.useClass) {
          declaredProviders.add(prov.useClass);
        }
      }
      for (const [token, list] of node.multiProviders.entries()) {
        declaredProviders.add(token);
        for (const prov of list) {
          if (prov.useClass) {
            declaredProviders.add(prov.useClass);
          }
        }
      }
    }

    for (const work of autoModules) {
      const opts: AutoDiscoverOptions =
        work.autoDiscover === true ? {} : (work.autoDiscover as AutoDiscoverOptions);
      const discoverControllers = opts.controllers !== false;
      const discoverProviders = opts.providers !== false;
      const excludeSet = new Set<Function>(opts.exclude ?? []);
      const hasIncludeFilter = opts.include !== undefined;
      const includeList = opts.include ?? [];

      if (discoverControllers) {
        const candidateControllers: Type<unknown>[] = hasIncludeFilter
          ? includeList.filter((cls) =>
              MetadataRegistry.has(METADATA_KEYS.CONTROLLER, cls),
            )
          : DecoratorRegistry.getControllers();

        for (let i = 0; i < candidateControllers.length; i++) {
          const ctrl = candidateControllers[i]!;
          if (
            excludeSet.has(ctrl) ||
            (!hasIncludeFilter && DecoratorRegistry.isInternal(ctrl)) ||
            declaredControllers.has(ctrl) ||
            MetadataRegistry.has(METADATA_KEYS.MODULE, ctrl)
          ) {
            continue;
          }
          work.node.controllers.push(ctrl);
          declaredControllers.add(ctrl);
        }
      }

      if (discoverProviders) {
        const candidateProviders: Type<unknown>[] = hasIncludeFilter
          ? includeList.filter(
              (cls) => !MetadataRegistry.has(METADATA_KEYS.CONTROLLER, cls),
            )
          : DecoratorRegistry.getInjectables();

        for (let i = 0; i < candidateProviders.length; i++) {
          const prov = candidateProviders[i]!;
          if (
            excludeSet.has(prov) ||
            (!hasIncludeFilter && DecoratorRegistry.isInternal(prov)) ||
            declaredProviders.has(prov) ||
            declaredControllers.has(prov) ||
            MetadataRegistry.has(METADATA_KEYS.CONTROLLER, prov) ||
            MetadataRegistry.has(METADATA_KEYS.MODULE, prov)
          ) {
            continue;
          }
          this.registerProviderOnNode(work.node, prov);
          declaredProviders.add(prov);
        }
      }
    }
  }

  private async processAndValidateExports(): Promise<void> {
    // Pass 3a: record provider exports, re-exported modules, and token exports
    const tokenExportsToValidate: Array<{
      node: ModuleNode;
      token: InjectionToken;
    }> = [];

    for (const work of this.pendingWork.values()) {
      const { node, rawExports } = work;

      for (let rawExp of rawExports) {
        if (isForwardReference(rawExp)) {
          rawExp = rawExp.forwardRef();
        }
        if (rawExp instanceof Promise) {
          rawExp = await rawExp;
        }
        const overriddenExp = this.resolveModuleOverride(rawExp);
        if (overriddenExp !== rawExp) {
          rawExp = overriddenExp as ModuleExport;
        }

        // Case 1: DynamicModule re-export
        if (isDynamicModule(rawExp)) {
          const importedDynamic = this.findImportedModule(node, rawExp);
          if (!importedDynamic) {
            throw new InvalidExportException(
              rawExp.module,
              node.name,
              `re-exported DynamicModule "${rawExp.module.name}" is not present in "${node.name}.imports"`,
            );
          }
          if (!node.reExportedModules.includes(importedDynamic)) {
            node.reExportedModules.push(importedDynamic);
          }
          continue;
        }

        // Case 2: Provider object directly listed in exports (ADR-007 §2.3)
        if (isProviderObject(rawExp)) {
          const normalized = normalizeProvider(rawExp);
          if (
            !normalized.isMulti &&
            !node.providers.has(normalized.token)
          ) {
            node.providers.set(normalized.token, normalized);
          } else if (normalized.isMulti) {
            const list = node.multiProviders.get(normalized.token) ?? [];
            list.push(normalized);
            node.multiProviders.set(normalized.token, list);
          }
          node.exportedTokens.add(normalized.token);
          continue;
        }

        // Case 3: Static module class re-export
        if (
          typeof rawExp === "function" &&
          MetadataRegistry.has(METADATA_KEYS.MODULE, rawExp)
        ) {
          const importedStatic = this.findImportedModule(
            node,
            rawExp as Type<unknown>,
          );
          if (!importedStatic) {
            throw new InvalidExportException(
              rawExp,
              node.name,
              `re-exported module "${rawExp.name}" is not present in "${node.name}.imports"`,
            );
          }
          if (!node.reExportedModules.includes(importedStatic)) {
            node.reExportedModules.push(importedStatic);
          }
          continue;
        }

        // Case 4: InjectionToken (class, abstract class, string, symbol)
        if (
          typeof rawExp === "function" ||
          typeof rawExp === "string" ||
          typeof rawExp === "symbol"
        ) {
          const token = rawExp as InjectionToken;
          node.exportedTokens.add(token);
          tokenExportsToValidate.push({ node, token });
          continue;
        }

        throw new InvalidExportException(
          rawExp,
          node.name,
          "unsupported export entry",
        );
      }
    }

    // Pass 3b: verify every exported token exists locally OR in an imported module's effective exports
    for (const { node, token } of tokenExportsToValidate) {
      if (node.providers.has(token)) {
        continue;
      }

      let foundInImports = false;
      for (const imported of node.imports) {
        if (imported.getEffectiveExports().has(token)) {
          foundInImports = true;
          break;
        }
      }

      if (!foundInImports) {
        throw new InvalidExportException(
          token,
          node.name,
          `token is neither declared in "${node.name}.providers" nor exported by any module in "${node.name}.imports"`,
        );
      }
    }
  }

  private findImportedModule(
    node: ModuleNode,
    target: Type<unknown> | DynamicModule,
  ): ModuleNode | undefined {
    if (isDynamicModule(target)) {
      const exactNode = this.dynamicNodes.get(target);
      if (exactNode && node.imports.includes(exactNode)) {
        return exactNode;
      }
      return node.imports.find(
        (imp) => imp.isDynamic && imp.metatype === target.module,
      );
    }

    return node.imports.find((imp) => imp.metatype === target);
  }

  private registerProviderOnNode(
    node: ModuleNode,
    rawProvider: Provider,
  ): void {
    const normalized = normalizeProvider(rawProvider);
    if (normalized.isMulti) {
      const existing = node.multiProviders.get(normalized.token) ?? [];
      existing.push(normalized);
      node.multiProviders.set(normalized.token, existing);
      return;
    }

    if (node.providers.has(normalized.token)) {
      throw new DuplicateProviderException(normalized.token, node.name);
    }

    node.providers.set(normalized.token, normalized);
  }

  /**
   * Post-order DFS traversal yields dependencies before dependents (bottom-up topological order).
   */
  private computeTopologicalOrder(root: ModuleNode): ModuleNode[] {
    const visited = new Set<ModuleNode>();
    const order: ModuleNode[] = [];

    const visit = (node: ModuleNode) => {
      if (visited.has(node)) {
        return;
      }
      visited.add(node);
      for (const imp of node.imports) {
        visit(imp);
      }
      order.push(node);
    };

    visit(root);
    return order;
  }

  /**
   * Resolves which ModuleNode owns `token` as seen from `requestingModule`
   * following strict ADR-007 §5 precedence: local > direct imports > @Global().
   */
  static resolveProviderLocation(
    requestingModule: ModuleNode,
    token: InjectionToken,
    globalModules: readonly ModuleNode[],
  ): { owner: ModuleNode; provider: NormalizedProvider } | undefined {
    // 1. Local provider always wins (shadows imports & globals)
    const local = requestingModule.providers.get(token);
    if (local) {
      return { owner: requestingModule, provider: local };
    }

    // 2. Direct non-global imports (including transitive re-exports)
    // (@Global() modules are evaluated at tier 3 so registering a @Global() module
    // in AppModule.imports does not falsely collide with AppModule's direct imports.)
    const importOwners = new Set<ModuleNode>();
    for (const imported of requestingModule.imports) {
      if (imported.isGlobal) {
        continue;
      }
      const exportsMap = imported.getEffectiveExports();
      const owners = exportsMap.get(token);
      if (owners) {
        for (const owner of owners) {
          importOwners.add(owner);
        }
      }
    }

    if (importOwners.size === 1) {
      const [owner] = importOwners;
      const provider = owner?.providers.get(token);
      if (owner && provider) {
        return { owner, provider };
      }
    } else if (importOwners.size > 1) {
      throw new AmbiguousProviderException({
        token,
        moduleName: requestingModule.name,
        conflictingModules: [...importOwners].map((m) => m.name),
        source: "imports",
      });
    }

    // 3. Global modules (only their effective exports)
    const globalOwners = new Set<ModuleNode>();
    for (const globalMod of globalModules) {
      if (globalMod === requestingModule) {
        continue;
      }
      const exportsMap = globalMod.getEffectiveExports();
      const owners = exportsMap.get(token);
      if (owners) {
        for (const owner of owners) {
          globalOwners.add(owner);
        }
      }
    }

    if (globalOwners.size === 1) {
      const [owner] = globalOwners;
      const provider = owner?.providers.get(token);
      if (owner && provider) {
        return { owner, provider };
      }
    } else if (globalOwners.size > 1) {
      throw new AmbiguousProviderException({
        token,
        moduleName: requestingModule.name,
        conflictingModules: [...globalOwners].map((m) => m.name),
        source: "global",
      });
    }

    return undefined;
  }
}
