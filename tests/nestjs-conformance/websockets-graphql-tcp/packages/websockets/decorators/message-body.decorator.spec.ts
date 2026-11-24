import { describe, expect, it } from "bun:test";
import { MetadataRegistry } from "../../../../../../packages/core/src/common";
import { ValidationPipe } from "../../../../../../packages/validation/src";
import {
  ConnectedSocket,
  MessageBody,
  WS_METADATA_KEYS,
  getGatewayMethodParams,
  type WsParamMetadata,
} from "../../../../../../packages/core/src/ws";
import { describeConformance } from "../../../../_helpers/index";

class MessagePayloadTest {
  public test(@MessageBody(ValidationPipe) _payload: unknown) {}
}

describeConformance(
  "@MessageBody",
  {
    upstreamPath:
      "packages/websockets/test/decorators/message-body.decorator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts metadata assertions to Bunest WS_METADATA_KEYS.MESSAGE_PARAMS and getGatewayMethodParams(); documents missing Standard Schema ParameterDecoratorOptions support.",
  },
  () => {
    describe("@MessagePayload", () => {
      it("should enhance class with expected request metadata", () => {
        const rawMetadata = MetadataRegistry.getOwn<readonly WsParamMetadata[]>(
          WS_METADATA_KEYS.MESSAGE_PARAMS,
          MessagePayloadTest.prototype,
          "test",
        );

        expect(rawMetadata).toEqual([
          {
            index: 0,
            source: "body",
            key: undefined,
            pipes: [ValidationPipe],
          },
        ]);

        const resolved = getGatewayMethodParams(MessagePayloadTest, "test");
        expect(resolved[0]).toMatchObject({
          index: 0,
          source: "body",
          key: undefined,
          pipes: [ValidationPipe],
        });
      });

      it("should extract property key and pipes when key string is provided", () => {
        class KeyedPayloadTest {
          public test(@MessageBody("data", ValidationPipe) _data: unknown) {}
        }

        const resolved = getGatewayMethodParams(KeyedPayloadTest, "test");
        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
          index: 0,
          source: "body",
          key: "data",
          pipes: [ValidationPipe],
        });
      });

      describe("when an overriding method moves it to another argument", () => {
        it("should keep one param per argument", () => {
          class Parent {
            public test(
              @MessageBody() _body: unknown,
              @ConnectedSocket() _socket: unknown,
            ) {}
          }
          class Test extends Parent {
            public override test(
              @ConnectedSocket() _socket: unknown,
              @MessageBody() _body: unknown,
            ) {}
          }

          const childParams = getGatewayMethodParams(Test, "test");
          expect(childParams.map((p) => `${p.source}:${p.index}`)).toEqual([
            "client:0",
            "body:1",
          ]);

          // Parent metadata remains untouched (copy-on-write / per-prototype isolation)
          const parentParams = getGatewayMethodParams(Parent, "test");
          expect(parentParams.map((p) => `${p.source}:${p.index}`)).toEqual([
            "body:0",
            "client:1",
          ]);
        });
      });
    });

    describe("@MessageBody with ParameterDecoratorOptions", () => {
      const mockSchema = {
        "~standard": {
          version: 1 as const,
          vendor: "test",
          validate: (v: unknown) => ({ value: v }),
        },
      };

      it("should enhance param with schema when options passed as the only argument", () => {
        const messageBodyAny = MessageBody as (
          ...args: unknown[]
        ) => ParameterDecorator;
        class Test {
          public test(@messageBodyAny({ schema: mockSchema }) _body: unknown) {}
        }
        const params = getGatewayMethodParams(Test, "test") as Array<
          WsParamMetadata & { schema?: unknown }
        >;
        expect(params[0]).toMatchObject({
          index: 0,
          source: "body",
          key: undefined,
          schema: mockSchema,
        });
        expect(params[0]?.pipes ?? []).toEqual([]);
      });

      it("should enhance param with pipes when options with pipes passed as the only argument", () => {
        const messageBodyAny = MessageBody as (
          ...args: unknown[]
        ) => ParameterDecorator;
        class Test {
          public test(
            @messageBodyAny({ schema: mockSchema, pipes: [ValidationPipe] })
            _body: unknown,
          ) {}
        }
        const params = getGatewayMethodParams(Test, "test") as Array<
          WsParamMetadata & { schema?: unknown }
        >;
        expect(params[0]).toMatchObject({
          index: 0,
          source: "body",
          key: undefined,
          pipes: [ValidationPipe],
          schema: mockSchema,
        });
      });

      it("should enhance param with schema when options passed as second argument with property", () => {
        const messageBodyAny = MessageBody as (
          ...args: unknown[]
        ) => ParameterDecorator;
        class Test {
          public test(
            @messageBodyAny("data", { schema: mockSchema }) _data: unknown,
          ) {}
        }
        const params = getGatewayMethodParams(Test, "test") as Array<
          WsParamMetadata & { schema?: unknown }
        >;
        expect(params[0]).toMatchObject({
          index: 0,
          source: "body",
          key: "data",
          schema: mockSchema,
        });
        expect(params[0]?.pipes ?? []).toEqual([]);
      });

      it("should not confuse a pipe instance with options", () => {
        const pipe = new ValidationPipe();
        class Test {
          public test(@MessageBody(pipe) _body: unknown) {}
        }
        const params = getGatewayMethodParams(Test, "test") as Array<
          WsParamMetadata & { schema?: unknown }
        >;
        expect(params).toHaveLength(1);
        expect(params[0]?.key).toBeUndefined();
        expect(params[0]?.pipes).toHaveLength(1);
        expect(params[0]?.pipes?.[0]).toBe(pipe);
        expect(params[0]?.schema).toBeUndefined();
      });
    });
  },
);
