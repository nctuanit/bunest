import type { ExecutionContext } from "@bunest/core";

/**
 * @internal The context object of a GraphQL operation, read from the resolver
 * args positionally so this package needs no `@bunest/graphql` dependency.
 */
export function graphqlContextOf(
  context: ExecutionContext,
): Record<PropertyKey, any> | undefined {
  const operation = context.getArgByIndex(
    context.getArgs().length === 3 ? 1 : 2,
  );
  return typeof operation === "object" && operation !== null
    ? (operation as Record<PropertyKey, any>)
    : undefined;
}
