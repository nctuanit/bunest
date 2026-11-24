import { expect, it } from "bun:test";
import { MetadataRegistry } from "../../../../../../packages/core/src/common";
import {
  SubscribeMessage,
  WS_METADATA_KEYS,
  getGatewayMessageHandlers,
  type WsMessageHandlerMetadata,
} from "../../../../../../packages/core/src/ws";
import { describeConformance } from "../../../../_helpers/index";

describeConformance(
  "@SubscribeMessage",
  {
    upstreamPath:
      "packages/websockets/test/utils/subscribe-message.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    class TestGateway {
      @SubscribeMessage("filter")
      public fn() {}
    }

    it("should decorate method with expected message handler metadata", () => {
      const ownHandlers = MetadataRegistry.getOwn<
        readonly WsMessageHandlerMetadata[]
      >(WS_METADATA_KEYS.MESSAGE_HANDLERS, TestGateway);

      expect(ownHandlers).toEqual([
        {
          event: "filter",
          handlerKey: "fn",
        },
      ]);
      expect(getGatewayMessageHandlers(TestGateway)).toEqual([
        {
          event: "filter",
          handlerKey: "fn",
        },
      ]);
    });

    it("should isolate subclass @SubscribeMessage metadata via copy-on-write", () => {
      class ChildGateway extends TestGateway {
        @SubscribeMessage("extra")
        public extraFn() {}
      }

      expect(getGatewayMessageHandlers(TestGateway)).toEqual([
        { event: "filter", handlerKey: "fn" },
      ]);
      expect(getGatewayMessageHandlers(ChildGateway)).toEqual([
        { event: "filter", handlerKey: "fn" },
        { event: "extra", handlerKey: "extraFn" },
      ]);
    });
  },
);
