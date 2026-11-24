// Module
export { AuthorizationModule } from "./authorization.module";
export type { AuthorizationModuleAsyncOptions } from "./authorization.module-definition";
export { AUTHORIZATION_MODULE_OPTIONS } from "./authorization.constants";
export type {
  AuthorizationModuleOptions,
  AuthorizationOptionsFactory,
} from "./interfaces/authorization-module-options.interface";

// Policies
export { Can } from "./decorators/can.decorator";
export { Policy } from "./decorators/policy.decorator";
export type { Ability } from "./interfaces/ability.interface";
export type { PolicyBefore } from "./interfaces/policy-before.interface";

// Checks: in services, on routes, and the user the route checks see
export { AuthorizationService } from "./authorization.service";
export { AuthorizationGuard } from "./guards/authorization.guard";
export { defaultGetUser } from "./utils/get-user.util";

// Denials: the error `authorize()` throws, and the events operators audit
export { AuthorizationError } from "./errors/authorization.error";
export { AuthorizationEvents } from "./events/authorization-events.service";
export type {
  AuthorizationDeniedEvent,
  AuthorizationEvent,
} from "./events/authorization-events.interface";
