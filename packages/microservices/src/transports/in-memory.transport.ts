import { ClientProxy } from "../client-proxy";
import { RpcException } from "../exceptions";
import type { InMemoryTransportOptions, RpcContext } from "../interfaces";
import { MicroserviceTransportServer } from "../server";
import { Transport } from "../tokens";

/**
 * In-process message broker routing RPC requests and events directly between
 * `InMemoryServer` and `InMemoryClientProxy` with zero sockets (ideal for tests).
 */
export class InMemoryBroker {
  private readonly servers = new Map<string, InMemoryServer>();

  registerServer(channel: string, server: InMemoryServer): void {
    this.servers.set(channel, server);
  }

  unregisterServer(channel: string, server: InMemoryServer): void {
    if (this.servers.get(channel) === server) {
      this.servers.delete(channel);
    }
  }

  getServer(channel: string): InMemoryServer | undefined {
    return this.servers.get(channel);
  }

  clear(): void {
    this.servers.clear();
  }
}

export const defaultInMemoryBroker = new InMemoryBroker();

export class InMemoryServer extends MicroserviceTransportServer {
  public readonly transport = Transport.IN_MEMORY;
  public readonly channel: string;

  private readonly broker: InMemoryBroker;

  constructor(options: InMemoryTransportOptions = {}) {
    super();
    this.channel = options.channel ?? "default";
    this.broker =
      options.broker instanceof InMemoryBroker
        ? options.broker
        : defaultInMemoryBroker;
  }

  async listen(
    callback?: (...optionalParams: unknown[]) => any,
  ): Promise<void> {
    this.broker.registerServer(this.channel, this);
    this.listening = true;
    this.emitStatus("connected");
    callback?.();
  }

  async close(): Promise<void> {
    this.listening = false;
    this.broker.unregisterServer(this.channel, this);
    this.emitStatus("disconnected");
  }

  async handleRequest(
    pattern: string,
    data: unknown,
  ): Promise<{
    response?: unknown;
    error?: ReturnType<RpcException["toSerialized"]>;
  }> {
    const ctx: RpcContext = {
      transport: Transport.IN_MEMORY,
      pattern,
      metadata: { channel: this.channel },
    };
    return await this.dispatchMessage(pattern, data, ctx);
  }

  override async handleEvent(pattern: string, data: unknown): Promise<void> {
    const ctx: RpcContext = {
      transport: Transport.IN_MEMORY,
      pattern,
      metadata: { channel: this.channel },
    };
    await this.dispatchEvent(pattern, data, ctx);
  }
}

export class InMemoryClientProxy extends ClientProxy {
  public readonly transport = Transport.IN_MEMORY;
  public readonly channel: string;

  private readonly broker: InMemoryBroker;
  private connected = false;

  constructor(options: InMemoryTransportOptions = {}) {
    super(options.defaultTimeoutMs ?? 5000);
    this.channel = options.channel ?? "default";
    this.broker =
      options.broker instanceof InMemoryBroker
        ? options.broker
        : defaultInMemoryBroker;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  protected override async sendOnce<TRes = any, TReq = any>(
    pattern: string,
    data: TReq,
  ): Promise<TRes> {
    const server = this.broker.getServer(this.channel);
    if (!server || !server.isListening) {
      throw new Error(
        `No listening InMemoryServer registered on channel "${this.channel}".`,
      );
    }

    this.connected = true;
    const outcome = await server.handleRequest(pattern, data);
    if (outcome.error) {
      if (outcome.error.isRpcException) {
        throw RpcException.fromSerialized(outcome.error);
      }
      const err = new Error(outcome.error.message);
      if (outcome.error.name) err.name = outcome.error.name;
      throw err;
    }
    return outcome.response as TRes;
  }

  protected override async dispatchEvent<TReq = any>(
    pattern: string,
    data: TReq,
  ): Promise<void> {
    const server = this.broker.getServer(this.channel);
    if (!server || !server.isListening) {
      throw new Error(
        `No listening InMemoryServer registered on channel "${this.channel}".`,
      );
    }
    this.connected = true;
    await server.handleEvent(pattern, data);
  }
}
