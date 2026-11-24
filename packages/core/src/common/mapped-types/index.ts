import type { Type } from "../interfaces/type.interface";
import {
  applyIsOptionalDecorator,
  applyValidateIfDefinedDecorator,
  inheritDtoMetadata,
  inheritPropertyInitializers,
  inheritTransformationMetadata,
  inheritValidationMetadata,
  registerMappedTypeMetadataHook,
  type MappedTypeMetadataHook,
  type MappedTypeOperation,
} from "./mapped-types.utils";

export {
  applyIsOptionalDecorator,
  applyValidateIfDefinedDecorator,
  inheritPropertyInitializers,
  inheritTransformationMetadata,
  inheritValidationMetadata,
  registerMappedTypeMetadataHook,
  type MappedTypeMetadataHook,
  type MappedTypeOperation,
};

/**
 * Constructible mapped DTO class type matching `@nestjs/mapped-types` `MappedType<T>`.
 */
export interface MappedType<T> extends Type<T> {
  new (): T;
}

type KeysWithType<T, V> = {
  [K in keyof T]: T[K] extends V ? K : never;
}[keyof T];

/**
 * Strips properties matching `V` (e.g. `Function` methods) from mapped DTO types.
 */
export type RemoveFieldsWithType<T, V> = Omit<T, KeysWithType<T, V>>;

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

type ClassRefsToConstructors<T extends readonly Type[]> = {
  [U in keyof T]: T[U] extends Type<infer V> ? V : never;
};

type Intersection<T extends readonly Type[]> = MappedType<
  RemoveFieldsWithType<
    UnionToIntersection<ClassRefsToConstructors<T>[number]>,
    Function
  >
>;

/**
 * Creates a derived DTO class with all properties of `classRef` marked optional,
 * cloning `class-validator`, `class-transformer`, Swagger `@ApiProperty`,
 * `Reflect` property metadata, and default class field initializers.
 */
export function PartialType<T>(
  classRef: Type<T>,
  options?: {
    /**
     * If `true` (default), skips validation for both `null` and `undefined` (`@IsOptional()`).
     * If `false`, skips validation only for `undefined` (`@ValidateIf((_, v) => v !== undefined)`),
     * still validating `null` values.
     * @default true
     */
    skipNullProperties?: boolean;
  },
): MappedType<RemoveFieldsWithType<Partial<T>, Function>> {
  abstract class PartialClassType {
    constructor() {
      inheritPropertyInitializers(this, classRef);
    }
  }
  Object.defineProperty(PartialClassType, "name", {
    value: `Partial${classRef.name || "Dto"}`,
  });

  inheritDtoMetadata(classRef, PartialClassType as unknown as Type<unknown>, {
    operation: "partial",
    makeOptional: true,
    skipNullProperties: options?.skipNullProperties ?? true,
  });

  return PartialClassType as unknown as MappedType<
    RemoveFieldsWithType<Partial<T>, Function>
  >;
}

/**
 * Creates a derived DTO class containing ONLY the specified `keys` of `classRef`,
 * cloning `class-validator`, `class-transformer`, Swagger `@ApiProperty`,
 * `Reflect` property metadata, and matching property initializers exclusively for those keys.
 */
export function PickType<T, K extends keyof T>(
  classRef: Type<T>,
  keys: readonly K[],
): MappedType<RemoveFieldsWithType<Pick<T, (typeof keys)[number]>, Function>> {
  const keySet = new Set<string>(keys.map((k) => String(k)));
  const isInherited = (prop: string) => keySet.has(prop);

  abstract class PickClassType {
    constructor() {
      inheritPropertyInitializers(this, classRef, isInherited);
    }
  }
  Object.defineProperty(PickClassType, "name", {
    value: `Pick${classRef.name || "Dto"}`,
  });

  inheritDtoMetadata(classRef, PickClassType as unknown as Type<unknown>, {
    operation: "pick",
    isPropertyInherited: isInherited,
    explicitKeys: [...keySet],
  });

  return PickClassType as unknown as MappedType<
    RemoveFieldsWithType<Pick<T, (typeof keys)[number]>, Function>
  >;
}

/**
 * Creates a derived DTO class containing all properties of `classRef` EXCEPT `keys`,
 * cloning `class-validator`, `class-transformer`, Swagger `@ApiProperty`,
 * `Reflect` property metadata, and non-omitted property initializers.
 */
export function OmitType<T, K extends keyof T>(
  classRef: Type<T>,
  keys: readonly K[],
): MappedType<RemoveFieldsWithType<Omit<T, (typeof keys)[number]>, Function>> {
  const omitSet = new Set<string>(keys.map((k) => String(k)));
  const isInherited = (prop: string) => !omitSet.has(prop);

  abstract class OmitClassType {
    constructor() {
      inheritPropertyInitializers(this, classRef, isInherited);
    }
  }
  Object.defineProperty(OmitClassType, "name", {
    value: `Omit${classRef.name || "Dto"}`,
  });

  inheritDtoMetadata(classRef, OmitClassType as unknown as Type<unknown>, {
    operation: "omit",
    isPropertyInherited: isInherited,
  });

  return OmitClassType as unknown as MappedType<
    RemoveFieldsWithType<Omit<T, (typeof keys)[number]>, Function>
  >;
}

/**
 * Creates a derived DTO class combining all fields, property initializers, and metadata
 * (`class-validator`, `class-transformer`, Swagger `@ApiProperty`, and `Reflect`)
 * from 2 or more source DTO classes (variadic NestJS v12 parity).
 */
export function IntersectionType<T extends Type[]>(
  ...classRefs: T
): Intersection<T> {
  abstract class IntersectionClassType {
    constructor() {
      for (const classRef of classRefs) {
        inheritPropertyInitializers(this, classRef);
      }
    }
  }
  const suffix = classRefs.map((c) => c.name || "Dto").join("");
  Object.defineProperty(IntersectionClassType, "name", {
    value: `Intersection${suffix || "Dto"}`,
  });

  for (const classRef of classRefs) {
    inheritDtoMetadata(
      classRef,
      IntersectionClassType as unknown as Type<unknown>,
      {
        operation: "intersection",
      },
    );
  }

  return IntersectionClassType as unknown as Intersection<T>;
}

/**
 * Composes 2 or more DTO classes into a single combined DTO class, cloning
 * `class-validator`, `class-transformer`, Swagger `@ApiProperty`,
 * `Reflect` property metadata, and property initializers from every source class left-to-right.
 */
export function CompositionType<T extends readonly Type<any>[]>(
  ...classRefs: T
): Intersection<T> {
  abstract class ComposedClassType {
    constructor() {
      for (const classRef of classRefs) {
        inheritPropertyInitializers(this, classRef);
      }
    }
  }
  const suffix = classRefs.map((c) => c.name || "Dto").join("");
  Object.defineProperty(ComposedClassType, "name", {
    value: `Composed${suffix || "Dto"}`,
  });

  for (const classRef of classRefs) {
    inheritDtoMetadata(
      classRef,
      ComposedClassType as unknown as Type<unknown>,
      {
        operation: "composition",
      },
    );
  }

  return ComposedClassType as unknown as Intersection<T>;
}
