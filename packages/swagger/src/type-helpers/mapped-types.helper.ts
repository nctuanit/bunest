import {
  IntersectionType as CoreIntersectionType,
  OmitType as CoreOmitType,
  PartialType as CorePartialType,
  PickType as CorePickType,
  MetadataRegistry,
  type Type,
} from "@bunest/core";
import { SWAGGER_METADATA_KEYS } from "../constants";
import type { ApiPropertyMetadata } from "../interfaces/openapi.interface";
import { getPluginModelMetadata } from "../plugin-metadata-store";

export const SWAGGER_MAPPED_TYPE_META = Symbol.for(
  "bunest:swagger:mapped_type_meta",
);

export interface SwaggerMappedTypeMeta {
  readonly kind: "partial" | "deepPartial" | "pick" | "omit" | "intersection";
  readonly sources: readonly Function[];
  readonly keys?: readonly string[];
  readonly wrapNestedDto?: (ctor: Type<unknown>) => Type<unknown>;
}

function attachMappedTypeMeta(
  target: Function,
  meta: SwaggerMappedTypeMeta,
): void {
  Object.defineProperty(target, SWAGGER_MAPPED_TYPE_META, {
    value: meta,
    enumerable: false,
    configurable: true,
  });
}

function collectVisibleDocumentedKeys(classRef: Function): Set<string> {
  const documented = new Set<string>();
  const hidden = new Set<string>();

  const walk = (cls: Function): void => {
    for (const ctor of MetadataRegistry.getPrototypeChain(cls)) {
      const ownMeta = Object.prototype.hasOwnProperty.call(
        ctor,
        SWAGGER_MAPPED_TYPE_META,
      )
        ? (ctor as unknown as Record<symbol, SwaggerMappedTypeMeta>)[
            SWAGGER_MAPPED_TYPE_META
          ]
        : undefined;
      if (ownMeta) {
        const sub = new Set<string>();
        for (const src of ownMeta.sources) {
          for (const k of collectVisibleDocumentedKeys(src)) {
            sub.add(k);
          }
        }
        if (ownMeta.kind === "pick" && ownMeta.keys) {
          const allowed = new Set(ownMeta.keys);
          for (const k of sub) {
            if (allowed.has(k)) documented.add(k);
          }
        } else if (ownMeta.kind === "omit" && ownMeta.keys) {
          const omitted = new Set(ownMeta.keys);
          for (const k of sub) {
            if (!omitted.has(k)) documented.add(k);
          }
        } else {
          for (const k of sub) documented.add(k);
        }
        continue;
      }

      const pluginProps = getPluginModelMetadata(ctor);
      if (pluginProps) {
        for (const p of pluginProps) documented.add(p.propertyKey);
      }
      if (
        Object.prototype.hasOwnProperty.call(
          ctor,
          "_OPENAPI_METADATA_FACTORY",
        ) &&
        typeof (ctor as { _OPENAPI_METADATA_FACTORY?: unknown })
          ._OPENAPI_METADATA_FACTORY === "function"
      ) {
        const factoryResult = (
          ctor as unknown as {
            _OPENAPI_METADATA_FACTORY: () => Record<string, unknown>;
          }
        )._OPENAPI_METADATA_FACTORY();
        if (factoryResult && typeof factoryResult === "object") {
          for (const k of Object.keys(factoryResult)) documented.add(k);
        }
      }
      const ownProps = MetadataRegistry.getOwn<readonly ApiPropertyMetadata[]>(
        SWAGGER_METADATA_KEYS.API_PROPERTIES,
        ctor,
      );
      if (ownProps) {
        for (const p of ownProps) documented.add(p.propertyKey);
      }
      const ownHidden = MetadataRegistry.getOwn<readonly string[]>(
        SWAGGER_METADATA_KEYS.API_HIDDEN_PROPERTIES,
        ctor,
      );
      if (ownHidden) {
        for (const k of ownHidden) hidden.add(k);
      }
    }
  };

  walk(classRef);
  for (const h of hidden) {
    documented.delete(h);
  }
  return documented;
}

function buildKeySuffixedName(
  prefix: "Pick" | "Omit",
  classRef: Function,
  keys: readonly PropertyKey[],
): string {
  const baseName = classRef.name || "Type";
  const visible = collectVisibleDocumentedKeys(classRef);
  const keySuffix = keys
    .map((k) => String(k))
    .filter((k) => visible.has(k))
    .map((k) => (k.length > 0 ? k[0]!.toUpperCase() + k.slice(1) : ""))
    .join("");
  return `${prefix}${baseName}${keySuffix}`;
}

export function PartialType<T>(
  classRef: Type<T>,
  options?: { skipNullProperties?: boolean },
): ReturnType<typeof CorePartialType<T>> {
  const Mapped = CorePartialType(classRef, options);
  attachMappedTypeMeta(Mapped, {
    kind: "partial",
    sources: [classRef],
  });
  return Mapped;
}

export function PickType<T, K extends keyof T>(
  classRef: Type<T>,
  keys: readonly K[],
): ReturnType<typeof CorePickType<T, K>> {
  const Mapped = CorePickType(classRef, keys);
  const derivedName = buildKeySuffixedName("Pick", classRef, keys);
  Object.defineProperty(Mapped, "name", {
    value: derivedName,
    configurable: true,
  });
  attachMappedTypeMeta(Mapped, {
    kind: "pick",
    sources: [classRef],
    keys: keys.map(String),
  });
  return Mapped;
}

export function OmitType<T, K extends keyof T>(
  classRef: Type<T>,
  keys: readonly K[],
): ReturnType<typeof CoreOmitType<T, K>> {
  const Mapped = CoreOmitType(classRef, keys);
  const derivedName = buildKeySuffixedName("Omit", classRef, keys);
  Object.defineProperty(Mapped, "name", {
    value: derivedName,
    configurable: true,
  });
  attachMappedTypeMeta(Mapped, {
    kind: "omit",
    sources: [classRef],
    keys: keys.map(String),
  });
  return Mapped;
}

export function IntersectionType<T extends Type<any>[]>(
  ...classRefs: T
): ReturnType<typeof CoreIntersectionType<T>> {
  const Mapped = CoreIntersectionType(...classRefs);
  attachMappedTypeMeta(Mapped, {
    kind: "intersection",
    sources: [...classRefs],
  });
  return Mapped;
}
