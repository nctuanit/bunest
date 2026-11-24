import type { Type } from "@bunest/core";
import type {
  InterfaceImplementsInput,
  PropertyMetadata,
  RegisterInOption,
} from "../interfaces/graphql.interface";

export interface StoredClassMetadata {
  target: Function;
  name: string;
  description?: string;
  isAbstract?: boolean;
  isOneOf?: boolean;
  inheritDescription?: boolean;
  registerIn?: RegisterInOption;
  properties?: PropertyMetadata[];
  directives?: Array<{ fieldName?: string; sdl: string }>;
  extensions?: Record<string, unknown>;
}

export interface StoredObjectTypeMetadata extends StoredClassMetadata {
  interfaces?: InterfaceImplementsInput;
}

export interface StoredInterfaceMetadata extends StoredClassMetadata {
  interfaces?: InterfaceImplementsInput;
  resolveType?: (...args: any[]) => unknown;
}

export interface StoredEnumMetadata {
  ref: object;
  name: string;
  description?: string;
  valuesMap?: Record<
    string,
    { description?: string; deprecationReason?: string }
  >;
  registerIn?: RegisterInOption;
  directives?: readonly string[];
}

export interface StoredUnionMetadata {
  id: symbol | string;
  name: string;
  typesFn: () => readonly Type<unknown>[];
  description?: string;
  resolveType?: (...args: any[]) => unknown;
  registerIn?: RegisterInOption;
  directives?: readonly string[];
}

export interface StoredResolverTypeMetadata {
  target: Function;
  methodName: string;
  schemaName: string;
  typeFn?: () => unknown;
  description?: string;
  deprecationReason?: string;
  options?: Record<string, unknown>;
}

export interface StoredFieldResolverMetadata {
  target: Function;
  methodName: string;
  schemaName: string;
  kind: "internal" | "external";
  typeFn?: () => unknown;
  description?: string;
  deprecationReason?: string;
  options?: Record<string, unknown>;
  complexity?: unknown;
  middleware?: unknown[];
}

export interface StoredResolverClassMetadata {
  target: Function;
  typeFn?: () => unknown;
  isAbstract?: boolean;
}

export interface StoredDirectiveMetadata {
  target: Function;
  fieldName?: string;
  sdl: string;
}

export interface StoredExtensionsMetadata {
  target: Function;
  fieldName?: string;
  value: Record<string, unknown>;
}

export interface StoredMethodParamMetadata {
  target: Function;
  methodName: string;
  index: number;
  name?: string;
  typeFn?: () => unknown;
  options?: Record<string, unknown>;
}

function resolveRegisterInModules(registerIn?: RegisterInOption): Function[] {
  if (!registerIn) return [];
  const items = Array.isArray(registerIn) ? registerIn : [registerIn];
  const resolved: Function[] = [];
  for (const item of items) {
    if (typeof item !== "function") continue;
    // Detect arrow thunk `() => MyModule` vs class constructor
    const isThunk =
      item.prototype === undefined ||
      (!Function.prototype.toString
        .call(item)
        .trimStart()
        .startsWith("class") &&
        item.length === 0);
    if (isThunk) {
      const val = (item as () => Function)();
      if (typeof val === "function") resolved.push(val);
    } else {
      resolved.push(item);
    }
  }
  return resolved;
}

/**
 * Central GraphQL code-first metadata registry mirroring `@nestjs/graphql`
 * `TypeMetadataStorageHost` / `TypeMetadataStorage`.
 */
export class TypeMetadataStorageHost {
  private queries: StoredResolverTypeMetadata[] = [];
  private mutations: StoredResolverTypeMetadata[] = [];
  private subscriptions: StoredResolverTypeMetadata[] = [];
  private fieldResolvers: StoredFieldResolverMetadata[] = [];
  private readonly resolvers: StoredResolverClassMetadata[] = [];
  private readonly objectTypes = new Map<Function, StoredObjectTypeMetadata>();
  private readonly inputTypes = new Map<Function, StoredClassMetadata>();
  private readonly interfaces = new Map<Function, StoredInterfaceMetadata>();
  private readonly argsTypes = new Map<Function, StoredClassMetadata>();
  private readonly enums: StoredEnumMetadata[] = [];
  private readonly unions: StoredUnionMetadata[] = [];
  private readonly propertiesByTarget = new Map<Function, PropertyMetadata[]>();
  private readonly directivesByTarget = new Map<
    Function,
    StoredDirectiveMetadata[]
  >();
  private readonly extensionsByTarget = new Map<
    Function,
    StoredExtensionsMetadata[]
  >();
  private readonly methodParams: StoredMethodParamMetadata[] = [];

