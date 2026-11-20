import {
  All,
  Controller,
  Req,
  type ControllerOptions,
  type Type,
} from "@bunest/common";
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

  for (const decorator of decorators) {
    decorator(McpEndpointController);
  }

  return McpEndpointController;
}
