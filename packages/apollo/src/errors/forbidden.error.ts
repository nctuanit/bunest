import { GraphQLError, type GraphQLErrorOptions } from "graphql";

/**
 * This error is thrown when the user is not authorized to access a resource.
 *
 * @publicApi
 */
export class ForbiddenError extends GraphQLError {
  readonly coordinate?: string;

  constructor(message: string, options?: GraphQLErrorOptions) {
    super(message, {
      ...options,
      extensions: {
        code: "FORBIDDEN",
        ...options?.extensions,
      },
    });
  }
}