  addMutationMetadata(metadata: StoredResolverTypeMetadata): void {
    this.mutations.push(metadata);
  }

  getMutationsMetadata(): StoredResolverTypeMetadata[] {
    return this.mutations;
  }

  addQueryMetadata(metadata: StoredResolverTypeMetadata): void {
    this.queries.push(metadata);
  }

  getQueriesMetadata(): StoredResolverTypeMetadata[] {
    return this.queries;
  }

  addSubscriptionMetadata(metadata: StoredResolverTypeMetadata): void {
    this.subscriptions.push(metadata);
  }

  getSubscriptionsMetadata(): StoredResolverTypeMetadata[] {
    return this.subscriptions;
  }

  addResolverPropertyMetadata(metadata: StoredFieldResolverMetadata): void {
    this.fieldResolvers.push(metadata);
  }

  getFieldResolversMetadata(): StoredFieldResolverMetadata[] {
    return this.fieldResolvers;
  }

  addArgsMetadata(metadata: StoredClassMetadata): void {
    this.argsTypes.set(metadata.target, metadata);
  }

  getArgumentsMetadata(): StoredClassMetadata[] {
    return [...this.argsTypes.values()];
  }

  getArgumentsMetadataByTarget(
    target: Type<unknown> | Function,
  ): StoredClassMetadata | undefined {
    return this.argsTypes.get(target);
  }

  addInterfaceMetadata(metadata: StoredInterfaceMetadata): void {
    this.interfaces.set(metadata.target, metadata);
  }

  getInterfacesMetadata(): StoredInterfaceMetadata[] {
    return [...this.interfaces.values()];
  }

  getInterfaceMetadataByTarget(
    target: Function,
  ): StoredInterfaceMetadata | undefined {
    return this.interfaces.get(target);
  }

  addInputTypeMetadata(metadata: StoredClassMetadata): void {
    this.inputTypes.set(metadata.target, metadata);
  }

  getInputTypesMetadata(): StoredClassMetadata[] {
    return [...this.inputTypes.values()];
  }

  getInputTypeMetadataByTarget(
    target: Type<unknown> | Function,
  ): StoredClassMetadata | undefined {
    return this.inputTypes.get(target);
  }

  addObjectTypeMetadata(metadata: StoredObjectTypeMetadata): void {
    this.objectTypes.set(metadata.target, metadata);
  }

  getObjectTypesMetadata(): StoredObjectTypeMetadata[] {
    return [...this.objectTypes.values()];
  }

  getObjectTypeMetadataByTarget(
    target: Type<unknown> | Function,
  ): StoredObjectTypeMetadata | undefined {
    return this.objectTypes.get(target);
  }

  addEnumMetadata(metadata: StoredEnumMetadata): void {
    const idx = this.enums.findIndex((e) => e.ref === metadata.ref);
    if (idx >= 0) {
      this.enums[idx] = metadata;
    } else {
      this.enums.push(metadata);
    }
  }

  getEnumsMetadata(): StoredEnumMetadata[] {
    return this.enums;
  }

  addUnionMetadata(metadata: StoredUnionMetadata): void {
    const idx = this.unions.findIndex((u) => u.name === metadata.name);
    if (idx >= 0) {
      this.unions[idx] = metadata;
    } else {
      this.unions.push(metadata);
    }
  }

  getUnionsMetadata(): StoredUnionMetadata[] {
    return this.unions;
  }

  private shouldIncludeInModules(
    registerIn: RegisterInOption | undefined,
    modules: Function[],
  ): boolean {
    if (!registerIn || modules.length === 0) {
      return true;
    }
    const allowed = resolveRegisterInModules(registerIn);
    if (allowed.length === 0) {
      return true;
    }
    return allowed.some((m) => modules.includes(m));
  }

  getObjectTypesMetadataByModules(
    modules: Function[],
  ): StoredObjectTypeMetadata[] {
    return this.getObjectTypesMetadata().filter((m) =>
      this.shouldIncludeInModules(m.registerIn, modules),
    );
  }

  getInputTypesMetadataByModules(modules: Function[]): StoredClassMetadata[] {
    return this.getInputTypesMetadata().filter((m) =>
      this.shouldIncludeInModules(m.registerIn, modules),
    );
  }

