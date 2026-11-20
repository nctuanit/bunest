export const POLICY_METADATA = "authorization:policy";
export const CAN_METADATA = "authorization:can";
/** Written by `@Can.Anyone()`, on the class or the method. */
export const CAN_ANYONE_METADATA = "authorization:can-anyone";
/** Injection token of the runtime options (`forRoot()` values, or the `forRootAsync()` factory result). */
export const AUTHORIZATION_MODULE_OPTIONS = "AUTHORIZATION_MODULE_OPTIONS";
/**
 * The static brand on `AuthorizationGuard`, which subclasses inherit. A
 * registry symbol, like `@bunest/authentication`'s, so every copy of the
 * package (and any other package) recognizes the guard without importing it.
 */
export const AUTHORIZATION_GUARD: unique symbol = Symbol.for(
  "@nestjs/authorization:guard",
) as any;
/**
 * The static brand `@bunest/authentication` puts on `AuthenticationGuard`,
 * which its subclasses inherit. A registry symbol, so it is recognized
 * without depending on that package.
 */
export const AUTHENTICATION_GUARD: unique symbol = Symbol.for(
  "@nestjs/authentication:guard",
) as any;
/**
 * Where `@bunest/authentication` records whether a route is public: `true`
 * from `@Public()`, `false` from `@Authenticate()`, on the class or the
 * method, the method's value winning. A public route needs no
 * `@Can.Anyone()`. A registry symbol too, so it is found without depending
 * on that package.
 */
export const AUTHENTICATION_PUBLIC: unique symbol = Symbol.for(
  "@nestjs/authentication:public",
) as any;
/**
 * Where `@bunest/authentication` leaves, on a ws client and on GraphQL's
 * `context.req`, the function that answers with the user of one message or
 * operation: `carrier[AUTHENTICATION_USER_OF](context)`.
 */
export const AUTHENTICATION_USER_OF: unique symbol = Symbol.for(
  "nestjs.authentication.userOf",
) as any;
