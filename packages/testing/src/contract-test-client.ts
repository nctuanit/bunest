import {
  createContractClient,
  type ContractClient,
  type ContractClientOptions,
  type ContractTree,
} from "@bunest/core/client";
import type { FetchCapable } from "./interfaces/testing.interface";

/** Options accepted by `createContractTestClient()` (dispatches directly into `app.fetch()`). */
export interface ContractTestClientOptions
  extends Omit<ContractClientOptions, "fetch" | "client"> {
  /** Base origin used when constructing in-memory `Request` objects (default: `"http://localhost"`). */
  readonly baseUrl?: string | URL | undefined;
}

/**
 * Creates a zero-socket, 100% end-to-end type-safe `ContractClient` backed
 * directly by `target.fetch()` (`BunestApplication`, `BunHttpAdapter`, or
 * `BunestFetchHandler`).
 */
export function createContractTestClient<TRoutes extends ContractTree>(
  target: FetchCapable,
  contract: TRoutes,
  options: ContractTestClientOptions = {},
): ContractClient<TRoutes> {
  const { baseUrl = "http://localhost", ...rest } = options;

  const inMemoryFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const req =
      input instanceof Request
        ? init === undefined
          ? input
          : new Request(input, init)
        : new Request(String(input), init);
    return target.fetch(req);
  }) as unknown as typeof globalThis.fetch;

  return createContractClient(contract, {
    ...rest,
    baseUrl,
    fetch: inMemoryFetch,
  });
}
