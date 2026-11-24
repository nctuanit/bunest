import type { Type } from "../interfaces/type.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";

const SWAGGER_API_PROPERTIES_KEY = Symbol.for("bunest:swagger:api_properties");
const MAPPED_TYPE_HOOKS_KEY = Symbol.for("bunest:mapped_types:hooks");
const CT_CLONED_REGISTRY_KEY = Symbol.for("bunest:mapped_types:ct_cloned");

interface ClassTransformerMetadataEntry {
  target: Function;
  propertyName?: string;
  [key: string]: unknown;
}

interface ClassTransformerStorageLike {
  _typeMetadatas?: Map<
    Function,
    Map<string | undefined, ClassTransformerMetadataEntry>
  >;
  _exposeMetadatas?: Map<
    Function,
    Map<string | undefined, ClassTransformerMetadataEntry>
  >;
  _excludeMetadatas?: Map<
    Function,
    Map<string | undefined, ClassTransformerMetadataEntry>
  >;
  _transformMetadatas?: Map<
    Function,
    Map<string | undefined, ClassTransformerMetadataEntry[]>
  >;
  addTypeMetadata(meta: ClassTransformerMetadataEntry): void;
  addExposeMetadata(meta: ClassTransformerMetadataEntry): void;
  addExcludeMetadata(meta: ClassTransformerMetadataEntry): void;
  addTransformMetadata(meta: ClassTransformerMetadataEntry): void;
  cloneClassMetadata?(
    source: Function,
    target: Function,
    propertyFilter?: (propertyName: string) => boolean,
    stackTransforms?: boolean,
  ): string[];
  getDecoratedPropertyNames?(target: Function): string[];
}

interface ClassValidatorModuleLike {
  IsOptional?: () => PropertyDecorator;
  ValidateIf?: (
    condition: (object: any, value: any) => boolean,
  ) => PropertyDecorator;
  getMetadataStorage?: () => ClassValidatorStorageLike;
}

const NATIVE_CV_STORAGE_SYMBOL = Symbol.for("bunest:class-validator:storage");
const NATIVE_CT_STORAGE_SYMBOL = Symbol.for("bunest:class-transformer:storage");
const NATIVE_CV_ENGINE_SYMBOL = Symbol.for("bunest:class-validator:engine");

let cachedUpstreamTransformerStorages: ClassTransformerStorageLike[] | undefined;
let cachedClassValidatorModule: ClassValidatorModuleLike | null | undefined;

function tryRequire(specifier: string): unknown {
  const bases = [import.meta.dir, process.cwd()];
  for (let i = 0; i < bases.length; i++) {
    const base = bases[i];
    if (!base) continue;
    try {
      const resolved = Bun.resolveSync(specifier, base);
      return require(resolved);
    } catch {
      // Try next resolution root
    }
  }
  return undefined;
}

function getClassValidatorModule(): ClassValidatorModuleLike | undefined {
  if (cachedClassValidatorModule !== undefined) {
    return cachedClassValidatorModule ?? undefined;
  }
  const mod = tryRequire(["class", "validator"].join("-")) as
    ClassValidatorModuleLike | undefined;
  cachedClassValidatorModule = mod ?? null;
  return mod;
}

function getNativeValidatorEngineMod(): ClassValidatorModuleLike | undefined {
  const g = globalThis as Record<PropertyKey, unknown>;
  const eng = g[NATIVE_CV_ENGINE_SYMBOL] as ClassValidatorModuleLike | undefined;
  return eng && typeof eng === "object" ? eng : undefined;
}

