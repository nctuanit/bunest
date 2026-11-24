import { describe, expect, it } from "bun:test";
import {
  Injectable,
  MetadataRegistry,
  Module,
  ParseIntPipe,
  Scope,
  UseGuards,
  UseInterceptors,
  UsePipes,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type PipeTransform,
} from "@bunest/core";
import { BunestFactory } from "@bunest/core";
import {
  EVENT_LISTENER_METADATA,
  EmitEvent,
  EventEmitter2,
  EventEmitterModule,
  EventPayload,
  OnEvent,
  getOnEventMetadata,
  type OnEventMetadata,
} from "../../src/events";

describe("@bunest/events Phase 1 fixes (C1, C2) & declarative decorators (@EmitEvent, @EventPayload)", () => {
  it("Fix C1: preserves top-to-bottom order on stacked @OnEvent() in both ON_EVENT_METADATA and EVENT_LISTENER_METADATA", () => {
    class StackedListener {
      @OnEvent("order.first")
      @OnEvent("order.second")
      @OnEvent("order.third")
      handleOrder() {}

      @OnEvent("user.created")
      handleUser() {}
    }

    const classMeta = getOnEventMetadata(StackedListener);
    expect(classMeta.map((m) => m.event)).toEqual([
      "order.first",
      "order.second",
      "order.third",
      "user.created",
    ]);

    const methodMeta = MetadataRegistry.getOwn<OnEventMetadata[]>(
      EVENT_LISTENER_METADATA,
      StackedListener.prototype.handleOrder,
    );
    expect(methodMeta?.map((m) => m.event)).toEqual([
      "order.first",
      "order.second",
      "order.third",
    ]);
  });

  it("Fix C2: deduplicates request-scoped listeners by token identity, never colliding on anonymous classes, same-named classes, or distinct Symbols", async () => {
    const fired: string[] = [];

    const makeAnonListener = (tag: string) => {
      @Injectable({ scope: Scope.REQUEST })
      class SameNameListener {
        @OnEvent("dedup.test")
        handle() {
          fired.push(tag);
        }
      }
      return SameNameListener;
    };

    const ListenerA = makeAnonListener("same-name-A");
    const ListenerB = makeAnonListener("same-name-B");
    expect(ListenerA.name).toBe(ListenerB.name);

    const SYM_1 = Symbol("scoped-listener");
    const SYM_2 = Symbol("scoped-listener");

    @Injectable({ scope: Scope.REQUEST })
    class SymListener1 {
      @OnEvent("dedup.test")
      handle() {
        fired.push("sym-1");
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class SymListener2 {
      @OnEvent("dedup.test")
      handle() {
        fired.push("sym-2");
      }
    }

    @Module({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        ListenerA,
        ListenerB,
        { provide: SYM_1, useClass: SymListener1 },
        { provide: SYM_2, useClass: SymListener2 },
      ],
    })
    class DedupMod {}

    const ctx = await BunestFactory.createApplicationContext(DedupMod, {
      logger: false,
    });
    try {
      const emitter = ctx.get(EventEmitter2);
      await emitter.emitAsync("dedup.test", { ok: true });
      expect(fired.sort()).toEqual([
        "same-name-A",
        "same-name-B",
        "sym-1",
        "sym-2",
      ]);
    } finally {
      await ctx.close();
    }
  });

  it("supports @EmitEvent() with static/dynamic event names, async emitAsync, custom payload, when predicate, and error safety", async () => {
    const received: Array<{ event: string | symbol; payload: unknown }> = [];
    const SYM_EVENT = Symbol("order.symbol");

    @Injectable()
    class OrderEventsListener {
      @OnEvent("order.created")
      onCreated(payload: unknown) {
        received.push({ event: "order.created", payload });
      }

      @OnEvent("order.shipped")
      async onShipped(payload: unknown) {
        await Bun.sleep(5);
        received.push({ event: "order.shipped", payload });
      }

      @OnEvent(SYM_EVENT)
      onSymbol(payload: unknown) {
        received.push({ event: SYM_EVENT, payload });
      }

      @OnEvent("order.status.paid")
      onDynamic(payload: unknown) {
        received.push({ event: "order.status.paid", payload });
      }
    }

    @Injectable()
    class OrderService {
      @EmitEvent("order.created")
      createOrder(id: string) {
        return { id, status: "created" };
      }

      @EmitEvent("order.shipped", {
        async: true,
        payload: (result, args) => ({
          order: result,
          carrier: args[1],
        }),
      })
      async shipOrder(id: string, carrier: string) {
        await Bun.sleep(1);
        return { id, status: "shipped", carrier };
      }

      @EmitEvent(
        (_args, result) =>
          `order.status.${(result as { status: string }).status}`,
        {
          when: (result) => (result as { notify: boolean }).notify === true,
        },
      )
      updateStatus(status: string, notify: boolean) {
        return { status, notify };
      }

      @EmitEvent(SYM_EVENT)
      emitSymbol(val: number) {
        return val * 2;
      }

      @EmitEvent("order.created")
      failingCreate() {
        throw new Error("db-error");
      }
    }

    @Module({
      imports: [EventEmitterModule.forRoot()],
      providers: [OrderEventsListener, OrderService],
    })
    class EmitMod {}

    const ctx = await BunestFactory.createApplicationContext(EmitMod, {
      logger: false,
    });
    try {
      const orders = ctx.get(OrderService);

      // Sync emit
      const created = orders.createOrder("o-1");
      expect(created).toEqual({ id: "o-1", status: "created" });
      expect(received).toEqual([
        { event: "order.created", payload: { id: "o-1", status: "created" } },
      ]);

      // Async emit awaits async listeners before resolving
      received.length = 0;
      const shipped = await orders.shipOrder("o-2", "DHL");
      expect(shipped).toEqual({ id: "o-2", status: "shipped", carrier: "DHL" });
      expect(received).toEqual([
        {
          event: "order.shipped",
          payload: {
            order: { id: "o-2", status: "shipped", carrier: "DHL" },
            carrier: "DHL",
          },
        },
      ]);

      // Conditional `when` + dynamic event name
      received.length = 0;
      orders.updateStatus("paid", false);
      expect(received).toEqual([]);
      orders.updateStatus("paid", true);
      expect(received).toEqual([
        {
          event: "order.status.paid",
          payload: { status: "paid", notify: true },
        },
      ]);

      // Symbol event
      received.length = 0;
      expect(orders.emitSymbol(21)).toBe(42);
      expect(received).toEqual([{ event: SYM_EVENT, payload: 42 }]);

      // Throwing method MUST NOT emit event
      received.length = 0;
      expect(() => orders.failingCreate()).toThrow("db-error");
      expect(received).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it("supports @EventPayload() with property extraction, DI pipes, guards, and interceptors on @OnEvent() listeners", async () => {
    const log: string[] = [];

    @Injectable()
    class MultiplierService {
      readonly factor = 10;
    }

    @Injectable()
    class DiMultiplyPipe implements PipeTransform<number, number> {
      constructor(private readonly mult: MultiplierService) {}

      transform(value: number): number {
        return value * this.mult.factor;
      }
    }

    @Injectable()
    class AdminOnlyEventGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        const payload = ctx.switchToRpc().getData<{ role?: string }>();
        log.push(`guard:${payload?.role ?? "none"}`);
        return payload?.role === "admin";
      }
    }

    @Injectable()
    class AuditEventInterceptor implements BunestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        log.push("ic:before");
        const res = await next.handle();
        log.push("ic:after");
        return res;
      }
    }

    @Injectable()
    class EnhancedEventListener {
      @OnEvent("invoice.paid")
      @UseGuards(AdminOnlyEventGuard)
      @UseInterceptors(AuditEventInterceptor)
      handleInvoice(
        @EventPayload("amount", ParseIntPipe, DiMultiplyPipe)
        scaledAmount: number,
        @EventPayload("invoiceId") invoiceId: string,
      ) {
        log.push(`handled:${invoiceId}:${scaledAmount}`);
        return { invoiceId, scaledAmount };
      }

      @OnEvent("raw.text")
      @UsePipes({
        transform: (v: unknown) =>
          typeof v === "string" ? v.trim().toUpperCase() : v,
      })
      handleText(@EventPayload() text: string) {
        return `text:${text}`;
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class ScopedPayloadListener {
      @OnEvent("scoped.extract")
      handleScoped(@EventPayload("code", ParseIntPipe) code: number) {
        return code + 1;
      }
    }

    @Module({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        MultiplierService,
        DiMultiplyPipe,
        AdminOnlyEventGuard,
        AuditEventInterceptor,
        EnhancedEventListener,
        ScopedPayloadListener,
      ],
    })
    class PayloadMod {}

    const ctx = await BunestFactory.createApplicationContext(PayloadMod, {
      logger: false,
    });
    try {
      const emitter = ctx.get(EventEmitter2);

      // Guard allows admin + ParseIntPipe + DI DiMultiplyPipe + Interceptor
      log.length = 0;
      const ok = await emitter.emitAsync("invoice.paid", {
        role: "admin",
        invoiceId: "inv-7",
        amount: "25",
      });
      expect(ok).toEqual([{ invoiceId: "inv-7", scaledAmount: 250 }]);
      expect(log).toEqual([
        "guard:admin",
        "ic:before",
        "handled:inv-7:250",
        "ic:after",
      ]);

      // Guard denies non-admin
      log.length = 0;
      await expect(
        emitter.emitAsync("invoice.paid", {
          role: "guest",
          invoiceId: "inv-8",
          amount: "10",
        }),
      ).rejects.toThrow(/Forbidden/i);
      expect(log).toEqual(["guard:guest"]);

      // Method-level @UsePipes with @EventPayload()
      const txt = await emitter.emitAsync("raw.text", "  hello  ");
      expect(txt).toEqual(["text:HELLO"]);

      // Request-scoped listener with @EventPayload("code", ParseIntPipe)
      const scoped = await emitter.emitAsync("scoped.extract", { code: "99" });
      expect(scoped).toEqual([100]);
    } finally {
      await ctx.close();
    }
  });
});
