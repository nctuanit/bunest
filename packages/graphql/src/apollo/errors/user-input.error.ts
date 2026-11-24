import { GraphQLError, type GraphQLErrorOptions } from "../../engine";
import { ApolloServerErrorCode } from "../constants/apollo.constants";

/**
 * This error is thrown when the user input is invalid.
 *
 * @publicApi
 */
export class UserInputError extends GraphQLError {
  readonly coordinate?: string;

  constructor(message: string, options?: GraphQLErrorOptions) {
    super(message, {
      ...options,
      extensions: {
        code: ApolloServerErrorCode.BAD_USER_INPUT,
        ...options?.extensions,
      },
    });
  }
}
