import { MetadataRegistry } from "@bunest/core";
import type {
  McpPrimitiveMetadata,
  PromptOptions,
  ResourceOptions,
  ResourceTemplateOptions,
  ToolOptions,
} from "../interfaces/mcp-types";
import { MCP_PRIMITIVE_METADATA } from "../mcp.constants";

export function definePrimitive(
  metadata: McpPrimitiveMetadata,
): MethodDecorator {
  return (_target, propertyKey, descriptor) => {
    const fn = descriptor.value as object;
    if (MetadataRegistry.has(MCP_PRIMITIVE_METADATA, fn)) {
      throw new Error(
        `Method "${String(propertyKey)}" already has an MCP primitive decorator; a method may only serve one primitive.`,
      );
    }
    MetadataRegistry.define(MCP_PRIMITIVE_METADATA, metadata, fn);
    return descriptor;
  };
}

/** Exposes the method as an MCP tool. */
export function Tool(options: ToolOptions = {}): MethodDecorator {
  return definePrimitive({ kind: "tool", options });
}

/** Exposes the method as an MCP resource at a fixed `uri`. */
export function Resource(options: ResourceOptions): MethodDecorator {
  return definePrimitive({ kind: "resource", options });
}

/** Exposes the method as MCP resources matching an RFC 6570 `uriTemplate`. */
export function ResourceTemplate(
  options: ResourceTemplateOptions,
): MethodDecorator {
  return definePrimitive({ kind: "resource-template", options });
}

/** Exposes the method as an MCP prompt. */
export function Prompt(options: PromptOptions = {}): MethodDecorator {
  return definePrimitive({ kind: "prompt", options });
}