function getClassTransformerStorages(): readonly ClassTransformerStorageLike[] {
  const storages: ClassTransformerStorageLike[] = [];
  const seen = new Set<unknown>();

  // 1. Bunest native single-realm storage (ADR-015)
  const g = globalThis as Record<PropertyKey, unknown>;
  const nativeStorage = g[NATIVE_CT_STORAGE_SYMBOL] as
    | Partial<ClassTransformerStorageLike>
    | undefined;
  if (
    nativeStorage &&
    typeof nativeStorage.addTypeMetadata === "function" &&
    typeof nativeStorage.addExposeMetadata === "function" &&
    typeof nativeStorage.addExcludeMetadata === "function" &&
    typeof nativeStorage.addTransformMetadata === "function"
  ) {
    seen.add(nativeStorage);
    storages.push(nativeStorage as ClassTransformerStorageLike);
  }

  // 2. Upstream class-transformer storages (if installed)
  if (cachedUpstreamTransformerStorages === undefined) {
    const upstream: ClassTransformerStorageLike[] = [];
    for (const variant of ["cjs", "esm5"]) {
      const specifier = ["class-transformer", variant, "storage"].join("/");
      const mod = tryRequire(specifier) as
        | { defaultMetadataStorage?: Partial<ClassTransformerStorageLike> }
        | undefined;
      const storage = mod?.defaultMetadataStorage;
      if (
        storage &&
        !seen.has(storage) &&
        typeof storage.addTypeMetadata === "function" &&
        typeof storage.addExposeMetadata === "function" &&
        typeof storage.addExcludeMetadata === "function" &&
        typeof storage.addTransformMetadata === "function"
      ) {
        seen.add(storage);
        upstream.push(storage as ClassTransformerStorageLike);
      }
    }
    cachedUpstreamTransformerStorages = upstream;
  }

  for (const s of cachedUpstreamTransformerStorages) {
    if (!seen.has(s)) {
      seen.add(s);
      storages.push(s);
    }
  }

  return storages;
}

function markClassTransformerStorageCloned(
  source: Function,
  target: Function,
  storage: object,
): boolean {
  const g = globalThis as Record<PropertyKey, unknown>;
  let byTarget = g[CT_CLONED_REGISTRY_KEY] as
    WeakMap<Function, WeakMap<Function, WeakSet<object>>> | undefined;
  if (!byTarget) {
    byTarget = new WeakMap();
    g[CT_CLONED_REGISTRY_KEY] = byTarget;
  }
  let bySource = byTarget.get(target);
  if (!bySource) {
    bySource = new WeakMap();
    byTarget.set(target, bySource);
  }
  let storages = bySource.get(source);
  if (!storages) {
    storages = new WeakSet();
    bySource.set(source, storages);
  }
  if (storages.has(storage)) {
    return false;
  }
  storages.add(storage);
  return true;
}

function cloneTransformerEntry(
  meta: ClassTransformerMetadataEntry,
  target: Function,
): ClassTransformerMetadataEntry {
  return {
    ...meta,
    target,
    ...(meta.options && typeof meta.options === "object"
      ? { options: { ...(meta.options as Record<string, unknown>) } }
      : {}),
  };
}

interface ClassValidatorMetadataLike {
  type: string;
  name?: string;
  target: Function | string;
  propertyName: string;
  constraints?: unknown[];
  constraintCls?: Function;
  validationTypeOptions?: unknown;
  groups?: string[];
  each?: boolean;
  context?: unknown;
  message?: unknown;
  always?: boolean;
}

interface ClassValidatorStorageLike {
  getTargetValidationMetadatas(
    targetConstructor: Function,
    targetSchema: string,
    always: boolean,
    strictGroups: boolean,
    groups?: string[],
  ): ClassValidatorMetadataLike[];
  addValidationMetadata(meta: ClassValidatorMetadataLike): void;
}

interface SwaggerApiPropertyLike {
  readonly propertyKey: string;
  readonly required?: boolean;
  [key: string]: unknown;
}

export type MappedTypeOperation =
  "partial" | "pick" | "omit" | "intersection" | "composition";

export type MappedTypeMetadataHook = (context: {
  readonly operation: MappedTypeOperation;
  readonly source: Type<unknown>;
  readonly target: Type<unknown>;
  readonly propertyFilter?: (propertyKey: string) => boolean;
}) => void;

