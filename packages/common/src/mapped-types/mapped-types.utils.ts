import { createRequire } from "node:module";
import { join } from "node:path";
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
}

interface ClassValidatorModuleLike {
  IsOptional?: () => PropertyDecorator;
  ValidateIf?: (
    condition: (object: any, value: any) => boolean,
  ) => PropertyDecorator;
  getMetadataStorage?: () => ClassValidatorStorageLike;
}

let cachedTransformerStorages: ClassTransformerStorageLike[] | undefined;
let cachedClassValidatorModule: ClassValidatorModuleLike | null | undefined;

function tryRequire(specifier: string): unknown {
  try {
    return createRequire(import.meta.url)(specifier);
  } catch {
    try {
      return createRequire(join(process.cwd(), "package.json"))(specifier);
    } catch {
      return undefined;
    }
  }
}

function getClassValidatorModule(): ClassValidatorModuleLike | undefined {
  if (cachedClassValidatorModule !== undefined) {
    return cachedClassValidatorModule ?? undefined;
  }
  const mod = tryRequire(["class", "validator"].join("-")) as
    | ClassValidatorModuleLike
    | undefined;
  cachedClassValidatorModule = mod ?? null;
  return mod;
}

function getClassTransformerStorages(): readonly ClassTransformerStorageLike[] {
  if (cachedTransformerStorages !== undefined) {
    return cachedTransformerStorages;
  }
  const storages: ClassTransformerStorageLike[] = [];
  const seen = new Set<unknown>();
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
      storages.push(storage as ClassTransformerStorageLike);
    }
  }
  cachedTransformerStorages = storages;
  return storages;
}

function markClassTransformerStorageCloned(
  source: Function,
  target: Function,
  storage: object,
): boolean {
  const g = globalThis as Record<PropertyKey, unknown>;
  let byTarget = g[CT_CLONED_REGISTRY_KEY] as
    | WeakMap<Function, WeakMap<Function, WeakSet<object>>>
    | undefined;
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
  | "partial"
  | "pick"
  | "omit"
  | "intersection"
  | "composition";

export type MappedTypeMetadataHook = (context: {
  readonly operation: MappedTypeOperation;
  readonly source: Type<unknown>;
  readonly target: Type<unknown>;
  readonly propertyFilter?: (propertyKey: string) => boolean;
}) => void;

function getClassValidatorStorage(): ClassValidatorStorageLike | undefined {
  const storage = (
    globalThis as Record<PropertyKey, unknown>
  ).classValidatorMetadataStorage as Partial<ClassValidatorStorageLike> | undefined;
  if (
    storage &&
    typeof storage.getTargetValidationMetadatas === "function" &&
    typeof storage.addValidationMetadata === "function"
  ) {
    return storage as ClassValidatorStorageLike;
  }
  const cvMod = getClassValidatorModule();
  if (cvMod && typeof cvMod.getMetadataStorage === "function") {
    const resolved = cvMod.getMetadataStorage();
    if (
      resolved &&
      typeof resolved.getTargetValidationMetadatas === "function" &&
      typeof resolved.addValidationMetadata === "function"
    ) {
      return resolved;
    }
  }
  return undefined;
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
  const cloned = Object.assign(
    proto ? Object.create(proto) : {},
    meta,
    {
      target,
      ...(Array.isArray(meta.groups) ? { groups: [...meta.groups] } : {}),
      ...(Array.isArray(meta.constraints)
        ? { constraints: [...meta.constraints] }
        : {}),
    },
  ) as ClassValidatorMetadataLike;
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
  const keys = Reflect.getMetadataKeys(sourceProto, propertyKey);
  for (const key of keys) {
    const val = Reflect.getMetadata(key, sourceProto, propertyKey);
    Reflect.defineMetadata(key, val, targetProto, propertyKey);
  }
}

/**
 * Applies `class-validator`'s `@IsOptional()` decorator (skips validation for both
 * `null` and `undefined`) onto `targetClass.prototype[propertyKey]`.
 */
export function applyIsOptionalDecorator(
  targetClass: Function,
  propertyKey: string,
): void {
  const cvMod = getClassValidatorModule();
  if (cvMod && typeof cvMod.IsOptional === "function") {
    const decorator = cvMod.IsOptional();
    decorator(targetClass.prototype, propertyKey);
    return;
  }
  const cvStorage = getClassValidatorStorage();
  if (!cvStorage) {
    return;
  }
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

/**
 * Applies `class-validator`'s `@ValidateIf((_, value) => value !== undefined)`
 * decorator (skips validation only for `undefined`, still validating `null`!)
 * onto `targetClass.prototype[propertyKey]`.
 */
export function applyValidateIfDefinedDecorator(
  targetClass: Function,
  propertyKey: string,
): void {
  const cvMod = getClassValidatorModule();
  if (cvMod && typeof cvMod.ValidateIf === "function") {
    const decorator = cvMod.ValidateIf((_object, value) => value !== undefined);
    decorator(targetClass.prototype, propertyKey);
    return;
  }
  const cvStorage = getClassValidatorStorage();
  if (!cvStorage) {
    return;
  }
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

/**
 * Copies `class-validator` metadata and `design:type` reflection metadata from
 * `parentClass` to `targetClass`, returning the list of inherited property keys
 * (or `undefined` when `class-validator` is not installed).
 */
export function inheritValidationMetadata(
  parentClass: Type<any>,
  targetClass: Function,
  isPropertyInherited?: (key: string) => boolean,
): string[] | undefined {
  const cvStorage = getClassValidatorStorage();
  if (!cvStorage) {
    return undefined;
  }

  const filter = isPropertyInherited ?? (() => true);
  const sourceMetas = cvStorage.getTargetValidationMetadatas(
    parentClass,
    "",
    false,
    false,
  );

  const inheritedKeys: string[] = [];
  for (const meta of sourceMetas) {
    if (!meta.propertyName || !filter(meta.propertyName)) {
      continue;
    }
    const originalType = Reflect.getMetadata(
      "design:type",
      parentClass.prototype,
      meta.propertyName,
    );
    if (originalType) {
      Reflect.defineMetadata(
        "design:type",
        originalType,
        targetClass.prototype,
        meta.propertyName,
      );
    }
    cvStorage.addValidationMetadata(cloneValidationMetadata(meta, targetClass));
    inheritedKeys.push(meta.propertyName);
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
    if (!markClassTransformerStorageCloned(parentClass, targetClass, ctStorage)) {
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

  // 1. Copy class-validator metadata (when class-validator is loaded in the app)
  const cvStorage = getClassValidatorStorage();
  const existingOptionalProps = new Set<string>();
  if (cvStorage) {
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
