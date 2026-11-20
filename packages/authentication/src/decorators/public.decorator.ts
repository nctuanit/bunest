import { route } from "./authenticate.decorator";

/**
 * Skips authentication: no provider runs, and `@CurrentUser()` is `null`.
 * For health checks, the public catalog, and the routes that sign users in.
 * To `@bunest/authorization` it means `@Can.Anyone()`.
 */
export const Public = (): ClassDecorator & MethodDecorator =>
  route({ public: true });
