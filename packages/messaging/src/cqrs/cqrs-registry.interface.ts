/**
 * cqrs-registry.interface.ts
 *
 * Module Augmentation targets for `@bunest/messaging/cqrs`.
 * Automatically populated by `bunest dev` / `bunest typegen` from `@CommandHandler(...)`
 * and `@QueryHandler(...)` classes, enabling automatic return-type inference even for
 * plain `ICommand` / `IQuery` classes that do not extend `Command<T>` / `Query<T>`.
 */

/**
 * Maps command class names / constructors to `{ command, result }` pairs.
 * Populated automatically in `.bunest/types/bunest.d.ts`.
 */
export interface BunestCommandRegistry {}

/**
 * Maps query class names / constructors to `{ query, result }` pairs.
 * Populated automatically in `.bunest/types/bunest.d.ts`.
 */
export interface BunestQueryRegistry {}

type ExactMatchResult<Actual, Expected, Result> = Actual extends Expected
  ? Expected extends Actual
    ? Result
    : never
  : never;

type CommandEntryResult<Entry, TCommand> = Entry extends {
  command: infer C;
  result: infer R;
}
  ? ExactMatchResult<TCommand, C, R>
  : never;

type QueryEntryResult<Entry, TQuery> = Entry extends {
  query: infer Q;
  result: infer R;
}
  ? ExactMatchResult<TQuery, Q, R>
  : never;

/** Resolves the registered result type for a command instance `TCommand`, or `never` if unregistered. */
export type RegisteredCommandResult<TCommand> = [
  keyof BunestCommandRegistry,
] extends [never]
  ? never
  : {
      [K in keyof BunestCommandRegistry]: CommandEntryResult<
        BunestCommandRegistry[K],
        TCommand
      >;
    }[keyof BunestCommandRegistry];

/** Resolves the registered result type for a query instance `TQuery`, or `never` if unregistered. */
export type RegisteredQueryResult<TQuery> = [
  keyof BunestQueryRegistry,
] extends [never]
  ? never
  : {
      [K in keyof BunestQueryRegistry]: QueryEntryResult<
        BunestQueryRegistry[K],
        TQuery
      >;
    }[keyof BunestQueryRegistry];
