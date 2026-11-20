import { GraphQLError, type GraphQLErrorOptions } from "graphql";
import { ApolloServerErrorCode } from "../constants/apollo.constants";

/**
 * This error is thrown when the user input does not pass validation.
 *
 * @publicApi
 */
export class ValidationError extends GraphQLError {
  readonly coordinate?: string;

  constructor(message: string, options?: GraphQLErrorOptions) {
    super(message, {
      ...options,
      extensions: {
        code: ApolloServerErrorCode.GRAPHQL_VALIDATION_FAILED,
        ...options?.extensions,
      },
    });
  }
}
