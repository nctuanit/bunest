import {
  All,
  Controller,
  MetadataRegistry,
  Req,
  type ControllerOptions,
  type Type,
} from "@bunest/core";
import { MCP_INTERNAL_CONTROLLER } from "../mcp.constants";
import { McpHttpService } from "./mcp-http.service";

/**
 * Dynamically creates the Streamable HTTP endpoint controller at `path` with optional
 * versioning and class decorators.
 */
export function createMcpController(
  path: string,
  version: ControllerOptions["version"],
  decorators: ClassDecorator[],
): Type<unknown> {
  @Controller({
    path,
    ...(version !== undefined ? { version } : {}),
  })
  class McpEndpointController {
    constructor(private readonly httpService: McpHttpService) {}

    @All()
    handle(@Req() req: Request): Promise<Response> {
      return this.httpService.fetch(req);
    }
  }

  MetadataRegistry.define(MCP_INTERNAL_CONTROLLER, true, McpEndpointController);

  for (const decorator of decorators) {
    decorator(McpEndpointController);
  }

  return McpEndpointController;
}
