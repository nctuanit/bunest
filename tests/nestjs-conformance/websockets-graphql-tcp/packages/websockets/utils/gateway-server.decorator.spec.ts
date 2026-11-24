import { expect, it } from "bun:test";
import { MetadataRegistry } from "../../../../../../packages/core/src/common";
import {
  WS_METADATA_KEYS,
  WebSocketServer,
  getGatewayServerProperties,
} from "../../../../../../packages/core/src/ws";
import { describeConformance } from "../../../../_helpers/index";

describeConformance(
  "@WebSocketServer",
  {
    upstreamPath:
      "packages/websockets/test/utils/gateway-server.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    class TestGateway {
      @WebSocketServer()
      public server: unknown;
    }

    it("should decorate server property with expected metadata", () => {
      const props = MetadataRegistry.getOwn<readonly (string | symbol)[]>(
        WS_METADATA_KEYS.WEBSOCKET_SERVER_PROPS,
        TestGateway,
      );
      expect(props).toEqual(["server"]);
      expect(getGatewayServerProperties(TestGateway)).toEqual(["server"]);
    });

    it("should preserve @WebSocketServer properties across inheritance without mutating parent", () => {
      class ChildGateway extends TestGateway {
        @WebSocketServer()
        public secondaryServer: unknown;
      }

      expect(getGatewayServerProperties(TestGateway)).toEqual(["server"]);
      expect(getGatewayServerProperties(ChildGateway)).toEqual([
        "server",
        "secondaryServer",
      ]);
    });

    // BUNEST_BUG: @WebSocketServer() in packages/core/src/ws/decorators/ws.decorators.ts does not initialize the decorated property value to `null` by default (unlike NestJS `target[propertyKey] = null`), and when applied to a `static` property it attaches metadata to `target.constructor` (`Function`) instead of the class itself.
    it.skip("should set static server property metadata on the class and initialize value to null by default", () => {
      class StaticTestGateway {
        @WebSocketServer()
        static server: unknown;
      }

      expect(getGatewayServerProperties(StaticTestGateway)).toContain("server");
      expect(StaticTestGateway.server).toEqual(null);
    });
  },
);
