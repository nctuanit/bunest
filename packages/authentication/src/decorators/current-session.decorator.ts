import { createParamDecorator, type ExecutionContext } from "@bunest/common";
import { resultOf } from "../utils/auth-state.util";

/** The provider's session object (a `SessionRecord`, JWT claims, an `ApiKeySession`), or `null`. */
export const CurrentSession = createParamDecorator<unknown, ExecutionContext>(
  (_, context) => {
    return resultOf(context)?.session ?? null;
  },
);
