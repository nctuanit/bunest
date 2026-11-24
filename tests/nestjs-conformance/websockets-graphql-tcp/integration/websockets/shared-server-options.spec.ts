import { afterEach, expect, it } from "bun:test";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  type WsResponse,
} from "../../../../../packages/core/src/ws";
import { Test, describeConformance, itAdapted } from "../../../_helpers";

// Bunest native equivalent of WsAdapter's `verifyClient: () => false` is `authenticate: () => false`,
// which rejects the HTTP upgrade request with HTTP 401 before calling `server.upgrade()`.
@WebSocketGateway({ path: "/ws", authenticate: () => false })
class CheckedGateway {
  @SubscribeMessage("checked")
  onChecked(): WsResponse<string> {
    return { event: "checked", data: "reply" };
  }
}

@WebSocketGateway({ path: "/ws" })
class OtherGateway {
  @SubscribeMessage("other")
  onOther(): WsResponse<string> {
    return { event: "other", data: "reply" };
  }
}

describeConformance(
  "Gateways sharing a server (BunWebSocketAdapter)",
  {
    upstreamPath: "integration/websockets/e2e/shared-server-options.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapted from WsAdapter verifyClient to Bunest native WebSocketGateway authenticate hook (ADR-001).",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    itAdapted(
      "ADR-001",
      "should reject WebSocket upgrade with 401 when authenticate returns false on a gateway",
      async () => {
        const testingModule = await Test.createTestingModule({
          imports: [WebSocketModule.forRoot()],
          providers: [CheckedGateway],
        }).compile({ logger: false });
        app = testingModule.createNestApplication({ logger: false });
        await WebSocketModule.attach(app);
        const info = await app.listen({ port: 0, hostname: "127.0.0.1" });

        const response = await fetch(`http://127.0.0.1:${info.port}/ws`, {
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version": "13",
          },
        });

        expect(response.status).toBe(401);
      },
      "native Bun WS pre-upgrade authenticate hook",
    );

    it("should create the server with the options of the gateway declared first [ADR-001]", async () => {
      const testingModule = await Test.createTestingModule({
        imports: [WebSocketModule.forRoot()],
        providers: [CheckedGateway, OtherGateway],
      }).compile({ logger: false });
      app = testingModule.createNestApplication({ logger: false });
      await WebSocketModule.attach(app);
      const info = await app.listen({ port: 0, hostname: "127.0.0.1" });

      const response = await fetch(`http://127.0.0.1:${info.port}/ws`, {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      });

      expect(response.status).toBe(401);
    });

    itAdapted(
      "ADR-001",
      'should not start when the gateway declared first sets no "authenticate" and a later one on the same path does',
      async () => {
        const testingModule = await Test.createTestingModule({
          imports: [WebSocketModule.forRoot()],
          providers: [OtherGateway, CheckedGateway],
        }).compile({ logger: false });
        app = testingModule.createNestApplication({ logger: false });

        await expect(WebSocketModule.attach(app)).rejects.toThrow(
          /Duplicate @WebSocketGateway\(\) path "\/ws" in CheckedGateway/,
        );
      },
      "BunWebSocketAdapter rejects conflicting duplicate gateway path at startup",
    );
  },
);
