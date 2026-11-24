import { Inject, Injectable, Logger, type OnModuleInit } from "@bunest/core";
import {
  DiscoveryService,
  ExternalContextCreator,
  MetadataRegistry,
  MetadataScanner,
} from "@bunest/core";
import type { AgentFunctionContext } from "../interfaces/agent-function.interface";
import type { AiModuleOptions } from "../interfaces/ai-module-options.interface";
import type {
  AiCaller,
  AiToolSelection,
} from "../interfaces/ai-tool.interface";
import type { ModelMessage } from "../interfaces/ai-types.interface";
import {
  AGENT_FUNCTION_METADATA,
  AI_CONTEXT_TYPE,
  AI_MODULE_OPTIONS,
  AI_PARAMS_METADATA,
} from "../ai.constants";
import { AiParamsFactory, recordHandlerParams } from "../context/ai-params";
import { AiConfigurationError, AiToolError } from "../errors/ai.errors";
import { toToolError } from "../utils/errors.util";
import { assertProviderToolName } from "../utils/names.util";
import {
  EMPTY_OBJECT_SCHEMA,
  toModelSchema,
  type ModelSchema,
} from "../utils/schema.util";
import { toToolOutput } from "./tool-output.util";

const NEVER_ABORTED = new AbortController().signal;

/** A method behind Bunest's enhancers. */
export type AiToolHandler = (
  input: unknown,
  context: AgentFunctionContext,
) => Promise<unknown>;

/** An agent function of the application. */
export interface AiToolEntry {
  name: string;
  description?: string;
  scopes?: string[];
  /** The schema of its arguments. */
  inputSchema: ModelSchema<any>;
  handler: AiToolHandler;
  /** The provider class it is a method of. */
  host: Function;
  /** `Class.method`, for messages. */
  where: string;
}

/** An agent function's progress. */
export interface AiToolProgress {
  toolCallId: string;
  toolName: string;
  progress: number;
  total?: number;
  message?: string;
}

/**
 * The application's agent functions: the `@AgentFunction()` methods of its providers
 * (or of the `include` modules), found once at startup, each wrapped by Bunest's enhancers
 * with the context type `'ai'`, and called with an `AgentFunctionContext`.
 */
