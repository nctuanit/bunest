import { MetadataRegistry } from "@bunest/core";
import {
  AUTHENTICATION_METADATA,
  AUTHENTICATION_PUBLIC,
} from "../authentication.constants";
import type {
  AuthenticateOptions,
  RouteAuthentication,
} from "../interfaces/authenticate-options.interface";

/** Merges into the metadata already on the class or method, so decorators can be stacked. */
export function route(
  value: RouteAuthentication,
): ClassDecorator & MethodDecorator {
  const defined = Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  );
  const decorator = (
    target: object,
    _key?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    const holder = descriptor ? (descriptor.value as object) : target;
    const existing = MetadataRegistry.get<RouteAuthentication>(
      AUTHENTICATION_METADATA,
      holder,
    );
    MetadataRegistry.define(
      AUTHENTICATION_METADATA,
      { ...existing, ...defined },
      holder,
    );
    if (value.public !== undefined) {
      MetadataRegistry.define(AUTHENTICATION_PUBLIC, value.public, holder);
    }
  };
  return decorator as ClassDecorator & MethodDecorator;
}

/**
 * Configures authentication for a controller or a handler. Every route
 * already requires a signed-in user; use this to relax that (`optional`),
 * tighten it (`mfa`, `verifiedEmail`, `providers`), or require it again under a `@Public()`
 * class. Method options merge over class options, field by field.
 */
export const Authenticate = (
  options: AuthenticateOptions = {},
): ClassDecorator & MethodDecorator => route({ ...options, public: false });
