import {
  Inject,
  Injectable,
  MetadataRegistry,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
  type Type,
} from "@bunest/common";
import { type DIContainer, DiscoveryService, ModuleRef } from "@bunest/core";
import type { BunHttpAdapter } from "@bunest/http";
import { BunWebSocketAdapter } from "../adapter/bun-ws.adapter";
import {
  WS_HTTP_ADAPTER,
  WS_METADATA_KEYS,
  WS_MODULE_OPTIONS,
} from "../constants";
import type { WebSocketModuleOptions } from "../interfaces/ws.interface";

function resolveDiscoveryService(
  discoveryService: DiscoveryService | undefined,
  moduleRef: ModuleRef | undefined,
  container: DIContainer | undefined,
): DiscoveryService | undefined {
  if (discoveryService) {
    return discoveryService;
  }
  if (container) {
    return container.getDiscoveryService();
  }
  if (moduleRef) {
    try {
      return moduleRef.get(DiscoveryService, { strict: false });
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Discovers all `@WebSocketGateway()` providers registered across loaded modules
 * on `onApplicationBootstrap`, wires them into `BunWebSocketAdapter` & `BunHttpAdapter`,
 * and disconnects all open sockets cleanly during `onModuleDestroy`.
 */
@Injectable()
export class WsGatewayExplorer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  public readonly adapter: BunWebSocketAdapter;
  private container?: DIContainer;
  private discovered = false;

  constructor(
    @Optional()
    @Inject(WS_MODULE_OPTIONS)
    options: WebSocketModuleOptions = {},
    @Optional()
    @Inject(WS_HTTP_ADAPTER)
    httpAdapter?: BunHttpAdapter,
    @Optional()
    private readonly moduleRef?: ModuleRef,
    @Optional()
    private readonly discoveryService?: DiscoveryService,
  ) {
    this.adapter = new BunWebSocketAdapter(
      { ...options, httpAdapter: httpAdapter ?? options.httpAdapter },
      async <T = unknown>(enhancer: Type<T> | T): Promise<T> => {
        if (typeof enhancer !== "function") {
          return enhancer;
        }
        const discovery = resolveDiscoveryService(
          this.discoveryService,
          this.moduleRef,
          this.container,
        );
        if (discovery) {
          return discovery.resolveEnhancer<T>(enhancer);
        }
        return new (enhancer as Type<T>)();
      },
    );
  }

  /**
   * Attaches a `BunHttpAdapter` and optional `DIContainer` (e.g. from `WebSocketModule.attach(app)`),
   * immediately discovering and binding all `@WebSocketGateway()` classes.
   */
  async attach(
    httpAdapter: BunHttpAdapter,
    container?: DIContainer,
  ): Promise<void> {
    if (container) {
      this.container = container;
    }
    this.adapter.attachToHttpAdapter(httpAdapter);
    await this.discoverAndBindGateways();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.discoverAndBindGateways();
  }

  async onModuleDestroy(): Promise<void> {
    await this.adapter.closeAll();
  }

  async discoverAndBindGateways(): Promise<void> {
    if (this.discovered) {
      return;
    }
    const discovery = resolveDiscoveryService(
      this.discoveryService,
      this.moduleRef,
      this.container,
    );
    if (!discovery) {
      return;
    }

    this.discovered = true;
    const instances = discovery.getAllSingletonInstances();

    for (let i = 0; i < instances.length; i++) {
      const instance = instances[i];
      if (!instance || typeof instance !== "object") {
        continue;
      }
      const ctor = instance.constructor;
      if (
        typeof ctor === "function" &&
        MetadataRegistry.has(WS_METADATA_KEYS.GATEWAY, ctor)
      ) {
        await this.adapter.registerGateway(instance);
      }
    }
  }
}