  getInterfacesMetadataByModules(
    modules: Function[],
  ): StoredInterfaceMetadata[] {
    return this.getInterfacesMetadata().filter((m) =>
      this.shouldIncludeInModules(m.registerIn, modules),
    );
  }

  getArgumentsMetadataByModules(modules: Function[]): StoredClassMetadata[] {
    return this.getArgumentsMetadata().filter((m) =>
      this.shouldIncludeInModules(m.registerIn, modules),
    );
  }

  getEnumsMetadataByModules(modules: Function[]): StoredEnumMetadata[] {
    return this.getEnumsMetadata().filter((m) =>
      this.shouldIncludeInModules(m.registerIn, modules),
    );
  }

  getUnionsMetadataByModules(modules: Function[]): StoredUnionMetadata[] {
    return this.getUnionsMetadata().filter((m) =>
      this.shouldIncludeInModules(m.registerIn, modules),
    );
  }

  addDirectiveMetadata(metadata: StoredDirectiveMetadata): void {
    const list = this.directivesByTarget.get(metadata.target) ?? [];
    list.push(metadata);
    this.directivesByTarget.set(metadata.target, list);
  }

  addDirectivePropertyMetadata(metadata: StoredDirectiveMetadata): void {
    this.addDirectiveMetadata(metadata);
  }

  addExtensionsMetadata(metadata: StoredExtensionsMetadata): void {
    const list = this.extensionsByTarget.get(metadata.target) ?? [];
    list.push(metadata);
    this.extensionsByTarget.set(metadata.target, list);
  }

  addExtensionsPropertyMetadata(metadata: StoredExtensionsMetadata): void {
    this.addExtensionsMetadata(metadata);
  }

  addResolverMetadata(metadata: StoredResolverClassMetadata): void {
    this.resolvers.push(metadata);
  }

  addClassFieldMetadata(metadata: PropertyMetadata): void {
    const list = this.propertiesByTarget.get(metadata.target) ?? [];
    const filtered = list.filter((p) => p.name !== metadata.name);
    filtered.push(metadata);
    this.propertiesByTarget.set(metadata.target, filtered);
  }

  addMethodParamMetadata(metadata: StoredMethodParamMetadata): void {
    this.methodParams.push(metadata);
  }

  compile(
    _orphanedTypes?: Array<Function | object>,
    _resolvers?: Function[],
  ): void {
    this.compileClassMetadata(this.getObjectTypesMetadata());
    this.compileClassMetadata(this.getInputTypesMetadata());
    this.compileClassMetadata(this.getInterfacesMetadata());
    this.compileClassMetadata(this.getArgumentsMetadata());
  }

  loadClassPluginMetadata(metadata: StoredClassMetadata[]): void {
    for (const item of metadata) {
      this.applyPluginMetadata(item.target);
    }
  }

  applyPluginMetadata(
    _prototype: Function,
    _loadedClasses?: Set<Function>,
  ): void {
    // Bunest relies on explicit decorator + TypeScript design metadata (ADR-002).
  }

  compileClassMetadata(
    metadata: StoredClassMetadata[],
    options?: { overrideFields?: boolean },
  ): void {
    for (const item of metadata) {
      if (item.properties && !options?.overrideFields) {
        continue;
      }
      const chain: Function[] = [];
      let current: Function | null = item.target;
      while (current && current !== Function.prototype && current !== Object) {
        chain.unshift(current);
        const parentProto = Object.getPrototypeOf(current.prototype);
        current =
          parentProto && parentProto !== Object.prototype
            ? parentProto.constructor
            : null;
      }
      const merged = new Map<string, PropertyMetadata>();
      for (const cls of chain) {
        for (const prop of this.propertiesByTarget.get(cls) ?? []) {
          merged.set(prop.name, prop);
        }
      }
      item.properties = [...merged.values()];
    }
  }

  clear(): void {
    this.queries = [];
    this.mutations = [];
    this.subscriptions = [];
    this.fieldResolvers = [];
    this.resolvers.length = 0;
    this.objectTypes.clear();
    this.inputTypes.clear();
    this.interfaces.clear();
    this.argsTypes.clear();
    this.enums.length = 0;
    this.unions.length = 0;
    this.propertiesByTarget.clear();
    this.directivesByTarget.clear();
    this.extensionsByTarget.clear();
    this.methodParams.length = 0;
  }
}

export const TypeMetadataStorage = new TypeMetadataStorageHost();
