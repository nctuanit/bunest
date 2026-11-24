import {
  Inject,
  Injectable,
  MetadataRegistry,
  type OnModuleInit,
  type Type,
} from "@bunest/core";
import {
  DiscoveryService,
  ExternalContextCreator,
  MetadataScanner,
} from "@bunest/core";
import { McpParamsFactory, recordHandlerParams } from "../context/mcp-params";
import type {
  McpContext,
  McpModuleOptions,
  McpPrimitiveMetadata,
  McpSchema,
  PromptOptions,
  ResourceOptions,
  ResourceTemplateOptions,
  ToolOptions,
} from "../interfaces/mcp-types";
import {
  MCP_CONTEXT_TYPE,
  MCP_HTTP_ENDPOINT,
  MCP_MODULE_OPTIONS,
  MCP_PARAMS_METADATA,
  MCP_PRIMITIVE_METADATA,
} from "../mcp.constants";
import { assertName, assertScopes, assertToolName } from "../utils/names.util";
import { prepareSchema } from "../utils/schema.util";
import {
  type CompiledUriTemplate,
  compileUriTemplate,
} from "../utils/uri-template.util";

export type McpHandler = (
  input: unknown,
  context: McpContext,
) => Promise<unknown>;

interface Entry<TOptions> {
  name: string;
  options: TOptions;
  handler: McpHandler;
  where: string;
}

export interface McpToolEntry extends Entry<ToolOptions> {
  inputSchema?: McpSchema;
  outputSchema?: McpSchema;
}

export interface McpResourceEntry extends Entry<ResourceOptions> {
  uri: string;
}

export interface McpResourceTemplateEntry extends Entry<ResourceTemplateOptions> {
  uriTemplate: string;
  compiled: CompiledUriTemplate;
}

export interface McpPromptEntry extends Entry<PromptOptions> {
  argsSchema?: McpSchema;
}

/**
 * Discovers all `@Tool()`, `@Resource()`, `@ResourceTemplate()`, and `@Prompt()` methods
 * across application providers and wraps each with Nest/Bunest enhancers via `ExternalContextCreator`.
 */
@Injectable()
export class McpRegistry implements OnModuleInit {
  readonly tools: McpToolEntry[] = [];
  readonly resources: McpResourceEntry[] = [];
  readonly resourceTemplates: McpResourceTemplateEntry[] = [];
  readonly prompts: McpPromptEntry[] = [];

