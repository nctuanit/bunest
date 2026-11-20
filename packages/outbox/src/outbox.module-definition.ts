import {
  type ConfigurableModuleAsyncOptions,
  ConfigurableModuleBuilder,
  type ModuleMetadata,
  type Provider,
  type Type,
} from "@bunest/common";
import type { OutboxModuleOptions } from "./interfaces/outbox-module-options.interface";
import { LOCAL_TRANSPORT } from "./outbox.constants";
import type { OutboxTransport } from "./transports/outbox.transport";
import { isName } from "./utils/name.util";

/**
 * The top level of both `forRoot()` and `forRootAsync()`.
 */
export interface OutboxModuleStructure {
  /**
   * Named transports, each an `OutboxTransport` class or instance. `local` (the
   * `@OnOutboxMessage()` handlers) is built in.
   */
  transports?: Record<string, Type<OutboxTransport> | OutboxTransport>;
  /** Modules whose exports the transport classes inject (`forRootAsync()` has its own `imports`). */
  imports?: ModuleMetadata["imports"];
  /** Default `true`. */
  isGlobal?: boolean;
}

/** `forRoot()`'s options: everything at the top level, where `transports` may be classes. */
export type OutboxModuleRootOptions = Omit<
  OutboxModuleOptions,
  "transports"
> &
  OutboxModuleStructure;

/** What a class passed to `forRootAsync({ useClass })` implements. */
export interface OutboxOptionsFactory {
  createOutboxOptions(): OutboxModuleOptions | Promise<OutboxModuleOptions>;
}

/**
 * What `forRootAsync()` takes: `transports` classes (or instances), `imports` and
 * `isGlobal` at the top level, and one of `useFactory`, `useClass` or `useExisting` for the
 * rest of the options.
 */
export type OutboxModuleAsyncOptions = ConfigurableModuleAsyncOptions<
  OutboxModuleOptions,
  "createOutboxOptions"
> &
  OutboxModuleStructure;

/** The configured transports by name, instantiated (internal). */
export const OUTBOX_TRANSPORTS: unique symbol = Symbol("OUTBOX_TRANSPORTS");

const built = new ConfigurableModuleBuilder<OutboxModuleOptions>({
  moduleName: "Outbox",
})
  .setClassMethodName("forRoot")
  .setFactoryMethodName("createOutboxOptions")
  .setExtras<OutboxModuleStructure>(
    { isGlobal: true, transports: undefined, imports: undefined },
    (definition, { isGlobal, transports, imports }) => ({
      ...definition,
      global: isGlobal,
      imports: [...(definition.imports ?? []), ...(imports ?? [])],
      providers: [
        ...(definition.providers ?? []),
        ...transportProviders(transports),
      ],
    }),
  )
  .build();

export const ConfigurableModuleClass = built.ConfigurableModuleClass;
export const OUTBOX_MODULE_OPTIONS: string | symbol =
  built.MODULE_OPTIONS_TOKEN as string | symbol;
export const OPTIONS_TYPE = built.OPTIONS_TYPE;

function transportProviders(
  transports: Record<string, Type<OutboxTransport> | OutboxTransport> = {},
): Provider[] {
  for (const [name, transport] of Object.entries(transports)) {
    assertTransportName(name);
    if (!isClass(transport) && typeof transport?.publish !== "function") {
      throw new TypeError(
        `OutboxModule: transports.${name} must be an OutboxTransport class or an object with publish()`,
      );
    }
  }
  const topLevel = Object.keys(transports);
  const classes = [...new Set(Object.values(transports).filter(isClass))];
  return [
    ...classes,
    {
      provide: OUTBOX_TRANSPORTS,
      inject: [OUTBOX_MODULE_OPTIONS, ...classes],
      useFactory: (
        options: OutboxModuleOptions | undefined,
        ...instances: OutboxTransport[]
      ): Record<string, OutboxTransport> => ({
        ...Object.fromEntries(
          Object.entries(transports).map(([name, transport]) => [
            name,
            isClass(transport)
              ? instances[classes.indexOf(transport)]!
              : transport,
          ]),
        ),
        ...fromFactory(options, topLevel),
      }),
    },
  ];
}

function fromFactory(
  options: OutboxModuleOptions | undefined,
  topLevel: readonly string[],
): Record<string, OutboxTransport> {
  if (options && "store" in options) {
    throw storeOptionError();
  }
  const { transports = {} } = options ?? {};
  for (const [name, transport] of Object.entries(transports)) {
    assertTransportName(name);
    assertInstance(
      `transports.${name}`,
      transport,
      (value) => typeof (value as OutboxTransport).publish === "function",
      "an OutboxTransport instance or an object with publish()",
    );
    if (topLevel.includes(name)) {
      throw setTwiceError(`transports.${name}`);
    }
  }
  return transports;
}

/** The store is registered, not configured: a leftover `store` option fails instead of being ignored. */
export function storeOptionError(): Error {
  return new Error(
    "OutboxModule: `store` is not an option. Implement OutboxStore and OutboxInboxStore in a provider " +
      "that injects OutboxStorage and calls `storage.registerSource({ messages: this, inbox: this })` in " +
      "its constructor.",
  );
}

function assertInstance(
  option: string,
  value: unknown,
  valid: (value: object) => boolean,
  expected: string,
): void {
  if (isClass(value)) {
    throw new Error(
      `OutboxModule: the forRootAsync() factory returned a class as \`${option}\` (${value.name}). ` +
        "Classes go at the top level of forRootAsync(), next to useFactory or useClass, where Nest " +
        "instantiates them; the factory returns instances.",
    );
  }
  if (!value || typeof value !== "object" || !valid(value)) {
    throw new TypeError(
      `OutboxModule: \`${option}\` returned by the forRootAsync() factory must be ${expected}`,
    );
  }
}

function assertTransportName(name: string): void {
  if (!isName(name)) {
    throw new Error(
      "OutboxModule: transport name cannot be empty. Give the transport in `transports` a name.",
    );
  }
  if (name === LOCAL_TRANSPORT) {
    throw new Error(
      `OutboxModule: "${LOCAL_TRANSPORT}" is the built-in in-process transport; ` +
        "give the transport in `transports` another name.",
    );
  }
}

function setTwiceError(option: string): Error {
  return new Error(
    `OutboxModule: \`${option}\` is set both at the top level of forRootAsync() and in the ` +
      "options its factory returns. Set it in one place.",
  );
}

function isClass(value: unknown): value is Type<OutboxTransport> {
  return typeof value === "function";
}
