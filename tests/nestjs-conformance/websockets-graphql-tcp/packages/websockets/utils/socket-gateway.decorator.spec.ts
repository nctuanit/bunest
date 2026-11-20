import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  Injectable,
  METADATA_KEYS,
  MetadataRegistry,
  Scope,
} from "../../../../../../packages/common/src";
import {
  WS_METADATA_KEYS,
  WebSocketGateway,
  type WebSocketGatewayOptions,
} from "../../../../../../packages/websockets/src";
import { describeConformance, itAdapted } from "../../../../_helpers/index";

describeConformance(
  "@WebSocketGateway",
  {
    upstreamPath:
      "packages/websockets/test/utils/socket-gateway.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Bunest multiplexes @WebSocketGateway() instances by HTTP upgrade path/options on Bun.serve rather than per-gateway TCP port numbers (ADR-001).",
  },
  () => {
    @WebSocketGateway("/ws-chat")
    class PathGateway {}

    it("should decorate gateway with path string shorthand and implicit @Injectable metadata", () => {
      const options = MetadataRegistry.get<WebSocketGatewayOptions>(
        WS_METADATA_KEYS.GATEWAY,
        PathGateway,
      );
      const injectable = MetadataRegistry.get<{ scope: Scope }>(
        METADATA_KEYS.INJECTABLE,
        PathGateway,
      );

      expect(options).toEqual({ path: "/ws-chat" });
      expect(injectable).toEqual({ scope: Scope.SINGLETON });
    });

    @WebSocketGateway()
    class DefaultGateway {}

    it("should decorate gateway with empty options object by default", () => {
      const options = MetadataRegistry.get<WebSocketGatewayOptions>(
        WS_METADATA_KEYS.GATEWAY,
        DefaultGateway,
      );

      expect(options).toEqual({});
      expect(MetadataRegistry.has(WS_METADATA_KEYS.GATEWAY, DefaultGateway)).toBe(
        true,
      );
    });

    @WebSocketGateway({ namespace: "/" })
    class NamespaceGateway {}

    it("should decorate gateway with expected namespace options", () => {
      const options = MetadataRegistry.get<WebSocketGatewayOptions>(
        WS_METADATA_KEYS.GATEWAY,
        NamespaceGateway,
      );

      expect(options).toEqual({ namespace: "/" });
    });

    itAdapted(
      ["ADR-001"],
      "should preserve all Bunest WebSocketGatewayOptions (authenticate, cors, limits, scope) without mutating caller options",
      () => {
        const authenticate = () => false;
        const rawOptions: WebSocketGatewayOptions = Object.freeze({
          path: "/secure",
          namespace: "/ns",
          cors: { origin: ["https://example.com"] },
          maxPayloadLength: 64 * 1024,
          idleTimeout: 30,
          perMessageDeflate: true,
          maxConcurrentMessages: 5,
          scope: Scope.REQUEST,
          authenticate,
        });

        @WebSocketGateway(rawOptions)
        class FullOptionsGateway {}

        const stored = MetadataRegistry.get<WebSocketGatewayOptions>(
          WS_METADATA_KEYS.GATEWAY,
          FullOptionsGateway,
        );
        const injectable = MetadataRegistry.get<{ scope: Scope }>(
          METADATA_KEYS.INJECTABLE,
          FullOptionsGateway,
        );

        expect(stored).toEqual(rawOptions);
        expect(stored).not.toBe(rawOptions);
        expect(stored?.authenticate).toBe(authenticate);
        expect(injectable).toEqual({ scope: Scope.REQUEST });
      },
    );

    it("should not overwrite existing @Injectable scope metadata when @WebSocketGateway runs after @Injectable", () => {
      @WebSocketGateway({ path: "/scoped" })
      @Injectable({ scope: Scope.REQUEST })
      class ExplicitlyScopedGateway {}

      const injectable = MetadataRegistry.get<{ scope: Scope }>(
        METADATA_KEYS.INJECTABLE,
        ExplicitlyScopedGateway,
      );
      expect(injectable).toEqual({ scope: Scope.REQUEST });
    });
  },
);
