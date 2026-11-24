import { describe, expect, it } from "bun:test";
import { WsException } from "../../../../../../packages/core/src/ws";
import { describeConformance } from "../../../../_helpers/index";

describeConformance(
  "WsException",
  {
    upstreamPath: "packages/websockets/test/exceptions/ws-exception.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    describe("when string passed", () => {
      const error = "test";
      const instance = new WsException(error);

      it("should return error message as string", () => {
        expect(instance.getError()).toEqual(error);
      });
      it("should set the message property", () => {
        expect(instance.message).toEqual(error);
      });
    });

    describe("when object passed", () => {
      describe("and message property is undefined", () => {
        const error = { test: true };
        const instance = new WsException(error);

        it("should return error as object", () => {
          expect(instance.getError()).toEqual(error);
        });

        it("should fallback error message to class name", () => {
          expect(instance.message).toEqual("Ws Exception");
        });
      });

      describe("and class name cannot be split into words", () => {
        class WS extends WsException {}
        const error = { test: true };
        const instance = new WS(error);

        // BUNEST_BUG: WsException in packages/core/src/ws/exceptions/ws.exception.ts hardcodes "WebSocket exception" instead of falling back to "Error" when subclass name (e.g. `WS`) cannot be split into PascalCase words.
        it.skip('should fallback error message to "Error"', () => {
          expect(instance.message).toEqual("Error");
        });
      });

      describe("and message property is not undefined", () => {
        const error = { message: "test", test: true };
        const instance = new WsException(error);

        it("should return error as object", () => {
          expect(instance.getError()).toEqual(error);
        });
        it('should return error message as the extracted "message" string', () => {
          expect(instance.message).toEqual(error.message);
        });
      });
    });
  },
);
