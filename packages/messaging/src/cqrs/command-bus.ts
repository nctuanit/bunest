import {
  Inject,
  Injectable,
  MetadataRegistry,
  Optional,
  Scope,
} from "@bunest/core";
import { ModuleRef, type InstanceWrapper } from "@bunest/core";
import type { Command } from "./classes/command";
import type { RegisteredCommandResult } from "./cqrs-registry.interface";
import {
  CommandHandlerNotFoundException,
  DuplicateCommandHandlerException,
  InvalidCommandHandlerException,
} from "./exceptions";
import { DefaultCommandPubSub } from "./helpers/default-pubsubs";
import type {
  CommandMetadata,
  CommandType,
  CqrsModuleOptions,
  ICommand,
  ICommandBus,
  ICommandHandler,
  ICommandPublisher,
} from "./interfaces";
import { AsyncContext } from "./scopes/async.context";
import {
  COMMAND_HANDLER_METADATA,
  COMMAND_METADATA,
  CQRS_MODULE_OPTIONS,
} from "./tokens";
import {
  SubscribableStream,
  type StreamListener,
  type Subscribable,
  type SubscriptionHandle,
} from "./utils/subscribable-stream";

type StoredCommandHandler<CommandBase extends ICommand> =
  | {
      readonly kind: "instance";
      readonly handler: ICommandHandler<CommandBase, unknown>;
    }
  | {
      readonly kind: "wrapper";
      readonly wrapper: InstanceWrapper<ICommandHandler<CommandBase, unknown>>;
    };

function isInstanceWrapperLike(
  value: unknown,
): value is InstanceWrapper<ICommandHandler<any, any>> {
  return (
    typeof value === "object" &&
    value !== null &&
    "token" in value &&
    "moduleRef" in value
  );
}

/**
 * Dispatches commands to their single registered `@CommandHandler()`.
 * Supports strongly-typed `Command<TResult>`, `AsyncContext` request-scoped handlers,
 * pluggable `ICommandPublisher`, and zero-RxJS subscribable `subject$`.
 */
