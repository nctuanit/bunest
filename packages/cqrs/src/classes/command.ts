import { RESULT_TYPE_SYMBOL, type ICommand } from "./base-types";

/**
 * Utility type to extract the result type `R` of a typed `Command<R>`.
 */
export type CommandResult<C extends Command<unknown>> =
  C extends Command<infer R> ? R : never;

/**
 * Base class for strongly-typed CQRS commands carrying a phantom result type `T`.
 * Enables automatic return-type inference on `commandBus.execute(new MyCommand())`
 * and `implements ICommandHandler<MyCommand>`.
 */
export class Command<T> implements ICommand {
  declare readonly [RESULT_TYPE_SYMBOL]: T;
}
