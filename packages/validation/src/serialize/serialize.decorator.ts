import {
  Injectable,
  UseInterceptors,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/core/common";
import { getPropDocMetadata } from "../prop/prop-metadata";
import {
  defaultMetadataStorage as defaultTransformStorage,
  instanceToPlain,
  plainToInstance,
  type ClassConstructor,
} from "../transformer/index";
import { getMetadataStorage as getValidatorStorage } from "../validator/storage/metadata-storage";

export interface SerializeOptionsConfig {
  /**
   * When `true` (default), strips any property not declared on `dto` via
   * `@Expose()`, `@Prop()`, or `@bunest/validation` decorators — preventing
   * accidental leaks of sensitive fields (e.g. `passwordHash`).
   * @default true
   */
  readonly excludeExtraneousValues?: boolean;
  /**
   * Optional wrapper property key when returning an envelope such as
   * `{ data: users, meta: { total, page } }` (`wrapperKey: "data"`).
   */
  readonly wrapperKey?: string;
  /** Optional serialization groups passed to `plainToInstance` / `instanceToPlain`. */
  readonly groups?: string[];
  /** Enable circular reference tracking during serialization. */
  readonly enableCircularCheck?: boolean;
}

function isPassThroughValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") return true;
  if (value instanceof Response) return true;
  if (value instanceof ReadableStream) return true;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (value instanceof Date || value instanceof RegExp) return true;
  return false;
}

function collectAllowedOutputKeys(
  dto: ClassConstructor<unknown>,
): {
  readonly allowedKeys: Set<string> | undefined;
  readonly renamedProps: Map<string, string>;
} {
  const allowed = new Set<string>();
  const renamed = new Map<string, string>();
  const excluded = new Set<string>();

  // Walk prototype chain from base -> derived
  const chain: Function[] = [];
  let cur: Function | null = dto;
  while (
    cur &&
    cur !== Object &&
    cur !== Function.prototype &&
    typeof cur === "function"
  ) {
    chain.push(cur);
    const proto = Object.getPrototypeOf(cur);
    if (!proto || proto === cur || typeof proto !== "function") break;
    cur = proto;
  }

  for (let i = chain.length - 1; i >= 0; i--) {
    const ctor = chain[i]!;
    const exposeMap = defaultTransformStorage.getOwnExposeMap(ctor);
    if (exposeMap) {
      for (const [prop, meta] of exposeMap.entries()) {
        if (typeof prop === "string") {
          excluded.delete(prop);
          const outName = meta.options?.name ?? prop;
          renamed.set(prop, outName);
          allowed.add(outName);
        }
      }
    }
    const excludeMap = defaultTransformStorage.getOwnExcludeMap(ctor);
    if (excludeMap) {
      for (const [prop, meta] of excludeMap.entries()) {
        if (typeof prop === "string" && meta.options?.toClassOnly !== true) {
          excluded.add(prop);
        }
      }
    }
  }

  // Properties decorated with @bunest/validation decorators or @Prop()
  const valMetas = getValidatorStorage().getTargetValidationMetadatas(
    dto,
    "",
    false,
    false,
  );
  for (let i = 0; i < valMetas.length; i++) {
    const prop = valMetas[i]!.propertyName;
    if (prop && !excluded.has(prop)) {
      allowed.add(renamed.get(prop) ?? prop);
    }
  }

  const propDocs = getPropDocMetadata(dto);
  for (const prop of propDocs.keys()) {
    if (!excluded.has(prop)) {
      allowed.add(renamed.get(prop) ?? prop);
    }
  }

  for (const prop of excluded) {
    allowed.delete(prop);
    const r = renamed.get(prop);
    if (r) allowed.delete(r);
  }

  return {
    allowedKeys: allowed.size > 0 ? allowed : undefined,
    renamedProps: renamed,
  };
}

function projectItem(
  dto: ClassConstructor<unknown>,
  item: unknown,
  options: SerializeOptionsConfig,
  allowedKeys: Set<string> | undefined,
  renamedProps: Map<string, string>,
): unknown {
  if (isPassThroughValue(item)) {
    return item;
  }

  const transformOpts = {
    ...(options.groups ? { groups: options.groups } : {}),
    ...(options.enableCircularCheck !== undefined
      ? { enableCircularCheck: options.enableCircularCheck }
      : {}),
  };

  const itemRecord = item as Record<string, unknown>;
  const instance = plainToInstance(dto, itemRecord, {
    ...transformOpts,
    excludeExtraneousValues: false,
  }) as Record<string, unknown>;

  // When projecting domain/ORM objects whose keys match JS property names
  // (e.g. `displayName`) onto a DTO using `@Expose({ name: "display_name" })`,
  // `plainToInstance` looks for the wire alias; preserve the JS property value
  // so `instanceToPlain` emits it under the exposed wire alias.
  for (const [prop, outName] of renamedProps.entries()) {
    if (
      instance[prop] === undefined &&
      outName !== prop &&
      Object.prototype.hasOwnProperty.call(itemRecord, prop)
    ) {
      instance[prop] = itemRecord[prop];
    }
  }

  const plain = instanceToPlain(instance, transformOpts);

  if (options.excludeExtraneousValues === false || !allowedKeys) {
    return plain;
  }

  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(plain)) {
    if (allowedKeys.has(key)) {
      filtered[key] = plain[key];
    }
  }
  return filtered;
}

function projectValue(
  dto: ClassConstructor<unknown>,
  value: unknown,
  options: SerializeOptionsConfig,
  allowedKeys: Set<string> | undefined,
  renamedProps: Map<string, string>,
): unknown {
  if (isPassThroughValue(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      projectItem(dto, item, options, allowedKeys, renamedProps),
    );
  }

  if (
    options.wrapperKey &&
    typeof value === "object" &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, options.wrapperKey)
  ) {
    const record = value as Record<string, unknown>;
    const inner = record[options.wrapperKey];
    return {
      ...record,
      [options.wrapperKey]: Array.isArray(inner)
        ? inner.map((item) =>
            projectItem(dto, item, options, allowedKeys, renamedProps),
          )
        : projectItem(dto, inner, options, allowedKeys, renamedProps),
    };
  }

  return projectItem(dto, value, options, allowedKeys, renamedProps);
}

/**
 * One-line safe response projection decorator.
 *
 * Projects plain objects, ORM entities, arrays, or paginated envelopes
 * (`wrapperKey: "data"`) through `dto`, stripping any undeclared/sensitive
 * fields by default (`excludeExtraneousValues: true`).
 */
export function Serialize(
  dto: ClassConstructor<unknown>,
  options: SerializeOptionsConfig = {},
): ClassDecorator & MethodDecorator {
  let cachedAllowedKeys: Set<string> | undefined;
  let cachedRenamedProps = new Map<string, string>();
  let keysResolved = false;

  @Injectable()
  class MixinSerializeInterceptor implements BunestInterceptor {
    async intercept(
      _context: ExecutionContext,
      next: CallHandler,
    ): Promise<unknown> {
      const result = await next.handle();
      if (!keysResolved) {
        const meta = collectAllowedOutputKeys(dto);
        cachedAllowedKeys = meta.allowedKeys;
        cachedRenamedProps = meta.renamedProps;
        keysResolved = true;
      }
      return projectValue(
        dto,
        result,
        options,
        cachedAllowedKeys,
        cachedRenamedProps,
      );
    }
  }

  return UseInterceptors(MixinSerializeInterceptor);
}
