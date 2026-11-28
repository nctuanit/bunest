import { createContractClient } from "@bunest/core/client";
import { appContract } from "../shared/contract";

/**
 * Browser-safe, zero-codegen typed client factory usable in React, Next.js,
 * Vue, Svelte, or Bun scripts without any OpenAPI codegen step.
 */
export function createTasksApiClient(baseUrl: string, apiKey?: string) {
  return createContractClient(appContract, {
    baseUrl,
    headers: apiKey ? { "x-api-key": apiKey } : undefined,
  });
}
