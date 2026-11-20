import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { Module } from "../../../../../packages/common/src";
import {
  Ack,
  type BunWsServer,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  WebSocketServer,
  WsGatewayExplorer,
  getGatewayMessageHandlers,
  getGatewayMethodParams,
  getGatewayServerProperties,
} from "../../../../../packages/websockets/src";
import {
  Test,
  describeConformance,
  itAdapted,
} from "../../../_helpers/index";

describeConformance(
  "GatewayMetadataExplorer / WsGatewayExplorer",
  {
    upstreamPath: "packages/websockets/test/gateway-metadata-explorer.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS GatewayMetadataExplorer unit specs to Bunest's public metadata readers (getGatewayMessageHandlers, getGatewayMethodParams, getGatewayServerProperties) and WsGatewayExplorer.",
  },
  () => {
    const message = "test";
    const secMessage = "test2";
    const ackMessage = "ack-test";

    @WebSocketGateway({ path: "/ws/explorer" })
    class TestGateway {
      @WebSocketServer() public server!: BunWsServer;
      @WebSocketServer() public anotherServer!: BunWsServer;

      get testGet() {
        return 0;
      }
      set testSet(_val: number) {}

      constructor() {}

      @SubscribeMessage(message)
      public test() {}

      @SubscribeMessage(secMessage)
      public testSec() {}

      @SubscribeMessage(ackMessage)
      public testWithAck(@Ack() _ack: Function) {}

      public noMessage() {}
    }

    describe("explore (getGatewayMessageHandlers & WsGatewayExplorer)", () => {
      it("should explore all @SubscribeMessage handlers and ignore getters, setters, constructor, and undecorated methods", () => {
        const handlers = getGatewayMessageHandlers(TestGateway);

        expect(handlers).toEqual([
          { event: message, handlerKey: "test" },
          { event: secMessage, handlerKey: "testSec" },
          { event: ackMessage, handlerKey: "testWithAck" },
        ]);
      });

      // BUNEST_BUG: @SubscribeMessage and @Ack store metadata on `target.constructor` / `Mixin.prototype` in packages/websockets/src/decorators/ws.decorators.ts. When TypeScript's `applyMixins()` copies property descriptors from `Mixin.prototype` onto `Host.prototype` (also overwriting `Host.prototype.constructor`), `getGatewayMessageHandlers(Host)` misses `mixedInWithAck` and `getGatewayMethodParams(Host, 'mixedInWithAck')` misses `@Ack()`.
      it.skip('should find the @Ack() of the handlers of a gateway whose "constructor" a mixin helper overwrote', () => {
        class Mixin {
          @SubscribeMessage(ackMessage)
          public mixedInWithAck(@Ack() _ack: Function) {}
        }
        class Host {
          @SubscribeMessage(ackMessage)
          public ownWithAck(@Ack() _ack: Function) {}

          @SubscribeMessage(message)
          public own() {}
        }
        // What the TypeScript handbook's `applyMixins()` does
        Object.defineProperties(
          Host.prototype,
          Object.getOwnPropertyDescriptors(Mixin.prototype),
        );

        const handlers = getGatewayMessageHandlers(Host);
        const mapped = handlers.map(({ handlerKey }) => {
          const params = getGatewayMethodParams(Host, handlerKey);
          const isAckHandledManually = params.some((p) => p.source === "ack");
          return [String(handlerKey), isAckHandledManually];
        });

        expect(mapped).toEqual([
          ["ownWithAck", true],
          ["own", false],
          ["mixedInWithAck", true],
        ]);
      });
    });

    describe("exploreMethodMetadata (getGatewayMethodParams)", () => {
      it("should return empty handlers/params for undecorated method", () => {
        const handlers = getGatewayMessageHandlers(TestGateway);
        expect(handlers.find((h) => h.handlerKey === "noMessage")).toBeUndefined();
        expect(getGatewayMethodParams(TestGateway, "noMessage")).toEqual([]);
      });

      it("should return message mapping properties for @SubscribeMessage method", () => {
        const metadata = getGatewayMessageHandlers(TestGateway).find(
          (h) => h.handlerKey === "test",
        );
        expect(metadata).toBeDefined();
        expect(metadata).toEqual({
          event: message,
          handlerKey: "test",
        });
      });

      it("should detect manual @Ack() parameter when @Ack decorator is used", () => {
        const params = getGatewayMethodParams(TestGateway, "testWithAck");
        const isAckHandledManually = params.some((p) => p.source === "ack");
        expect(isAckHandledManually).toBe(true);
      });

      it("should report no @Ack() parameter when @Ack decorator is not used", () => {
        const params = getGatewayMethodParams(TestGateway, "test");
        const isAckHandledManually = params.some((p) => p.source === "ack");
        expect(isAckHandledManually).toBe(false);
      });
    });

    describe("scanForServerHooks (getGatewayServerProperties & WsGatewayExplorer)", () => {
      const closers: Array<() => Promise<void>> = [];

      afterEach(async () => {
        while (closers.length > 0) {
          await closers.pop()!().catch(() => {});
        }
      });

      it("should return properties decorated with @WebSocketServer", () => {
        const servers = getGatewayServerProperties(TestGateway);

        expect(servers).toHaveLength(2);
        expect(servers).toEqual(["server", "anotherServer"]);
      });

      itAdapted(
        ["ADR-001"],
        "should discover gateways via WsGatewayExplorer and inject @WebSocketServer properties on bootstrap",
        async () => {
          @Module({
            imports: [WebSocketModule.forRoot()],
            providers: [TestGateway],
          })
          class ExplorerTestModule {}

          const moduleRef = await Test.createTestingModule({
            imports: [ExplorerTestModule],
          }).compile({ logger: false });
          const app = moduleRef.createNestApplication({ logger: false });
          closers.push(() => app.close());

          await app.init();

          const explorer = app.get(WsGatewayExplorer);
          const gateway = app.get(TestGateway);

          expect(explorer.adapter.getGateways()).toHaveLength(1);
          expect(explorer.adapter.getGateways()[0]?.path).toBe("/ws/explorer");
          expect(gateway.server).toBeDefined();
          expect(gateway.anotherServer).toBe(gateway.server);
          expect(gateway.server.path).toBe("/ws/explorer");
        },
      );
    });
  },
);
