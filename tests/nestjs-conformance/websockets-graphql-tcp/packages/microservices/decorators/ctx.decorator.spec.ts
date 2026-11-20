import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Controller, MetadataRegistry } from "../../../../../../packages/common/src";
import {
  Ctx,
  InMemoryBroker,
  InMemoryClientProxy,
  InMemoryServer,
  MessagePattern,
  MicroserviceModule,
  Payload,
  RPC_PARAM_METADATA,
  Transport,
  type RpcContext,
  type RpcParamMetadata,
} from "../../../../../../packages/microservices/src";
import { Test } from "../../../../../../packages/testing/src";
import { describeConformance } from "../../../../_helpers";

class CtxTest {
  public test(@Ctx() _ctx: RpcContext) {}

  public withPayload(
    @Payload() _payload: unknown,
    @Ctx() _ctx: RpcContext,
  ) {}

  public ctxFirst(@Ctx() _ctx: RpcContext, @Payload("id") _id: string) {}
}

describeConformance(
  "@Ctx",
  {
    upstreamPath: "packages/microservices/test/decorators/ctx.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Verifies Bunest @Ctx() parameter metadata storage under RPC_PARAM_METADATA and runtime RpcContext injection.",
  },
  () => {
    it("should enhance class method with expected RPC context parameter metadata", () => {
      const argsMetadata = MetadataRegistry.getOwn<readonly RpcParamMetadata[]>(
        RPC_PARAM_METADATA,
        CtxTest.prototype,
        "test",
      );

      expect(argsMetadata).toEqual([
        {
          index: 0,
          kind: "ctx",
        },
      ]);
    });

    it("should record parameter index accurately when combined with @Payload()", () => {
      const secondArgMeta = MetadataRegistry.getOwn<readonly RpcParamMetadata[]>(
        RPC_PARAM_METADATA,
        CtxTest.prototype,
        "withPayload",
      );
      expect(secondArgMeta).toEqual([
        {
          index: 0,
          kind: "payload",
          property: undefined,
          pipes: [],
        },
        {
          index: 1,
          kind: "ctx",
        },
      ]);

      const firstArgMeta = MetadataRegistry.getOwn<readonly RpcParamMetadata[]>(
        RPC_PARAM_METADATA,
        CtxTest.prototype,
        "ctxFirst",
      );
      expect(firstArgMeta).toEqual([
        {
          index: 0,
          kind: "ctx",
        },
        {
          index: 1,
          kind: "payload",
          property: "id",
          pipes: [],
        },
      ]);
    });

    it("should throw when applied to a constructor parameter", () => {
      expect(() => {
        const decorator = Ctx();
        class InvalidCtorTarget {}
        decorator(InvalidCtorTarget, undefined, 0);
      }).toThrow("@Ctx() can only be used on method parameters.");
    });

    it("should inject the active RpcContext at runtime via MicroserviceHost", async () => {
      const broker = new InMemoryBroker();
      const server = new InMemoryServer({ channel: "ctx-decorator-test", broker });

      @Controller()
      class CtxController {
        @MessagePattern("ctx.inspect")
        inspect(@Ctx() ctx: RpcContext, @Payload("val") val: number) {
          return {
            transport: ctx.transport,
            pattern: ctx.pattern,
            channel: ctx.metadata?.channel,
            val,
          };
        }
      }

      const mod = await Test.createTestingModule({
        imports: [MicroserviceModule.forRoot({ server })],
        controllers: [CtxController],
      }).compile();
      await mod.init();

      const client = new InMemoryClientProxy({
        channel: "ctx-decorator-test",
        broker,
      });

      try {
        const result = await client.send<{
          transport: Transport;
          pattern: string;
          channel: string;
          val: number;
        }>("ctx.inspect", { val: 42 });

        expect(result).toEqual({
          transport: Transport.IN_MEMORY,
          pattern: "ctx.inspect",
          channel: "ctx-decorator-test",
          val: 42,
        });
      } finally {
        await client.close();
        await mod.close();
      }
    });
  },
);
