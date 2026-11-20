import { AGENT_FUNCTION_METADATA } from '../ai.constants';
import type { AgentFunctionOptions } from '../interfaces/agent-function.interface';

/**
 * Makes the method an agent function: one the application's agents may call.
 */
export function AgentFunction(options?: AgentFunctionOptions): MethodDecorator {
  return (
    target: Object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    Reflect.defineMetadata(
      AGENT_FUNCTION_METADATA,
      {
        name: options?.name ?? String(propertyKey),
        description: options?.description,
        inputSchema: options?.inputSchema,
        scopes: options?.scopes,
      },
      descriptor.value,
    );
    return descriptor;
  };
}
