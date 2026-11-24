import { describe, expect, it } from "bun:test";
import {
  Controller,
  MetadataRegistry,
  ParseIntPipe,
  type PipeTransform,
  type StandardSchemaV1,
} from "../../../../../../packages/core/src/common";
import {
  Ctx,
  InMemoryBroker,
  InMemoryClientProxy,
  InMemoryServer,
  MessagePattern,
  MicroserviceModule,
  Payload,
  RPC_PARAM_METADATA,
  type RpcContext,
  type RpcParamMetadata,
} from "../../../../../../packages/microservices/src";
import { Test } from "../../../../../../packages/testing/src";
import { ValidationPipe } from "../../../../../../packages/validation/src";
import { describeConformance } from "../../../../_helpers";

class MessagePayloadTest {
  public test(@Payload(ValidationPipe) _payload: unknown) {}

  public withProperty(@Payload("userId", ParseIntPipe) _userId: number) {}

  public withMultiplePipes(
    @Payload(ParseIntPipe, ValidationPipe) _payload: unknown,
  ) {}

  public bare(@Payload() _payload: unknown) {}
}

describeConformance(
  "@Payload",
  {
    upstreamPath:
      "packages/microservices/test/decorators/payload.decorator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-004", "ADR-005"],
    notes:
      "Verifies Bunest @Payload() parameter metadata, pipe registration, property extraction, subclass override isolation, and Standard Schema options parity.",
  },
  () => {
    it("should enhance class method with expected payload parameter metadata", () => {
      const argsMetadata = MetadataRegistry.getOwn<readonly RpcParamMetadata[]>(
        RPC_PARAM_METADATA,
        MessagePayloadTest.prototype,
        "test",
      );

      expect(argsMetadata).toEqual([
        {
          index: 0,
          kind: "payload",
          property: undefined,
          pipes: [ValidationPipe],
        },
      ]);
    });

    it("should store property name and pipes when @Payload(property, ...pipes) is used", () => {
      const argsMetadata = MetadataRegistry.getOwn<readonly RpcParamMetadata[]>(
        RPC_PARAM_METADATA,
        MessagePayloadTest.prototype,
        "withProperty",
      );

      expect(argsMetadata).toEqual([
        {
          index: 0,
          kind: "payload",
          property: "userId",
          pipes: [ParseIntPipe],
        },
      ]);
    });

    it("should preserve pipe order when multiple pipes are passed without a property key", () => {
      const argsMetadata = MetadataRegistry.getOwn<readonly RpcParamMetadata[]>(
        RPC_PARAM_METADATA,
        MessagePayloadTest.prototype,
        "withMultiplePipes",
      );

      expect(argsMetadata).toEqual([
        {
          index: 0,
          kind: "payload",
          property: undefined,
          pipes: [ParseIntPipe, ValidationPipe],
        },
      ]);
    });

    it("should record empty pipes and undefined property when @Payload() has no args", () => {
      const argsMetadata = MetadataRegistry.getOwn<readonly RpcParamMetadata[]>(
        RPC_PARAM_METADATA,
        MessagePayloadTest.prototype,
        "bare",
      );

      expect(argsMetadata).toEqual([
        {
          index: 0,
          kind: "payload",
          property: undefined,
          pipes: [],
        },
      ]);
    });

    it("should throw when applied to a constructor parameter", () => {
      expect(() => {
        const decorator = Payload();
        class InvalidTarget {}
        decorator(InvalidTarget, undefined, 0);
      }).toThrow("@Payload() can only be used on method parameters.");
    });

    describe("when an overriding method moves it to another argument", () => {
      it("should keep one param per argument and isolate parent metadata", () => {
        class Parent {
          public test(@Payload() _payload: unknown, @Ctx() _ctx: RpcContext) {}
        }
        class Child extends Parent {
          public override test(
            @Ctx() _ctx: RpcContext,
            @Payload() _payload: unknown,
          ) {}
        }

        const parentMeta = MetadataRegistry.getOwn<readonly RpcParamMetadata[]>(
          RPC_PARAM_METADATA,
          Parent.prototype,
          "test",
        );
        const childMeta = MetadataRegistry.getOwn<readonly RpcParamMetadata[]>(
          RPC_PARAM_METADATA,
          Child.prototype,
          "test",
        );

        expect(parentMeta).toEqual([
          { index: 0, kind: "payload", property: undefined, pipes: [] },
          { index: 1, kind: "ctx" },
        ]);
        expect(childMeta).toEqual([
          { index: 0, kind: "ctx" },
          { index: 1, kind: "payload", property: undefined, pipes: [] },
        ]);
      });
    });

    it("should extract property and execute param pipes at runtime via MicroserviceHost", async () => {
      const broker = new InMemoryBroker();
      const server = new InMemoryServer({
        channel: "payload-dec-test",
        broker,
      });

      class UpperPipe implements PipeTransform<unknown, unknown> {
        transform(value: unknown) {
          return typeof value === "string" ? value.toUpperCase() : value;
        }
      }

      @Controller()
      class PayloadController {
        @MessagePattern("greet")
        greet(@Payload("name", new UpperPipe()) name: string) {
          return `hi ${name}`;
        }

        @MessagePattern("whole")
        whole(@Payload() payload: unknown) {
          return payload;
        }
      }

      const mod = await Test.createTestingModule({
        imports: [MicroserviceModule.forRoot({ server })],
        controllers: [PayloadController],
      }).compile();
      await mod.init();

      const client = new InMemoryClientProxy({
        channel: "payload-dec-test",
        broker,
      });

      try {
        expect(await client.send("greet", { name: "bunest" })).toBe(
          "hi BUNEST",
        );
        expect(await client.send("whole", { a: 1, b: [2, 3] })).toEqual({
          a: 1,
          b: [2, 3],
        });
      } finally {
        await client.close();
        await mod.close();
      }
    });

    describe("@Payload with ParameterDecoratorOptions", () => {
      const mockSchema: StandardSchemaV1<unknown, unknown> = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (v: unknown) => ({ value: v }),
        },
      };

      // BUNEST_BUG: @Payload() in packages/microservices/src/decorators.ts does not support ParameterDecoratorOptions (`{ schema, pipes }`), storing the options object inside `pipes` instead of extracting `schema`.
      it.skip("should enhance param with schema when options passed as the only argument", () => {
        const dynamicPayload = Payload as (
          ...args: unknown[]
        ) => ParameterDecorator;

        class TestSchemaOnly {
          public test(
            @dynamicPayload({ schema: mockSchema }) _payload: unknown,
          ) {}
        }

        const metadata = MetadataRegistry.getOwn<
          readonly (RpcParamMetadata & { schema?: StandardSchemaV1 })[]
        >(RPC_PARAM_METADATA, TestSchemaOnly.prototype, "test");
        expect(metadata?.[0]).toEqual({
          index: 0,
          kind: "payload",
          property: undefined,
          pipes: [],
          schema: mockSchema,
        });
      });

      // BUNEST_BUG: @Payload() in packages/microservices/src/decorators.ts does not support ParameterDecoratorOptions (`{ schema, pipes }`).
      it.skip("should enhance param with pipes when options with pipes passed as the only argument", () => {
        const dynamicPayload = Payload as (
          ...args: unknown[]
        ) => ParameterDecorator;

        class TestSchemaWithPipes {
          public test(
            @dynamicPayload({ schema: mockSchema, pipes: [ValidationPipe] })
            _payload: unknown,
          ) {}
        }

        const metadata = MetadataRegistry.getOwn<
          readonly (RpcParamMetadata & { schema?: StandardSchemaV1 })[]
        >(RPC_PARAM_METADATA, TestSchemaWithPipes.prototype, "test");
        expect(metadata?.[0]).toEqual({
          index: 0,
          kind: "payload",
          property: undefined,
          pipes: [ValidationPipe],
          schema: mockSchema,
        });
      });

      // BUNEST_BUG: @Payload() in packages/microservices/src/decorators.ts does not support ParameterDecoratorOptions as the second argument with a property key (`@Payload("data", { schema })`).
      it.skip("should enhance param with schema when options passed as second argument with property", () => {
        const dynamicPayload = Payload as (
          ...args: unknown[]
        ) => ParameterDecorator;

        class TestPropWithSchema {
          public test(
            @dynamicPayload("data", { schema: mockSchema }) _data: unknown,
          ) {}
        }

        const metadata = MetadataRegistry.getOwn<
          readonly (RpcParamMetadata & { schema?: StandardSchemaV1 })[]
        >(RPC_PARAM_METADATA, TestPropWithSchema.prototype, "test");
        expect(metadata?.[0]).toEqual({
          index: 0,
          kind: "payload",
          property: "data",
          pipes: [],
          schema: mockSchema,
        });
      });

      it("should not confuse a pipe instance with options", () => {
        const pipeInstance = new ValidationPipe();

        class TestPipeInstance {
          public test(@Payload(pipeInstance) _payload: unknown) {}
        }

        const metadata = MetadataRegistry.getOwn<
          readonly (RpcParamMetadata & { schema?: unknown })[]
        >(RPC_PARAM_METADATA, TestPipeInstance.prototype, "test");
        expect(metadata).toHaveLength(1);
        expect(metadata?.[0]?.property).toBeUndefined();
        expect(metadata?.[0]?.pipes).toHaveLength(1);
        expect(metadata?.[0]?.pipes?.[0]).toBe(pipeInstance);
        expect(metadata?.[0]?.schema).toBeUndefined();
      });
    });
  },
);
