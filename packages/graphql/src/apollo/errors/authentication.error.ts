import { GraphQLError, type GraphQLErrorOptions } from "../../engine";

/**
 * This error is thrown when the user is not authenticated.
 *
 * @publicApi
 */
export class AuthenticationError extends GraphQLError {
  readonly coordinate?: string;

  constructor(message: string, options?: GraphQLErrorOptions) {
    super(message, {
      ...options,
      extensions: {
        code: "UNAUTHENTICATED",
        ...options?.extensions,
      },
    });
  }
}