  private readonly paramsFactory = new McpParamsFactory();
  private scanned = false;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly externalContextCreator: ExternalContextCreator,
    @Inject(MCP_MODULE_OPTIONS) private readonly options: McpModuleOptions,
    @Inject(MCP_HTTP_ENDPOINT)
    private readonly endpoint: { path: string | null },
  ) {}

  onModuleInit(): void {
    this.scan();
  }

  get size(): number {
    return (
      this.tools.length +
      this.resources.length +
      this.resourceTemplates.length +
      this.prompts.length
    );
  }

  scan(): void {
    if (this.scanned) {
      return;
    }
    this.scanned = true;

    const wrappers = this.discovery.getProviders(
      this.options.include
        ? { include: this.options.include as Type<unknown>[] }
        : undefined,
    );

    const seenInstances = new Set<object>();
    for (const wrapper of wrappers) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== "object") {
        continue;
      }
      if (seenInstances.has(instance)) {
        continue;
      }
      seenInstances.add(instance);

      const proto = Object.getPrototypeOf(instance) as object | null;
      if (!proto || proto === Object.prototype) {
        continue;
      }

      const methodNames = this.scanner.getAllMethodNames(proto);
      for (const methodName of methodNames) {
        const fn = (proto as Record<string, unknown>)[methodName];
        if (typeof fn !== "function") {
          continue;
        }
        const meta = MetadataRegistry.get<McpPrimitiveMetadata>(
          MCP_PRIMITIVE_METADATA,
          fn,
        );
        if (!meta) {
          continue;
        }
        this.add(
          instance,
          methodName,
          fn as (...args: unknown[]) => unknown,
          meta,
        );
      }
    }

    this.assertScopesAreEnforced();
  }

  private add(
    instance: object,
    methodName: string,
    fn: (...args: unknown[]) => unknown,
    meta: McpPrimitiveMetadata,
  ): void {
    const className = instance.constructor?.name ?? "Unknown";
    const where = `${className}.${methodName}`;
    assertScopes(meta.options.scopes, where);

    recordHandlerParams(instance.constructor, methodName);
    const wrapped = this.externalContextCreator.create(
      instance,
      fn,
      methodName,
      MCP_PARAMS_METADATA,
      this.paramsFactory,
      undefined,
      undefined,
      { guards: true, interceptors: true, filters: true, pipes: true },
      MCP_CONTEXT_TYPE,
    ) as McpHandler;

    switch (meta.kind) {
      case "tool": {
        const name = meta.options.name ?? methodName;
        assertToolName(name, where);
        this.assertUnique(this.tools, name, "tool", where);
        const inputSchema = meta.options.inputSchema
          ? prepareSchema(meta.options.inputSchema, where, "input")
          : undefined;
        const outputSchema = meta.options.outputSchema
          ? prepareSchema(meta.options.outputSchema, where, "output")
          : undefined;
        this.tools.push({
          name,
          options: meta.options,
          handler: wrapped,
          where,
          ...(inputSchema ? { inputSchema } : {}),
          ...(outputSchema ? { outputSchema } : {}),
        });
        break;
      }
      case "resource": {
        const name = meta.options.name ?? methodName;
        assertName(name, where, "resource");
        if (!meta.options.uri || typeof meta.options.uri !== "string") {
          throw new TypeError(
            `${where}: @Resource() requires a non-empty uri.`,
          );
        }
        if (this.resources.some((r) => r.uri === meta.options.uri)) {
          throw new Error(
            `${where}: duplicate MCP resource URI "${meta.options.uri}".`,
          );
        }
        this.resources.push({
          name,
          uri: meta.options.uri,
          options: meta.options,
          handler: wrapped,
          where,
        });
        break;
      }
      case "resource-template": {
        const name = meta.options.name ?? methodName;
        assertName(name, where, "resource template");
        if (
          !meta.options.uriTemplate ||
          typeof meta.options.uriTemplate !== "string"
        ) {
          throw new TypeError(
            `${where}: @ResourceTemplate() requires a non-empty uriTemplate.`,
          );
        }
        if (
          this.resourceTemplates.some(
            (r) => r.uriTemplate === meta.options.uriTemplate,
          )
        ) {
          throw new Error(
            `${where}: duplicate MCP resource template "${meta.options.uriTemplate}".`,
          );
        }
        this.resourceTemplates.push({
          name,
          uriTemplate: meta.options.uriTemplate,
          compiled: compileUriTemplate(meta.options.uriTemplate),
          options: meta.options,
          handler: wrapped,
          where,
        });
        break;
      }
      case "prompt": {
        const name = meta.options.name ?? methodName;
        assertName(name, where, "prompt");
        this.assertUnique(this.prompts, name, "prompt", where);
        const argsSchema = meta.options.argsSchema
          ? prepareSchema(meta.options.argsSchema, where, "input")
          : undefined;
        this.prompts.push({
          name,
          options: meta.options,
          handler: wrapped,
          where,
          ...(argsSchema ? { argsSchema } : {}),
        });
        break;
      }
    }
  }

  private assertUnique(
    collection: Array<{ name: string; where: string }>,
    name: string,
    kind: string,
    where: string,
  ): void {
    const dup = collection.find((item) => item.name === name);
    if (dup) {
      throw new Error(
        `${where}: duplicate MCP ${kind} "${name}" (already registered by ${dup.where}).`,
      );
    }
  }

  private assertScopesAreEnforced(): void {
    if (this.endpoint.path === null || this.options.auth) {
      return;
    }
    const scoped = [
      ...this.tools,
      ...this.resources,
      ...this.resourceTemplates,
      ...this.prompts,
    ].find((entry) => entry.options.scopes && entry.options.scopes.length > 0);
    if (scoped) {
      throw new Error(
        `${scoped.where} declares OAuth { scopes }, which requires configuring \`auth\` on McpModule when serving HTTP.`,
      );
    }
  }
}
