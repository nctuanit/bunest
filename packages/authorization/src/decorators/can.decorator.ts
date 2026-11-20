import type { Type } from "@bunest/common";
import { CAN_ANYONE_METADATA, CAN_METADATA } from "../authorization.constants";
import type { CanAbility, CanArgs } from "../interfaces/ability.interface";
import type { CanRequirement } from "../interfaces/can-requirement.interface";

/**
 * Requires `policy[ability](user, ...args)` to return `true` before the
 * handler runs. Stackable; class-level and method-level requirements all
 * apply (AND), except that a method's `@Can.Anyone()` or `@Public()` lifts
 * the class's.
 */
export function Can<P, const A extends string>(
  policy: Type<P>,
  ability: A extends CanAbility<P> ? A : CanAbility<P>,
  ...resolver: CanArgs<P, A>
): ClassDecorator & MethodDecorator {
  const [args] = resolver;
  const requirement: CanRequirement = {
    policy,
    ability,
    ...(args ? { args } : {}),
  };

  return (
    target: object | Function,
    _key?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    const host = descriptor ? (descriptor.value as object) : target;
    const existing =
      (Reflect.getMetadata(CAN_METADATA, host) as CanRequirement[] | undefined) ??
      [];
    // Decorators apply bottom-up; prepend so metadata reads top-down.
    Reflect.defineMetadata(CAN_METADATA, [requirement, ...existing], host);
  };
}

export namespace Can {
  /**
   * Lets anyone the handler admits call it, or every handler of the class.
   * On a method, it lifts the class's `@Can()`; a `@Can()` on the method
   * itself still applies.
   */
  export const Anyone = (): ClassDecorator & MethodDecorator => {
    return (
      target: object | Function,
      _key?: string | symbol,
      descriptor?: PropertyDescriptor,
    ) => {
      Reflect.defineMetadata(
        CAN_ANYONE_METADATA,
        true,
        descriptor ? (descriptor.value as object) : target,
      );
    };
  };
}