function getClassValidatorStorages(): ClassValidatorStorageLike[] {
  const storages: ClassValidatorStorageLike[] = [];
  const seen = new Set<unknown>();
  const g = globalThis as Record<PropertyKey, unknown>;

  const nativeStorage = g[NATIVE_CV_STORAGE_SYMBOL] as
    | Partial<ClassValidatorStorageLike>
    | undefined;
  if (
    nativeStorage &&
    typeof nativeStorage.getTargetValidationMetadatas === "function" &&
    typeof nativeStorage.addValidationMetadata === "function"
  ) {
    seen.add(nativeStorage);
    storages.push(nativeStorage as ClassValidatorStorageLike);
  }

  const globalUpstream = g.classValidatorMetadataStorage as
    | Partial<ClassValidatorStorageLike>
    | undefined;
  if (
    globalUpstream &&
    !seen.has(globalUpstream) &&
    typeof globalUpstream.getTargetValidationMetadatas === "function" &&
    typeof globalUpstream.addValidationMetadata === "function"
  ) {
    seen.add(globalUpstream);
    storages.push(globalUpstream as ClassValidatorStorageLike);
  }

  const cvMod = getClassValidatorModule();
  if (cvMod && typeof cvMod.getMetadataStorage === "function") {
    const resolved = cvMod.getMetadataStorage();
    if (
      resolved &&
      !seen.has(resolved) &&
      typeof resolved.getTargetValidationMetadatas === "function" &&
      typeof resolved.addValidationMetadata === "function"
    ) {
      seen.add(resolved);
      storages.push(resolved);
    }
  }

  return storages;
}

function getRegisteredHooks(): MappedTypeMetadataHook[] {
  const g = globalThis as Record<PropertyKey, unknown>;
  const existing = g[MAPPED_TYPE_HOOKS_KEY];
  if (Array.isArray(existing)) {
    return existing as MappedTypeMetadataHook[];
  }
  const created: MappedTypeMetadataHook[] = [];
  g[MAPPED_TYPE_HOOKS_KEY] = created;
  return created;
}

/**
 * Registers an optional metadata cloning hook invoked whenever `PartialType`,
 * `PickType`, `OmitType`, `IntersectionType`, or `CompositionType` generates a derived DTO class.
 */
export function registerMappedTypeMetadataHook(
  hook: MappedTypeMetadataHook,
): () => void {
  const hooks = getRegisteredHooks();
  hooks.push(hook);
  return () => {
    const idx = hooks.indexOf(hook);
    if (idx !== -1) {
      hooks.splice(idx, 1);
    }
  };
}

function collectSwaggerApiProperties(
  source: Function,
): Map<string, SwaggerApiPropertyLike> {
  const collected = new Map<string, SwaggerApiPropertyLike>();
  for (const ctor of MetadataRegistry.getPrototypeChain(source)) {
    const own = MetadataRegistry.getOwn<readonly SwaggerApiPropertyLike[]>(
      SWAGGER_API_PROPERTIES_KEY,
      ctor,
    );
    if (!own) continue;
    for (const entry of own) {
      if (entry && typeof entry.propertyKey === "string") {
        collected.set(entry.propertyKey, entry);
      }
    }
  }
  return collected;
}

function cloneValidationMetadata(
  meta: ClassValidatorMetadataLike,
  target: Function,
): ClassValidatorMetadataLike {
  const proto = Object.getPrototypeOf(meta) as object | null;
  const cloned = Object.assign(proto ? Object.create(proto) : {}, meta, {
    target,
    ...(Array.isArray(meta.groups) ? { groups: [...meta.groups] } : {}),
    ...(Array.isArray(meta.constraints)
      ? { constraints: [...meta.constraints] }
      : {}),
  }) as ClassValidatorMetadataLike;
  return cloned;
}

function copyReflectPropertyMetadata(
  sourceProto: object | undefined,
  targetProto: object | undefined,
  propertyKey: string,
): void {
  if (!sourceProto || !targetProto) {
    return;
  }
  const keys = MetadataRegistry.getKeys(sourceProto, propertyKey);
  for (const key of keys) {
    const val = MetadataRegistry.get(key, sourceProto, propertyKey);
    MetadataRegistry.define(key, val, targetProto, propertyKey);
  }
}

