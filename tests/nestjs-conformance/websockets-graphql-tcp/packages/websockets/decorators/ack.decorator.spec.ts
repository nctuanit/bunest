import "reflect-metadata";
import { expect, it } from "bun:test";
import { MetadataRegistry } from "../../../../../../packages/common/src";
import {
  Ack,
  WS_METADATA_KEYS,
  getGatewayMethodParams,
  type WsParamMetadata,
} from "../../../../../../packages/websockets/src";
import { describeConformance } from "../../../../_helpers/index";

class AckTest {
  public test(@Ack() _ack: Function) {}
}

describeConformance(
  "@Ack",
  {
    upstreamPath: "packages/websockets/test/decorators/ack.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    it("should enhance class with expected request metadata", () => {
      const rawMetadata = MetadataRegistry.getOwn<readonly WsParamMetadata[]>(
        WS_METADATA_KEYS.MESSAGE_PARAMS,
        AckTest.prototype,
        "test",
      );

      expect(rawMetadata).toEqual([
        {
          index: 0,
          source: "ack",
        },
      ]);

      const resolvedParams = getGatewayMethodParams(AckTest, "test");
      expect(resolvedParams).toEqual([
        {
          index: 0,
          source: "ack",
          metatype: Function,
        },
      ]);
    });

    it("should reject using @Ack on a constructor parameter", () => {
      expect(() => {
        class InvalidCtorAck {
          constructor(@Ack() _ack: Function) {}
        }
        return InvalidCtorAck;
      }).toThrow();
    });
  },
);
