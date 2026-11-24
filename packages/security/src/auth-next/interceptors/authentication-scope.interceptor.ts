import {
  Injectable,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/core";
import { HttpAdapterHost } from "@bunest/core";
import {
  AuthenticationScope,
  runCall,
} from "../context/authentication-scope.service";
import { AuthenticationError } from "../errors/authentication.error";
import { getAuthState } from "../utils/auth-state.util";
import { refusal, refusalOf } from "../utils/transport-errors.util";

/**
 * @internal Opens the authentication scope with what the guard recorded around
 * `next.handle()`, and translates any escaping `AuthenticationError` into the
 * active transport's exception.
 */
@Injectable()
export class AuthenticationScopeInterceptor implements BunestInterceptor {
  constructor(
    private readonly scope: AuthenticationScope,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const scope = { result: getAuthState(context) ?? null, context };
    try {
      return await this.scope.run(scope, () =>
        runCall(scope, () => next.handle()),
      );
    } catch (error) {
      if (!(error instanceof AuthenticationError)) {
        throw error;
      }
      throw await refusal(context, refusalOf(error), {
        challenge: error.challenge,
        adapterHost: this.adapterHost,
      });
    }
  }
}