function hasMetadataInStorage(
  storage: ClassValidatorStorageLike | undefined,
  targetClass: Function,
): boolean {
  if (!storage) return false;
  try {
    return (
      storage.getTargetValidationMetadatas(targetClass, "", false, false)
        .length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Applies `@IsOptional()` (skips validation for both `null` and `undefined`) onto
 * `targetClass.prototype[propertyKey]`, targeting only storages that own metadata
 * for `targetClass` (preventing upstream DTOs from polluting native storage).
 */
export function applyIsOptionalDecorator(
  targetClass: Function,
  propertyKey: string,
): void {
  const nativeMod = getNativeValidatorEngineMod();
  const nativeStorage = (globalThis as Record<PropertyKey, unknown>)[
    NATIVE_CV_STORAGE_SYMBOL
  ] as ClassValidatorStorageLike | undefined;
  const upstreamStorages = getClassValidatorStorages().filter(
    (s) => s !== nativeStorage,
  );
  const hasNative = hasMetadataInStorage(nativeStorage, targetClass);
  const hasUpstream = upstreamStorages.some((s) =>
    hasMetadataInStorage(s, targetClass),
  );

  // Target native storage if target uses native decorators OR has no metadata in either storage yet
  if (hasNative || !hasUpstream) {
    if (nativeMod && typeof nativeMod.IsOptional === "function") {
      nativeMod.IsOptional()(targetClass.prototype, propertyKey);
    } else if (nativeStorage) {
      nativeStorage.addValidationMetadata({
        type: "conditionalValidation",
        name: "isOptional",
        target: targetClass,
        propertyName: propertyKey,
        constraints: [
          (_object: unknown, value: unknown) =>
            value !== null && value !== undefined,
        ],
        groups: [],
        each: false,
        context: undefined,
        constraintCls: undefined,
        validationTypeOptions: undefined,
      });
    }
  }

  // Target upstream storage only if target uses upstream decorators (or no native storage exists)
  if (hasUpstream || !nativeStorage) {
    const cvMod = getClassValidatorModule();
    if (cvMod && typeof cvMod.IsOptional === "function") {
      cvMod.IsOptional()(targetClass.prototype, propertyKey);
      return;
    }
    for (const cvStorage of upstreamStorages) {
      cvStorage.addValidationMetadata({
        type: "conditionalValidation",
        name: "isOptional",
        target: targetClass,
        propertyName: propertyKey,
        constraints: [
          (_object: unknown, value: unknown) =>
            value !== null && value !== undefined,
        ],
        groups: [],
        each: false,
        context: undefined,
        constraintCls: undefined,
        validationTypeOptions: undefined,
      });
    }
  }
}

/**
 * Applies `@ValidateIf((_, value) => value !== undefined)` (skips validation only
 * for `undefined`, still validating `null`) onto `targetClass.prototype[propertyKey]`.
 */
export function applyValidateIfDefinedDecorator(
  targetClass: Function,
  propertyKey: string,
): void {
  const nativeMod = getNativeValidatorEngineMod();
  const nativeStorage = (globalThis as Record<PropertyKey, unknown>)[
    NATIVE_CV_STORAGE_SYMBOL
  ] as ClassValidatorStorageLike | undefined;
  const upstreamStorages = getClassValidatorStorages().filter(
    (s) => s !== nativeStorage,
  );
  const hasNative = hasMetadataInStorage(nativeStorage, targetClass);
  const hasUpstream = upstreamStorages.some((s) =>
    hasMetadataInStorage(s, targetClass),
  );

  if (hasNative || !hasUpstream) {
    if (nativeMod && typeof nativeMod.ValidateIf === "function") {
      nativeMod.ValidateIf((_object, value) => value !== undefined)(
        targetClass.prototype,
        propertyKey,
      );
    } else if (nativeStorage) {
      nativeStorage.addValidationMetadata({
        type: "conditionalValidation",
        target: targetClass,
        propertyName: propertyKey,
        constraints: [(_object: unknown, value: unknown) => value !== undefined],
        groups: [],
        each: false,
        context: undefined,
        constraintCls: undefined,
        validationTypeOptions: undefined,
      });
    }
  }

  if (hasUpstream || !nativeStorage) {
    const cvMod = getClassValidatorModule();
    if (cvMod && typeof cvMod.ValidateIf === "function") {
      cvMod.ValidateIf((_object, value) => value !== undefined)(
        targetClass.prototype,
        propertyKey,
      );
      return;
    }
    for (const cvStorage of upstreamStorages) {
      cvStorage.addValidationMetadata({
        type: "conditionalValidation",
        target: targetClass,
        propertyName: propertyKey,
        constraints: [(_object: unknown, value: unknown) => value !== undefined],
        groups: [],
        each: false,
        context: undefined,
        constraintCls: undefined,
        validationTypeOptions: undefined,
      });
    }
  }
}

/**
 * Copies validation metadata and `design:type` reflection metadata from
 * `parentClass` to `targetClass` across both Bunest-native and upstream storages,
 * returning the list of inherited property keys.
 */
export function inheritValidationMetadata(
  parentClass: Type<any>,
  targetClass: Function,
  isPropertyInherited?: (key: string) => boolean,
): string[] | undefined {
  const storages = getClassValidatorStorages();
  if (storages.length === 0) {
    return undefined;
  }

  const filter = isPropertyInherited ?? (() => true);
  const inheritedKeys: string[] = [];

  for (const cvStorage of storages) {
    const sourceMetas = cvStorage.getTargetValidationMetadatas(
      parentClass,
      "",
      false,
      false,
    );

    for (const meta of sourceMetas) {
      if (!meta.propertyName || !filter(meta.propertyName)) {
        continue;
      }
      const originalType = MetadataRegistry.get(
        "design:type",
        parentClass.prototype,
        meta.propertyName,
      );
      if (originalType) {
        MetadataRegistry.define(
          "design:type",
          originalType,
          targetClass.prototype,
          meta.propertyName,
        );
      }
      cvStorage.addValidationMetadata(
        cloneValidationMetadata(meta, targetClass),
      );
      inheritedKeys.push(meta.propertyName);
    }
  }

  return inheritedKeys;
}

/**
 * Copies `class-transformer` metadata (`@Type`, `@Expose`, `@Exclude`, `@Transform`)
 * across the prototype chain from `parentClass` onto `targetClass`.
 */
export function inheritTransformationMetadata(
  parentClass: Type<any>,
  targetClass: Function,
  isPropertyInherited?: (key: string) => boolean,
  stackDecorators = true,
): void {
  const ctStorages = getClassTransformerStorages();
  if (ctStorages.length === 0) {
    return;
  }

  const filter = isPropertyInherited ?? (() => true);
  const chain = MetadataRegistry.getPrototypeChain(parentClass);

  for (const ctStorage of ctStorages) {
    if (
      !markClassTransformerStorageCloned(parentClass, targetClass, ctStorage)
    ) {
      continue;
    }
    if (typeof ctStorage.cloneClassMetadata === "function") {
      ctStorage.cloneClassMetadata(
        parentClass,
        targetClass,
        filter,
        stackDecorators,
      );
      continue;
    }
    for (const ctor of chain) {
      const typeMap = ctStorage._typeMetadatas?.get(ctor);
      if (typeMap) {
        for (const [propName, meta] of typeMap.entries()) {
          if (propName === undefined || !filter(propName)) continue;
          ctStorage.addTypeMetadata(cloneTransformerEntry(meta, targetClass));
        }
      }

      const exposeMap = ctStorage._exposeMetadatas?.get(ctor);
      if (exposeMap) {
        for (const [propName, meta] of exposeMap.entries()) {
          if (propName === undefined) {
            ctStorage.addExposeMetadata(
              cloneTransformerEntry(meta, targetClass),
            );
            continue;
          }
          if (!filter(propName)) continue;
          ctStorage.addExposeMetadata(cloneTransformerEntry(meta, targetClass));
        }
      }

      const excludeMap = ctStorage._excludeMetadatas?.get(ctor);
      if (excludeMap) {
        for (const [propName, meta] of excludeMap.entries()) {
          if (propName === undefined) {
            ctStorage.addExcludeMetadata(
              cloneTransformerEntry(meta, targetClass),
            );
            continue;
          }
          if (!filter(propName)) continue;
          ctStorage.addExcludeMetadata(
            cloneTransformerEntry(meta, targetClass),
          );
        }
      }

      const transformMap = ctStorage._transformMetadatas?.get(ctor);
      if (transformMap) {
        for (const [propName, metas] of transformMap.entries()) {
          if (propName === undefined || !filter(propName)) continue;
          if (!stackDecorators && ctStorage._transformMetadatas) {
            let targetMap = ctStorage._transformMetadatas.get(targetClass);
            if (!targetMap) {
              targetMap = new Map();
              ctStorage._transformMetadatas.set(targetClass, targetMap);
            }
            targetMap.set(
              propName,
              metas.map((meta) => cloneTransformerEntry(meta, targetClass)),
            );
          } else {
            for (const meta of metas) {
              ctStorage.addTransformMetadata(
                cloneTransformerEntry(meta, targetClass),
              );
            }
          }
        }
      }
    }
  }
}

/**
 * Copies default property initializers (e.g. `role = "user"`) from a temporary
 * instance of `sourceClass` onto `target` for all inherited properties not already
 * defined on `target`.
 */
export function inheritPropertyInitializers(
  target: Record<string, any>,
  sourceClass: Type<any>,
  isPropertyInherited: (key: string) => boolean = () => true,
): void {
  try {
    const tempInstance = new sourceClass() as Record<string, unknown>;
    const propertyNames = Object.getOwnPropertyNames(tempInstance);
    for (const propertyName of propertyNames) {
      if (
        typeof tempInstance[propertyName] !== "undefined" &&
        typeof target[propertyName] === "undefined" &&
        isPropertyInherited(propertyName)
      ) {
        target[propertyName] = tempInstance[propertyName];
      }
    }
  } catch {
    // Ignore classes whose constructor cannot be called with zero arguments
  }
}

export interface InheritMetadataOptions {
  readonly operation: MappedTypeOperation;
  readonly isPropertyInherited?: (propertyKey: string) => boolean;
  readonly makeOptional?: boolean;
  readonly skipNullProperties?: boolean;
  readonly explicitKeys?: readonly string[];
}

/**
 * Copies `class-validator`, `class-transformer`, Swagger `@ApiProperty`, `Reflect`
 * (`design:type` + custom property keys), and any registered pluggable hooks from
 * `source` onto `target` without mutating `source`.
 */
export function inheritDtoMetadata(
  source: Type<unknown>,
  target: Type<unknown>,
  options: InheritMetadataOptions,
): void {
  const filter = options.isPropertyInherited ?? (() => true);
  const discoveredProps = new Set<string>();

  if (options.explicitKeys) {
    for (const key of options.explicitKeys) {
      if (filter(key)) {
        discoveredProps.add(key);
      }
    }
  }

  // 1. Copy validation metadata across active Bunest-native & upstream storages
  const cvStorages = getClassValidatorStorages();
  const existingOptionalProps = new Set<string>();
  for (const cvStorage of cvStorages) {
    const sourceMetas = cvStorage.getTargetValidationMetadatas(
      source,
      "",
      false,
      false,
    );
    for (const meta of sourceMetas) {
      if (
        meta.propertyName &&
        filter(meta.propertyName) &&
        meta.type === "conditionalValidation" &&
        meta.name === "isOptional"
      ) {
        existingOptionalProps.add(meta.propertyName);
      }
    }
  }

  const inheritedValidationKeys = inheritValidationMetadata(
    source,
    target,
    filter,
  );
  if (inheritedValidationKeys) {
    for (const key of inheritedValidationKeys) {
      discoveredProps.add(key);
    }
  }

  // 1b. Copy class-transformer metadata (@Type, @Expose, @Exclude, @Transform) across prototype chain
  const ctStorages = getClassTransformerStorages();
  if (ctStorages.length > 0) {
    const chain = MetadataRegistry.getPrototypeChain(source);
    for (const ctStorage of ctStorages) {
      if (typeof ctStorage.getDecoratedPropertyNames === "function") {
        for (const propName of ctStorage.getDecoratedPropertyNames(source)) {
          if (filter(propName)) {
            discoveredProps.add(propName);
          }
        }
        continue;
      }
      for (const ctor of chain) {
        for (const map of [
          ctStorage._typeMetadatas?.get(ctor),
          ctStorage._exposeMetadatas?.get(ctor),
          ctStorage._excludeMetadatas?.get(ctor),
          ctStorage._transformMetadatas?.get(ctor),
        ]) {
          if (!map) continue;
          for (const propName of map.keys()) {
            if (propName !== undefined && filter(propName)) {
              discoveredProps.add(propName);
            }
          }
        }
      }
    }
    inheritTransformationMetadata(source, target, filter, true);
  }

  // 2. Copy Swagger @ApiProperty metadata (Symbol.for("bunest:swagger:api_properties"))
  const sourceSwagger = collectSwaggerApiProperties(source);
  const existingTargetSwagger =
    MetadataRegistry.getOwn<readonly SwaggerApiPropertyLike[]>(
      SWAGGER_API_PROPERTIES_KEY,
      target,
    ) ?? [];
  const mergedSwagger = new Map<string, SwaggerApiPropertyLike>();
  for (const entry of existingTargetSwagger) {
    mergedSwagger.set(entry.propertyKey, entry);
  }

  for (const [propKey, entry] of sourceSwagger.entries()) {
    if (!filter(propKey)) {
      continue;
    }
    discoveredProps.add(propKey);
    const clonedEntry: SwaggerApiPropertyLike = options.makeOptional
      ? { ...entry, required: false }
      : { ...entry };
    mergedSwagger.set(propKey, clonedEntry);
  }

  if (mergedSwagger.size > 0) {
    MetadataRegistry.define(
      SWAGGER_API_PROPERTIES_KEY,
      [...mergedSwagger.values()],
      target,
    );
  }

  // 3. Collect prototype getter/accessor property names (excluding constructor & methods)
  for (const ctor of MetadataRegistry.getPrototypeChain(source)) {
    const proto = ctor.prototype as object | undefined;
    if (!proto) continue;
    for (const propName of Object.getOwnPropertyNames(proto)) {
      if (propName === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(proto, propName);
      if (
        desc &&
        (typeof desc.get === "function" || typeof desc.set === "function")
      ) {
        if (filter(propName)) {
          discoveredProps.add(propName);
        }
      }
    }
  }

  // 4. Copy Reflect metadata (design:type & custom property decorators) for every inherited property
  for (const propKey of discoveredProps) {
    copyReflectPropertyMetadata(
      source.prototype as object | undefined,
      target.prototype as object | undefined,
      propKey,
    );
  }

  // 5. For PartialType: mark every inherited property optional in class-validator
  if (options.makeOptional) {
    const skipNull = options.skipNullProperties ?? true;
    for (const propKey of discoveredProps) {
      if (skipNull) {
        if (!existingOptionalProps.has(propKey)) {
          applyIsOptionalDecorator(target, propKey);
        }
      } else {
        applyValidateIfDefinedDecorator(target, propKey);
      }
    }
  }

  // 6. Invoke any custom registered metadata hooks
  for (const hook of getRegisteredHooks()) {
    hook({
      operation: options.operation,
      source,
      target,
      propertyFilter: filter,
    });
  }
}
