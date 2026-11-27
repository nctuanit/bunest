import { describe, expect, it } from "bun:test";
import {
  APP_GUARD,
  BunestFactory,
  Catch,
  Controller,
  Injectable,
  MODULE_FILTER,
  MODULE_GUARD,
  MODULE_INTERCEPTOR,
  MODULE_PIPE,
  Module,
  UseGuards,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type PipeTransform,
} from "@bunest/core";
import {
  InMemoryBroker,
  InMemoryClientProxy,
  InMemoryServer,
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  Payload,
  RpcException,
} from "../src/index";

describe("Wave 2: MicroserviceHost Shallow MODULE_* Enhancers", () => {
  it("applies MODULE_* enhancers only to the owning module's RPC handlers in exact order", async () => {
    const order: string[] = [];

    @Injectable()
    class GlobalRpcGuard implements CanActivate {
      canActivate(): boolean {
        order.push("guard:app");
        return true;
      }
    }

    @Injectable()
    class ModuleARpcGuard implements CanActivate {
      canActivate(): boolean {
        order.push("guard:modA");
        return true;
      }
    }

    @Injectable()
    class ClassRpcGuard implements CanActivate {
      canActivate(): boolean {
        order.push("guard:class");
        return true;
      }
    }

    @Injectable()
    class ModuleARpcPipe implements PipeTransform {
      transform(value: unknown): unknown {
        order.push("pipe:modA");
        return typeof value === "string" ? `modA:${value}` : value;
      }
    }

    @Injectable()
    class ModuleARpcInterceptor implements BunestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        order.push("int:in:modA");
        const res = await next.handle();
        order.push("int:out:modA");
        return res;
      }
    }

    @Catch(RpcException)
    class ModuleARpcFilter implements ExceptionFilter {
      catch(exception: RpcException, _host: ArgumentsHost) {
        order.push("filter:modA");
        return { caughtBy: "modA", error: exception.getError() };
      }
    }

    @Controller()
    @UseGuards(ClassRpcGuard)
    class ModuleAController {
      @MessagePattern("modA.echo")
      echo(@Payload() data: string) {
        order.push("handler:modA");
        return data;
      }

      @MessagePattern("modA.fail")
      fail() {
        throw new RpcException("modA-boom");
      }
    }

    @Module({
      controllers: [ModuleAController],
      providers: [
        { provide: MODULE_GUARD, useClass: ModuleARpcGuard },
        { provide: MODULE_PIPE, useClass: ModuleARpcPipe },
        { provide: MODULE_INTERCEPTOR, useClass: ModuleARpcInterceptor },
        { provide: MODULE_FILTER, useClass: ModuleARpcFilter },
      ],
    })
    class ModuleA {}

    @Controller()
    class ModuleBController {
      @MessagePattern("modB.echo")
      echo(@Payload() data: string) {
        order.push("handler:modB");
        return data;
      }
    }

    const broker = new InMemoryBroker();
    const channel = "wave2-module-enhancers";

    @Module({
      imports: [
        MicroserviceModule.forRoot({
          server: new InMemoryServer({ broker, channel }),
        }),
        ModuleA,
      ],
      controllers: [ModuleBController],
      providers: [{ provide: APP_GUARD, useClass: GlobalRpcGuard }],
    })
    class RootRpcModule {}

    const ctx = await BunestFactory.createApplicationContext(RootRpcModule, {
      logger: false,
    });
    const host = ctx.get(MicroserviceHost);
    expect(host.getTransportServer()).toBeInstanceOf(InMemoryServer);
    const client = new InMemoryClientProxy({ broker, channel });
    await client.connect();

    try {
      order.length = 0;
      const resA = await client.send("modA.echo", "hi");
      expect(resA).toBe("modA:hi");
      expect(order).toEqual([
        "guard:app",
        "guard:modA",
        "guard:class",
        "int:in:modA",
        "pipe:modA",
        "handler:modA",
        "int:out:modA",
      ]);

      order.length = 0;
      const failA = await client.send("modA.fail", {});
      expect(failA).toEqual({ caughtBy: "modA", error: "modA-boom" });
      expect(order).toContain("filter:modA");

      // ModuleB (importing ModuleA) must NOT receive ModuleA's MODULE_* enhancers
      order.length = 0;
      const resB = await client.send("modB.echo", "hi");
      expect(resB).toBe("hi");
      expect(order).toEqual(["guard:app", "handler:modB"]);
    } finally {
      await client.close();
      await ctx.close();
    }
  });
});
