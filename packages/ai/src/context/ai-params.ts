import type { ParamsFactory } from '@bunest/core';
import { AI_PARAMS_METADATA } from '../ai.constants';

/**
 * The parameters of an agent function. Pipes see the input as a `body` parameter
 * (3) and the context as a `custom` one (1001).
 */
export enum AiParamtype {
  INPUT = 3,
  CONTEXT = 1001,
}

export class AiParamsFactory implements ParamsFactory {
  exchangeKeyForValue(
    type: number | string,
    data: unknown,
    args: unknown[],
  ): unknown {
    switch (type) {
      case AiParamtype.INPUT: {
        const input = args[0] as Record<string, unknown> | undefined;
        return typeof data === 'string' && input ? input[data] : input;
      }
      case AiParamtype.CONTEXT:
        return args[1];
      default:
        return null;
    }
  }
}

/**
 * Records the two parameters of an agent function, `(input, context)`, as parameter metadata,
 * where no parameter decorator took their place.
 */
export function recordHandlerParams(target: Function, methodName: string): void {
  const existing: Record<string, { index: number }> =
    Reflect.getMetadata(AI_PARAMS_METADATA, target, methodName) ?? {};
  const taken = new Set(Object.values(existing).map((param) => param.index));
  if (taken.has(0) && taken.has(1)) {
    return;
  }
  Reflect.defineMetadata(
    AI_PARAMS_METADATA,
    {
      ...existing,
      ...(!taken.has(0) && {
        [`${AiParamtype.INPUT}:0`]: { index: 0, data: undefined, pipes: [] },
      }),
      ...(!taken.has(1) && {
        [`${AiParamtype.CONTEXT}:1`]: { index: 1, data: undefined, pipes: [] },
      }),
    },
    target,
    methodName,
  );
}
