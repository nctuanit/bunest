/**
 * Canonical DI injection tokens shared across Bunest packages
 * (ADR-008 DI-aware global enhancers & ADR-012 request-scoped context).
 */
export const APP_GUARD = Symbol.for("bunest:token:app_guard");
export const APP_PIPE = Symbol.for("bunest:token:app_pipe");
export const APP_INTERCEPTOR = Symbol.for("bunest:token:app_interceptor");
export const APP_FILTER = Symbol.for("bunest:token:app_filter");

export const REQUEST = Symbol.for("bunest:token:request");
export const REQUEST_CONTEXT = Symbol.for("bunest:token:request_context");

/**
 * Injection token providing the parent class constructor (or token) that injected
 * a `Scope.TRANSIENT` (or `Scope.REQUEST`) provider (NestJS `INQUIRER` parity).
 */
export const INQUIRER = Symbol.for("bunest:token:inquirer");

/**
 * Injection/request token for the `AbortController` controlling an active `@Sse()`
 * stream (NestJS v12.2 `SSE_ABORT_CONTROLLER` parity).
 */
export const SSE_ABORT_CONTROLLER = Symbol.for(
  "bunest:token:sse_abort_controller",
);

/**
 * Symbol attached by `@bunest/http` onto already prototype-pollution-sanitized
 * parsed JSON bodies so downstream pipes (e.g. `@bunest/validation`) can skip
 * redundant second-pass deep key scanning.
 */
export const BODY_SANITIZED_SYMBOL = Symbol.for("bunest:http:body_sanitized");
