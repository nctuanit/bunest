import { GraphQLError, type GraphQLErrorOptions } from "../../engine";

/**
 * General Apollo-compatible GraphQL error supporting an explicit error code and extensions.
 */
export class ApolloError extends GraphQLError {
  constructor(
    message: string,
    code?: string,
    extensions?: Record<string, unknown>,
    options?: GraphQLErrorOptions,
  ) {
    super(message, {
      ...options,
      extensions: {
        ...(code ? { code } : {}),
        ...extensions,
        ...options?.extensions,
      },
    });
    if (!this.name || this.name === "GraphQLError") {
      Object.defineProperty(this, "name", { value: "ApolloError" });
    }
  }
}
