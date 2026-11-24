import {
  createParamDecorator,
  type ExecutionContext,
  type PipeLike,
} from "@bunest/core";
import type { AuthenticatedUser } from "../interfaces/authentication-result.interface";
import { resultOf } from "../utils/auth-state.util";

/**
 * The authenticated user, or `null` on `@Public()` and anonymous optional
 * calls. `@CurrentUser('email')` picks one property; the key is checked
 * against the `AuthenticationTypes` augmentation.
 */
export const CurrentUser: (
  data?: keyof AuthenticatedUser | PipeLike,
  ...pipes: PipeLike[]
) => ParameterDecorator = createParamDecorator<
  keyof AuthenticatedUser | undefined,
  ExecutionContext
>((key, context) => {
  const user = (resultOf(context)?.user ?? null) as Record<
    PropertyKey,
    unknown
  > | null;
  return key && user ? user[key] : user;
});
