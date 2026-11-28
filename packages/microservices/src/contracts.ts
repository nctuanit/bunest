import type { PatternInput } from "./interfaces";

export const MESSAGE_CONTRACT_SYMBOL = Symbol.for(
  "bunest:microservices:message-contract",
);
export const EVENT_CONTRACT_SYMBOL = Symbol.for(
  "bunest:microservices:event-contract",
);

/**
 * Strongly-typed RPC request/response contract shared between
 * `@MessagePattern(contract)` handlers and `client.sendContract(contract, req)`.
 */
export interface MessageContract<
  TPattern extends PatternInput = PatternInput,
  TReq = unknown,
  TRes = unknown,
> {
  readonly [MESSAGE_CONTRACT_SYMBOL]: true;
  readonly pattern: TPattern;
  /** Phantom type carrier for request payload inference. */
  readonly __request?: TReq;
  /** Phantom type carrier for response payload inference. */
  readonly __response?: TRes;
}

/**
 * Strongly-typed fire-and-forget event contract shared between
 * `@EventPattern(contract)` handlers and `client.emitContract(contract, payload)`.
 */
export interface EventContract<
  TPattern extends PatternInput = PatternInput,
  TPayload = unknown,
> {
  readonly [EVENT_CONTRACT_SYMBOL]: true;
  readonly pattern: TPattern;
  /** Phantom type carrier for event payload inference. */
  readonly __payload?: TPayload;
}

/** Extracts the request type `TReq` from a `MessageContract`. */
export type ContractRequest<TContract> =
  TContract extends MessageContract<PatternInput, infer TReq, any>
    ? TReq
    : never;

/** Extracts the response type `TRes` from a `MessageContract`. */
export type ContractResponse<TContract> =
  TContract extends MessageContract<PatternInput, any, infer TRes>
    ? TRes
    : never;

/** Extracts the payload type `TPayload` from an `EventContract`. */
export type ContractPayload<TContract> =
  TContract extends EventContract<PatternInput, infer TPayload>
    ? TPayload
    : never;

function isValidPatternInput(pattern: unknown): pattern is PatternInput {
  if (typeof pattern === "string") {
    return pattern.trim().length > 0;
  }
  if (typeof pattern === "number") {
    return Number.isFinite(pattern);
  }
  if (pattern instanceof RegExp) {
    return true;
  }
  return typeof pattern === "object" && pattern !== null && !Array.isArray(pattern);
}

function freezePattern<TPattern extends PatternInput>(
  pattern: TPattern,
): TPattern {
  if (
    typeof pattern === "object" &&
    pattern !== null &&
    !(pattern instanceof RegExp)
  ) {
    return Object.freeze({ ...pattern }) as TPattern;
  }
  return pattern;
}

export function isMessageContract(
  value: unknown,
): value is MessageContract<PatternInput, unknown, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[MESSAGE_CONTRACT_SYMBOL] === true &&
    isValidPatternInput((value as { pattern?: unknown }).pattern)
  );
}

export function isEventContract(
  value: unknown,
): value is EventContract<PatternInput, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[EVENT_CONTRACT_SYMBOL] === true &&
    isValidPatternInput((value as { pattern?: unknown }).pattern)
  );
}

/**
 * Defines a type-safe RPC message contract usable in both
 * `@MessagePattern(contract)` and `client.sendContract(contract, data)`.
 */
export function defineMessageContract<
  TReq = unknown,
  TRes = unknown,
  TPattern extends PatternInput = PatternInput,
>(pattern: TPattern): MessageContract<TPattern, TReq, TRes> {
  if (!isValidPatternInput(pattern)) {
    throw new Error(
      "defineMessageContract() requires a non-empty string, finite number, RegExp, or object pattern.",
    );
  }
  return Object.freeze({
    [MESSAGE_CONTRACT_SYMBOL]: true as const,
    pattern: freezePattern(pattern),
  });
}

/**
 * Defines a type-safe event contract usable in both
 * `@EventPattern(contract)` and `client.emitContract(contract, payload)`.
 */
export function defineEventContract<
  TPayload = unknown,
  TPattern extends PatternInput = PatternInput,
>(pattern: TPattern): EventContract<TPattern, TPayload> {
  if (!isValidPatternInput(pattern)) {
    throw new Error(
      "defineEventContract() requires a non-empty string, finite number, RegExp, or object pattern.",
    );
  }
  return Object.freeze({
    [EVENT_CONTRACT_SYMBOL]: true as const,
    pattern: freezePattern(pattern),
  });
}
