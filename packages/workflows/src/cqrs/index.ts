// The `@bunest/workflows/cqrs` entry: the only files that import `@bunest/messaging/cqrs`.
// Module: wraps the EventBus publisher, so mapped events start and signal workflows
export { WorkflowsCqrsModule } from "./workflows-cqrs.module";
// Mapping events to workflows, and the dispatcher context that carries your transaction
export { SignalOn, StartOn } from "./decorators/index";
export type {
  SignalOnOptions,
  StartOnOptions,
  WorkflowDispatcherContext,
} from "./interfaces/index";
