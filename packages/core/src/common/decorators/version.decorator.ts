import { METADATA_KEYS } from "../constants/metadata-keys";
import type { VersionValue } from "../interfaces/versioning.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";

/**
 * Declares one or more API versions (or `VERSION_NEUTRAL`) on a controller class
 * or individual route handler method. Copy-on-write and inheritance-safe.
 */
export function Version(
  version: VersionValue,
): ClassDecorator & MethodDecorator {
  const normalized: VersionValue = Array.isArray(version)
    ? [...version]
    : version;

  const decorator = (
    target: object,
    _propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    if (descriptor && descriptor.value !== undefined) {
      MetadataRegistry.define<VersionValue>(
        METADATA_KEYS.VERSION,
        Array.isArray(normalized) ? [...normalized] : normalized,
        descriptor.value,
      );
      return descriptor;
    }
    MetadataRegistry.define<VersionValue>(
      METADATA_KEYS.VERSION,
      Array.isArray(normalized) ? [...normalized] : normalized,
      target,
    );
    return target;
  };

  return decorator as ClassDecorator & MethodDecorator;
}
