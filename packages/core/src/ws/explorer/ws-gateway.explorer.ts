import {
  Inject,
  Injectable,
  MetadataRegistry,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
  Scope,
  type Type,
} from "../../common/index";
import { type DIContainer, DiscoveryService, ModuleRef } from "../../index";
import type { BunHttpAdapter } from "../../http/index";
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
      this.adapter.setContainer(container);
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

    if (this.container) {
      this.adapter.setContainer(this.container);
    }

    this.discovered = true;
    const seenClasses = new Set<Function>();
    const wrappers = [
      ...discovery.getProviders(),
      ...discovery.getControllers(),
    ];

    for (let i = 0; i < wrappers.length; i++) {
      const wrapper = wrappers[i];
      if (!wrapper) continue;
      const ctor =
        wrapper.metatype ??
        (wrapper.instance && typeof wrapper.instance === "object"
          ? (wrapper.instance.constructor as Type<unknown>)
          : undefined);
      if (
        typeof ctor !== "function" ||
        seenClasses.has(ctor) ||
        !MetadataRegistry.has(WS_METADATA_KEYS.GATEWAY, ctor)
      ) {
        continue;
      }
      seenClasses.add(ctor);

      const isRequestScoped =
        wrapper.scope === Scope.REQUEST ||
        wrapper.instance === undefined ||
        wrapper.instance === null;

      if (isRequestScoped) {
        await this.adapter.registerGatewayClass(
          ctor as Type<unknown>,
          wrapper.moduleId,
        );
      } else if (typeof wrapper.instance === "object") {
        await this.adapter.registerGateway(wrapper.instance, wrapper.moduleId);
      }
    }
  }
}
