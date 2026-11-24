import {
  METADATA_KEYS,
  MetadataRegistry,
  SetMetadata,
  createMethodAspectDecorator,
  type MethodAspectMetadata,
} from "@bunest/core";
import type { EntrypointDecorator } from "../interfaces/entrypoint-options.interface";
import { RESILIENCE_METHOD_ASPECT } from "../resilience.constants";

export interface ResilienceAspectSlotOptions {
  readonly slotId: symbol;
}

/**
 * Composes standard resilience `SetMetadata` (read by `ResilienceInterceptor` and
 * `EntrypointPlanner`) with a deduplicated Core Method Aspect registration so
 * resilience decorators ALSO execute seamlessly on `@Injectable()` service methods.
 */
export function withResilienceAspect(
  metadataKey: string,
  metadataValue: unknown,
): EntrypointDecorator {
  const metaDecorator = SetMetadata(metadataKey, metadataValue);

  return ((
    target: object,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): any => {
    const result = (
      metaDecorator as (
        t: object,
        k?: string | symbol,
        d?: PropertyDescriptor,
      ) => unknown
    )(target, propertyKey, descriptor);

    // Class-level decoration
    if (propertyKey === undefined && descriptor === undefined) {
      const existingClassAspects =
        MetadataRegistry.getOwn<readonly MethodAspectMetadata[]>(
          METADATA_KEYS.CLASS_METHOD_ASPECTS,
          target,
        ) ?? [];
      const alreadyBound = existingClassAspects.some(
        (entry) => entry.token === RESILIENCE_METHOD_ASPECT,
      );
      if (!alreadyBound) {
        const aspectDecorator =
          createMethodAspectDecorator<ResilienceAspectSlotOptions>(
            RESILIENCE_METHOD_ASPECT,
            { slotId: Symbol("resilience:class-slot") },
          );
        (aspectDecorator as ClassDecorator)(target as Function);
      }
      return result;
    }

    // Method-level decoration
    const ctor =
      typeof target === "function"
        ? target
        : (target as { constructor?: Function }).constructor;
    if (ctor && propertyKey !== undefined) {
      const existingMethodAspects =
        MetadataRegistry.getOwn<readonly MethodAspectMetadata[]>(
          METADATA_KEYS.METHOD_ASPECTS,
          ctor,
        ) ?? [];
      const alreadyBound = existingMethodAspects.some(
        (entry) =>
          entry.token === RESILIENCE_METHOD_ASPECT &&
          entry.methodName === propertyKey,
      );
      if (!alreadyBound) {
        const aspectDecorator =
          createMethodAspectDecorator<ResilienceAspectSlotOptions>(
            RESILIENCE_METHOD_ASPECT,
            { slotId: Symbol("resilience:method-slot") },
          );
        (aspectDecorator as MethodDecorator)(
          target,
          propertyKey,
          descriptor as PropertyDescriptor,
        );
      }
    }

    return result;
  }) as EntrypointDecorator;
}