@Injectable()
export class AiTools implements OnModuleInit {
  private readonly logger = new Logger("AiModule");
  private readonly entries = new Map<string, AiToolEntry>();
  private readonly paramsFactory = new AiParamsFactory();
  private scanned = false;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly externalContextCreator: ExternalContextCreator,
    @Inject(AI_MODULE_OPTIONS) private readonly options: AiModuleOptions,
  ) {}

  onModuleInit(): void {
    this.scan();
  }

  /** Every agent function, by name. */
  get tools(): ReadonlyMap<string, AiToolEntry> {
    this.scan();
    return this.entries;
  }

  /**
   * Tools for `selection` (agent function names, or provider classes for all their agent functions),
   * whose calls run as `caller`.
   */
  select(
    selection: AiToolSelection,
    {
      caller = {},
      onExecute,
      onProgress,
      execute = true,
    }: {
      caller?: AiCaller;
      /** @internal */
      onExecute?: () => void;
      /** @internal */
      onProgress?: (progress: AiToolProgress) => void;
      /** @internal `false`: the tools are offered to the model, and their calls returned, not run. */
      execute?: boolean;
    } = {},
  ): Record<string, any> {
    this.scan();
    const tools: Record<string, any> = {};
    for (const entry of this.resolve(selection)) {
      tools[entry.name] = {
        ...(entry.description !== undefined && {
          description: entry.description,
        }),
        inputSchema: entry.inputSchema,
        parameters: entry.inputSchema.jsonSchema,
        ...(execute && {
          execute: (
            input: unknown,
            options?: {
              toolCallId?: string;
              messages?: ModelMessage[];
              abortSignal?: AbortSignal;
            },
          ) => {
            onExecute?.();
            return this.call(entry, input, caller, {
              ...options,
              ...(onProgress && { onProgress }),
            });
          },
        }),
      };
    }
    return tools;
  }

  /**
   * Runs the agent function `name` with `input` (validated by its schema) as `caller`,
   * through its enhancers, as an agent's call does.
   */
  async call(
    entryOrName: AiToolEntry | string,
    input: unknown,
    caller: AiCaller = {},
    options: {
      toolCallId?: string;
      messages?: unknown[];
      abortSignal?: AbortSignal;
      idempotencyKey?: string;
      onProgress?: (progress: AiToolProgress) => void;
    } = {},
  ): Promise<unknown> {
    const entry =
      typeof entryOrName === "string"
        ? this.resolve([entryOrName])[0]!
        : entryOrName;

    if (entry.inputSchema.validate) {
      const validated = await entry.inputSchema.validate(input);
      if (!validated.success) {
        throw new AiToolError(
          `Invalid input: ${validated.error.message}`,
          entry.name,
        );
      }
      input = validated.value;
    }

    if (entry.scopes?.length) {
      const held = new Set(caller.scopes ?? []);
      const missing = entry.scopes.filter((scope) => !held.has(scope));
      if (missing.length > 0) {
        throw new AiToolError(
          `Forbidden: this tool needs the scope(s) ${missing.join(", ")}`,
          entry.name,
        );
      }
    }

    const toolCallId = options.toolCallId ?? "";
    const context: AgentFunctionContext = {
      name: entry.name,
      ...(caller.request !== undefined && { request: caller.request }),
      ...(caller.user !== undefined && { user: caller.user }),
      ...(caller.scopes !== undefined && { scopes: caller.scopes }),
      signal: options.abortSignal ?? NEVER_ABORTED,
      reportProgress: async (progress, total, message) => {
        options.onProgress?.({
          toolCallId,
          toolName: entry.name,
          progress,
          ...(total !== undefined && { total }),
          ...(message !== undefined && { message }),
        });
      },
      toolCallId,
      ...(options.idempotencyKey !== undefined && {
        idempotencyKey: options.idempotencyKey,
      }),
      messages: (options.messages ?? []) as ModelMessage[],
    };

    let value: unknown;
    try {
      value = await entry.handler(input ?? {}, context);
    } catch (error) {
      throw toToolError(error, entry.name);
    }

    try {
      return toToolOutput(value, entry.name, entry.where);
    } catch (error) {
      if (!(error instanceof AiToolError)) {
        this.logger.error(
          `${entry.where} returned a value that is not JSON`,
          error instanceof Error ? error.stack : undefined,
        );
      }
      throw toToolError(error, entry.name);
    }
  }

  /** The agent functions a selection names, each once, in order. Unknown names throw. */
  resolve(selection: AiToolSelection): AiToolEntry[] {
    this.scan();
    if (!Array.isArray(selection)) {
      throw new AiConfigurationError(
        "`tools` lists agent function names and provider classes, e.g. ['find-order', OrdersTools].",
      );
    }
    const picked = new Map<string, AiToolEntry>();
    for (const item of selection) {
      if (typeof item === "string") {
        const entry = this.entries.get(item);
        if (!entry) {
          throw new AiConfigurationError(
            `There is no agent function named "${item}". ${this.known()}`,
          );
        }
        picked.set(entry.name, entry);
      } else if (typeof item === "function") {
        const matches = [...this.entries.values()].filter(
          (entry) =>
            entry.host === item || entry.host.prototype instanceof item,
        );
        if (matches.length === 0) {
          throw new AiConfigurationError(
            `${item.name} has no agent functions, or is not a provider of the application. ${this.known()}`,
          );
        }
        for (const entry of matches) {
          picked.set(entry.name, entry);
        }
      } else {
        throw new AiConfigurationError(
          `\`tools\` lists agent function names and provider classes; got ${String(item)}.`,
        );
      }
    }
    return [...picked.values()];
  }

  /** Finds the agent functions, once. */
  scan(): void {
    if (this.scanned) {
      return;
    }
    this.scanned = true;
    const seen = new Set<object>();
    const wrappers = this.discovery.getProviders(
      this.options?.include
        ? { include: this.options.include }
        : undefined,
    );
    for (const wrapper of wrappers) {
      const { instance } = wrapper;
      if (
        !instance ||
        typeof instance !== "object" ||
        wrapper.isAlias ||
        seen.has(instance)
      ) {
        continue;
      }
      seen.add(instance);
      const prototype = Object.getPrototypeOf(instance);
      if (!prototype) continue;
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const method = prototype[methodName];
        if (typeof method !== "function") continue;
        const definition = MetadataRegistry.get<any>(AGENT_FUNCTION_METADATA, method);
        if (!definition) {
          continue;
        }
        const where = `${wrapper.metatype?.name ?? instance.constructor.name}.${methodName}`;
        const rawStatic = (wrapper as unknown as Record<string, unknown>)[
          "isDependencyTreeStatic"
        ];
        const isStatic =
          typeof rawStatic === "function"
            ? (rawStatic as () => boolean).call(wrapper)
            : rawStatic !== false;
        if (!isStatic) {
          throw new AiConfigurationError(
            `${where}: agent functions must be on singleton providers, and this one is request-scoped or transient (or depends on a request-scoped provider). Pass what a call needs through \`caller\` instead.`,
          );
        }
        const name: string = definition.name ?? methodName;
        assertProviderToolName(name, where);
        const existing = this.entries.get(name);
        if (existing) {
          throw new AiConfigurationError(
            `${where}: there is already an agent function named "${name}" (${existing.where}). Give one of them another { name }.`,
          );
        }
        recordHandlerParams(instance.constructor, methodName);
        const handler = this.externalContextCreator.create(
          instance,
          method,
          methodName,
          AI_PARAMS_METADATA,
          this.paramsFactory,
          undefined,
          undefined,
          undefined,
          AI_CONTEXT_TYPE,
        ) as AiToolHandler;
        this.entries.set(name, {
          name,
          ...(definition.description !== undefined && {
            description: definition.description,
          }),
          ...(definition.scopes?.length && { scopes: [...definition.scopes] }),
          inputSchema: definition.inputSchema
            ? toModelSchema(definition.inputSchema, `${where} inputSchema`, {
                object: true,
              })
            : EMPTY_OBJECT_SCHEMA,
          handler,
          host: instance.constructor,
          where,
        });
      }
    }
  }

  private known(): string {
    const names = [...this.entries.keys()];
    return names.length
      ? `Agent functions: ${names.join(", ")}.`
      : "The application has no agent functions (@AgentFunction() methods).";
  }
}
