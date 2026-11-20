import { type DynamicModule, Module } from "@bunest/common";
import type { BunestApplication } from "@bunest/core";
import { BunWebSocketAdapter } from "./adapter/bun-ws.adapter";
import { WS_HTTP_ADAPTER, WS_MODULE_OPTIONS } from "./constants";
import { WsGatewayExplorer } from "./explorer/ws-gateway.explorer";
import type { WebSocketModuleOptions } from "./interfaces/ws.interface";

/**
 * Bunest WebSocket module enabling native `Bun.serve({ websocket })` gateways,
 * rooms/pub-sub, handshake authentication, and WS pipeline enhancers.
 */
@Module({})
export class WebSocketModule {
  static forRoot(options: WebSocketModuleOptions = {}): DynamicModule {
    return {
      module: WebSocketModule,
      global: options.global ?? true,
      providers: [
        {
          provide: WS_MODULE_OPTIONS,
          useValue: options,
        },
        {
          provide: WS_HTTP_ADAPTER,
          useValue: options.httpAdapter,
        },
        WsGatewayExplorer,
        {
          provide: BunWebSocketAdapter,
          inject: [WsGatewayExplorer],
          useFactory: (explorer: WsGatewayExplorer) => explorer.adapter,
        },
      ],
      exports: [WsGatewayExplorer, BunWebSocketAdapter],
    };
  }

  /**
   * Binds `WebSocketModule`'s `WsGatewayExplorer` and all discovered `@WebSocketGateway()`
   * instances onto a `BunestApplication`'s `BunHttpAdapter` before `app.listen()`.
   */
  static async attach(app: BunestApplication): Promise<BunWebSocketAdapter> {
    let explorer: WsGatewayExplorer | undefined;
    try {
      explorer = app.get(WsGatewayExplorer, { strict: false });
    } catch {
      explorer = undefined;
    }

    if (!explorer) {
      explorer = new WsGatewayExplorer({}, app.getHttpAdapter());
    }

    await explorer.attach(app.getHttpAdapter(), app.getModuleContainer());
    return explorer.adapter;
  }
}