@Injectable()
export class CommandBus<CommandBase extends ICommand = ICommand>
  implements ICommandBus<CommandBase>, Subscribable<CommandBase>
{
  readonly subject$ = new SubscribableStream<CommandBase>();

  private readonly handlers = new Map<
    Function,
    StoredCommandHandler<CommandBase>
  >();
  private readonly handlersById = new Map<
    string,
    StoredCommandHandler<CommandBase>
  >();
  private _publisher!: ICommandPublisher<CommandBase>;

  constructor(
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional()
    @Inject(CQRS_MODULE_OPTIONS)
    private readonly options?: CqrsModuleOptions,
  ) {
    if (this.options?.commandPublisher) {
      this._publisher = this.options
        .commandPublisher as ICommandPublisher<CommandBase>;
    } else {
      this.useDefaultPublisher();
    }
  }

  get publisher(): ICommandPublisher<CommandBase> {
    return this._publisher;
  }

  set publisher(publisher: ICommandPublisher<CommandBase>) {
    this._publisher = publisher;
  }

  subscribe(
    listenerOrObserver: StreamListener<CommandBase>,
  ): SubscriptionHandle {
    return this.subject$.subscribe(listenerOrObserver);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<CommandBase> {
    return this.subject$[Symbol.asyncIterator]();
  }

  bind<T extends CommandBase>(
    handler: InstanceWrapper<ICommandHandler<T, any>> | ICommandHandler<T, any>,
    id: string,
  ): void {
    const entry: StoredCommandHandler<CommandBase> = isInstanceWrapperLike(
      handler,
    )
      ? {
          kind: "wrapper",
          wrapper: handler as InstanceWrapper<
            ICommandHandler<CommandBase, unknown>
          >,
        }
      : {
          kind: "instance",
          handler: handler as ICommandHandler<CommandBase, unknown>,
        };
    this.handlersById.set(id, entry);
  }

  register<TCommand extends CommandBase, TResult = unknown>(
    commandType: CommandType<TCommand>,
    handler: ICommandHandler<TCommand, TResult>,
  ): void;
  register(
    handlers?: InstanceWrapper<ICommandHandler<CommandBase, any>>[],
  ): void;
  register(
    commandTypeOrHandlers?:
      CommandType<any> | InstanceWrapper<ICommandHandler<CommandBase, any>>[],
    maybeHandler?: ICommandHandler<any, any>,
  ): void {
    if (Array.isArray(commandTypeOrHandlers)) {
      for (const wrapper of commandTypeOrHandlers) {
        this.registerHandler(wrapper);
      }
      return;
    }

    if (!commandTypeOrHandlers) {
      return;
    }

    if (typeof commandTypeOrHandlers !== "function" || !maybeHandler) {
      throw new InvalidCommandHandlerException();
    }

    if (typeof maybeHandler.execute !== "function") {
      throw new InvalidCommandHandlerException();
    }

    if (this.handlers.has(commandTypeOrHandlers)) {
      throw new DuplicateCommandHandlerException(
        commandTypeOrHandlers.name || "<anonymous>",
      );
    }

    const entry: StoredCommandHandler<CommandBase> = {
      kind: "instance",
      handler: maybeHandler as ICommandHandler<CommandBase, unknown>,
    };
    this.handlers.set(commandTypeOrHandlers, entry);

    const meta = MetadataRegistry.get<CommandMetadata>(
      COMMAND_METADATA,
      commandTypeOrHandlers,
    );
    if (meta?.id) {
      this.handlersById.set(meta.id, entry);
    }
  }

  protected registerHandler(
    wrapper: InstanceWrapper<ICommandHandler<CommandBase, any>>,
  ): void {
    const metatype =
      wrapper.metatype ??
      (wrapper.instance && typeof wrapper.instance === "object"
        ? wrapper.instance.constructor
        : undefined);
    if (typeof metatype !== "function") {
      throw new InvalidCommandHandlerException();
    }

    const commandType = MetadataRegistry.get<CommandType>(
      COMMAND_HANDLER_METADATA,
      metatype,
    );
    if (!commandType || typeof commandType !== "function") {
      throw new InvalidCommandHandlerException();
    }

    const proto = metatype.prototype as Record<string, unknown> | undefined;
    const hasExecute =
      typeof (wrapper.instance as Record<string, unknown> | undefined)
        ?.execute === "function" || typeof proto?.execute === "function";
    if (!hasExecute) {
      throw new InvalidCommandHandlerException();
    }

    if (this.handlers.has(commandType)) {
      throw new DuplicateCommandHandlerException(
        commandType.name || "<anonymous>",
      );
    }

    const entry: StoredCommandHandler<CommandBase> =
      wrapper.isDependencyTreeStatic &&
      wrapper.scope === Scope.SINGLETON &&
      wrapper.instance
        ? {
            kind: "instance",
            handler: wrapper.instance as ICommandHandler<CommandBase, unknown>,
          }
        : {
            kind: "wrapper",
            wrapper: wrapper as InstanceWrapper<
              ICommandHandler<CommandBase, unknown>
            >,
          };

    this.handlers.set(commandType, entry);

    const cmdMeta = MetadataRegistry.get<CommandMetadata>(
      COMMAND_METADATA,
      commandType,
    );
    if (cmdMeta?.id) {
      this.handlersById.set(cmdMeta.id, entry);
    }
  }

  unregister(commandType: CommandType): void {
    this.handlers.delete(commandType);
    const meta = MetadataRegistry.get<CommandMetadata>(
      COMMAND_METADATA,
      commandType,
    );
    if (meta?.id) {
      this.handlersById.delete(meta.id);
    }
  }

  hasHandler(commandType: CommandType): boolean {
    if (this.handlers.has(commandType)) {
      return true;
    }
    const meta = MetadataRegistry.get<CommandMetadata>(
      COMMAND_METADATA,
      commandType,
    );
    return meta?.id ? this.handlersById.has(meta.id) : false;
  }

  execute<R = void>(command: Command<R>): Promise<R>;
  execute<R = void>(command: Command<R>, context?: AsyncContext): Promise<R>;
  execute<TCommand extends CommandBase>(
    command: [RegisteredCommandResult<TCommand>] extends [never]
      ? never
      : TCommand,
    context?: AsyncContext,
  ): Promise<RegisteredCommandResult<TCommand>>;
  execute<TResult = any, TCommand extends CommandBase = CommandBase>(
    command: TCommand,
    context?: AsyncContext,
  ): Promise<TResult>;
  execute<TCommand extends CommandBase, TResult = any>(
    command: TCommand,
    context?: AsyncContext,
  ): Promise<TResult>;
  async execute(
    command: CommandBase | Command<unknown>,
    context?: AsyncContext,
  ): Promise<unknown> {
    if (!command || typeof command !== "object") {
      throw new CommandHandlerNotFoundException(String(command));
    }

    const ctor = command.constructor;
    let stored = this.handlers.get(ctor);
    if (!stored) {
      const meta = MetadataRegistry.get<CommandMetadata>(
        COMMAND_METADATA,
        ctor,
      );
      if (meta?.id) {
        stored = this.handlersById.get(meta.id);
      }
    }

    if (!stored) {
      throw new CommandHandlerNotFoundException(ctor?.name || "<anonymous>");
    }

    const asyncContext = context ?? AsyncContext.of(command);
    if (asyncContext) {
      asyncContext.attachTo(command);
    }

    let handler: { execute(command: ICommand): Promise<unknown> | unknown };
    if (stored.kind === "instance") {
      handler = stored.handler as {
        execute(command: ICommand): Promise<unknown> | unknown;
      };
    } else {
      const ctx = asyncContext ?? new AsyncContext();
      ctx.attachTo(command);
      const ref = stored.wrapper.moduleRef ?? this.moduleRef;
      if (!ref) {
        throw new InvalidCommandHandlerException();
      }
      handler = (await ref.resolve(stored.wrapper.token, ctx.id, {
        strict: false,
      })) as { execute(command: ICommand): Promise<unknown> | unknown };
    }

    this._publisher.publish(command as CommandBase);
    return await handler.execute(command);
  }

  clear(): void {
    this.handlers.clear();
    this.handlersById.clear();
    this.subject$.clear();
  }

  private useDefaultPublisher(): void {
    this._publisher = new DefaultCommandPubSub<CommandBase>(this.subject$);
  }
}
