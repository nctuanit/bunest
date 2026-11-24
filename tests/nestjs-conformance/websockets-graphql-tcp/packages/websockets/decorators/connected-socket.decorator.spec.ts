import { expect, it } from "bun:test";
import { MetadataRegistry } from "../../../../../../packages/core/src/common";
import {
  ConnectedSocket,
  WS_METADATA_KEYS,
  getGatewayMethodParams,
  type WsParamMetadata,
} from "../../../../../../packages/core/src/ws";
import { describeConformance } from "../../../../_helpers/index";

class ConnectedSocketTest {
  public test(@ConnectedSocket() _socket: unknown) {}
}

describeConformance(
  "@ConnectedSocket",
  {
    upstreamPath:
      "packages/websockets/test/decorators/connected-socket.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    it("should enhance class with expected request metadata", () => {
      const rawMetadata = MetadataRegistry.getOwn<readonly WsParamMetadata[]>(
        WS_METADATA_KEYS.MESSAGE_PARAMS,
        ConnectedSocketTest.prototype,
        "test",
      );

      expect(rawMetadata).toEqual([
        {
          index: 0,
          source: "client",
        },
      ]);

      const resolvedParams = getGatewayMethodParams(
        ConnectedSocketTest,
        "test",
      );
      expect(resolvedParams).toHaveLength(1);
      expect(resolvedParams[0]).toMatchObject({
        index: 0,
        source: "client",
      });
    });

    it("should reject using @ConnectedSocket on a constructor parameter", () => {
      expect(() => {
        class InvalidCtorSocket {
          constructor(@ConnectedSocket() _socket: unknown) {}
        }
        return InvalidCtorSocket;
      }).toThrow();
    });
  },
);
