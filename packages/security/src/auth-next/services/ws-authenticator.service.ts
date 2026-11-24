import { Injectable, Logger, type ExecutionContext } from "@bunest/core";
import { AuthenticationError } from "../errors/authentication.error";
import type {
  AuthenticatedSession,
  AuthenticatedUser,
  AuthenticationResult,
} from "../interfaces/authentication-result.interface";
import { setAuthState } from "../utils/auth-state.util";
import { AuthenticationRegistry } from "./authentication-registry.service";

export interface WsUpgradeRequestLike {
  headers?: Record<string, string | string[] | undefined> | Headers;
  url?: string;
  method?: string;
  socket?: { remoteAddress?: string };
}

interface WsClientLike {
  handshake?: { headers?: Record<string, string | string[] | undefined> };
  request?: WsUpgradeRequestLike;
  close?: (code?: number, reason?: string) => void;
  disconnect?: (close?: boolean) => void;
}

class WsHandshake {
  handleConnection(): void {}
}

function createWsHandshakeContext(client: unknown): ExecutionContext {
  const args: unknown[] = [client, undefined];
  return {
    getType: <TContext extends string = "ws">() => "ws" as TContext,
    getClass: <T = any>() => WsHandshake as unknown as new (...a: any[]) => T,
    getHandler: () => WsHandshake.prototype.handleConnection,
    getArgs: <T extends unknown[] = unknown[]>() => args as T,
    getArgByIndex: <T = unknown>(index: number) => args[index] as T,
    switchToHttp: () => ({
      getRequest: <T = unknown>() => undefined as T,
      getResponse: <T = unknown>() => undefined as T,
      getNext: <T = unknown>() => undefined as T,
    }),
    switchToRpc: () => ({
      getData: <T = unknown>() => args[1] as T,
      getContext: <T = unknown>() => args[0] as T,
    }),
    switchToWs: () => ({
      getClient: <T = unknown>() => args[0] as T,
      getData: <T = unknown>() => args[1] as T,
      getPattern: () => "",
    }),
  };
}

/**
 * Handshake authentication for WebSocket gateways.
 */
@Injectable()
export class WsAuthenticator {
  private static readonly logger = new Logger("WsAuthenticator");

  constructor(private readonly registry: AuthenticationRegistry) {}

  async authenticateConnection<
    TUser = AuthenticatedUser,
    TSession = AuthenticatedSession,
  >(
    client: WsClientLike,
    request?: WsUpgradeRequestLike,
    { required = true }: { required?: boolean } = {},
  ): Promise<AuthenticationResult<TUser, TSession> | null> {
    if (request && !client.handshake) {
      client.request = request;
    }
    const context = createWsHandshakeContext(client);
    let result: AuthenticationResult<TUser, TSession> | null = null;
    try {
      result = (await this.run(context)) as AuthenticationResult<
        TUser,
        TSession
      > | null;
    } catch (error) {
      if (!(error instanceof AuthenticationError)) {
        WsAuthenticator.logger.error(
          "Authenticating a WebSocket connection failed",
          (error as Error | undefined)?.stack,
        );
        close(client, 1011, "Internal Error");
        return null;
      }
    }
    if (result?.mfa === "pending") {
      result = null;
    }
    setAuthState(context, result);
    if (!result && required) {
      close(client, 1008, "Unauthorized");
    }
    return result;
  }

  private async run(
    context: ExecutionContext,
  ): Promise<AuthenticationResult<any, any> | null> {
    for (const provider of this.registry.providers) {
      const result = await provider.authenticate(context);
      if (result?.user) {
        return result;
      }
    }
    return null;
  }
}

function close(client: WsClientLike, code: number, reason: string): void {
  if (client.close) {
    client.close(code, reason);
  } else {
    client.disconnect?.(true);
  }
}
