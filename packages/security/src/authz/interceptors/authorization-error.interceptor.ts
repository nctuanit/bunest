import {
  Injectable,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/core";
import { AuthorizationError } from "../errors/authorization.error";
import { toTransportError } from "../utils/transport-error.util";

/**
 * Turns an `AuthorizationError` that leaves a handler (thrown by
 * `authorize()` in a service it called) into the transport's error, the same
 * one `@Can()` throws. Registered globally; other errors pass untouched.
 */
@Injectable()
export class AuthorizationErrorInterceptor implements BunestInterceptor {
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    try {
      return await next.handle();
    } catch (error) {
      if (error instanceof AuthorizationError) {
        throw await toTransportError(context, error);
      }
      throw error;
    }
  }
}
