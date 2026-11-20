import type { ParamsFactory } from "@bunest/core";
import { MCP_PARAMS_METADATA } from "../mcp.constants";

export enum McpParamtype {
  INPUT = 3,
  CONTEXT = 1001,
}

export class McpParamsFactory implements ParamsFactory {
  exchangeKeyForValue(
    type: number | string,
    _data: unknown,
    args: unknown[],
  ): unknown {
    if (type === McpParamtype.INPUT) {
      return args[0];
    }
    if (type === McpParamtype.CONTEXT) {
      return args[1];
    }
    return undefined;
  }
}

export function recordHandlerParams(
  target: Function,
  methodName: string,
): void {
  const existing =
    (Reflect.getMetadata(MCP_PARAMS_METADATA, target, methodName) as
      | Record<string, { index: number }>
      | undefined) ?? {};
  const occupied = new Set<number>(
    Object.values(existing).map((entry) => entry.index),
  );
  const next: Record<string, unknown> = { ...existing };

  if (!occupied.has(0)) {
    next[`${McpParamtype.INPUT}:0`] = { index: 0, data: undefined, pipes: [] };
  }
  if (!occupied.has(1)) {
    next[`${McpParamtype.CONTEXT}:1`] = { index: 1, data: undefined, pipes: [] };
  }

  Reflect.defineMetadata(MCP_PARAMS_METADATA, next, target, methodName);
}
