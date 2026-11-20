import type {
  FormattedExecutionResult,
  GraphQLRequest,
} from "../server/apollo-server.types";
import { HeaderMap } from "../server/header-map";

export interface GraphQLDataSourceProcessOptions<
  TContext extends Record<string, any> = Record<string, any>,
> {
  request: GraphQLRequest;
  context: TContext;
  incomingRequestContext?: unknown;
  kind?: "loading schema" | "incoming operation";
}

export interface GraphQLDataSource<
  TContext extends Record<string, any> = Record<string, any>,
> {
  process(
    options: GraphQLDataSourceProcessOptions<TContext>,
  ): Promise<FormattedExecutionResult>;
}

export type FetcherFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RemoteGraphQLDataSourceOptions<
  TContext extends Record<string, any> = Record<string, any>,
> {
  url: string;
  fetcher?: FetcherFn;
  willSendRequest?: (options: {
    request: GraphQLRequest;
    context: TContext;
  }) => Promise<void> | void;
  didReceiveResponse?: (options: {
    response: FormattedExecutionResult;
    request: GraphQLRequest;
    context: TContext;
    httpResponse: Response;
  }) => Promise<FormattedExecutionResult> | FormattedExecutionResult;
  didEncounterError?: (
    error: Error,
    fetchRequest: Request,
    fetchResponse?: Response,
    context?: TContext,
  ) => Promise<void> | void;
}

/**
 * Bun-native `RemoteGraphQLDataSource` forwarding GraphQL operations to a remote
 * federated subgraph over native `fetch()`.
 */
export class RemoteGraphQLDataSource<
  TContext extends Record<string, any> = Record<string, any>,
> implements GraphQLDataSource<TContext>
{
  public url: string;
  protected readonly fetcher: FetcherFn;
  private readonly willSendRequestHook?: RemoteGraphQLDataSourceOptions<TContext>["willSendRequest"];
  private readonly didReceiveResponseHook?: RemoteGraphQLDataSourceOptions<TContext>["didReceiveResponse"];
  private readonly didEncounterErrorHook?: RemoteGraphQLDataSourceOptions<TContext>["didEncounterError"];

  constructor(config: RemoteGraphQLDataSourceOptions<TContext>) {
    this.url = config.url;
    this.fetcher = config.fetcher ?? ((input, init) => fetch(input, init));
    this.willSendRequestHook = config.willSendRequest;
    this.didReceiveResponseHook = config.didReceiveResponse;
    this.didEncounterErrorHook = config.didEncounterError;
  }

  async willSendRequest(options: {
    request: GraphQLRequest;
    context: TContext;
  }): Promise<void> {
    if (this.willSendRequestHook) {
      await this.willSendRequestHook(options);
    }
  }

  async didReceiveResponse(options: {
    response: FormattedExecutionResult;
    request: GraphQLRequest;
    context: TContext;
    httpResponse: Response;
  }): Promise<FormattedExecutionResult> {
    if (this.didReceiveResponseHook) {
      return await this.didReceiveResponseHook(options);
    }
    return options.response;
  }

  async didEncounterError(
    error: Error,
    fetchRequest: Request,
    fetchResponse?: Response,
    context?: TContext,
  ): Promise<void> {
    if (this.didEncounterErrorHook) {
      await this.didEncounterErrorHook(error, fetchRequest, fetchResponse, context);
      return;
    }
    throw error;
  }

  async process(
    options: GraphQLDataSourceProcessOptions<TContext>,
  ): Promise<FormattedExecutionResult> {
    const request: GraphQLRequest = {
      ...options.request,
      http: {
        method: "POST",
        headers: new HeaderMap(options.request.http?.headers),
      },
    };
    request.http!.headers.set("content-type", "application/json");

    await this.willSendRequest({ request, context: options.context });

    const headers = new Headers();
    for (const [k, v] of request.http!.headers.entries()) {
      headers.set(k, v);
    }
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const body = JSON.stringify({
      query: request.query,
      ...(request.variables !== undefined ? { variables: request.variables } : {}),
      ...(request.operationName !== undefined
        ? { operationName: request.operationName }
        : {}),
      ...(request.extensions !== undefined
        ? { extensions: request.extensions }
        : {}),
    });

    const fetchRequest = new Request(this.url, {
      method: "POST",
      headers,
      body,
    });

    let httpResponse: Response | undefined;
    try {
      httpResponse = await this.fetcher(fetchRequest);
      if (!httpResponse.ok) {
        let parsedBody: FormattedExecutionResult | undefined;
        try {
          parsedBody = (await httpResponse.json()) as FormattedExecutionResult;
        } catch {
          // Non-JSON error body
        }
        if (parsedBody && Array.isArray(parsedBody.errors)) {
          return await this.didReceiveResponse({
            response: parsedBody,
            request,
            context: options.context,
            httpResponse,
          });
        }
        const err = new Error(
          `Subgraph request to ${this.url} failed with HTTP ${httpResponse.status}`,
        );
        await this.didEncounterError(
          err,
          fetchRequest,
          httpResponse,
          options.context,
        );
        return { errors: [{ message: err.message }] };
      }

      const parsed = (await httpResponse.json()) as FormattedExecutionResult;
      return await this.didReceiveResponse({
        response: parsed,
        request,
        context: options.context,
        httpResponse,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.didEncounterError(
        error,
        fetchRequest,
        httpResponse,
        options.context,
      );
      return { errors: [{ message: error.message }] };
    }
  }
}
