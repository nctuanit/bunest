import { describe, expect, it } from "bun:test";
import { BunestFactory, Injectable, Module } from "@bunest/core";
import {
  EmitEvent,
  EventEmitterModule,
  EventEmitterService,
  OnEvent,
  defineAppEvent,
  isAppEvent,
  type AppEventPayload,
} from "../src/index";

describe("Type-safe AppEvent contracts (defineAppEvent)", () => {
  const OrderCreated = defineAppEvent<{ orderId: string; total: number }>(
    "order.created",
  );
  const OrderCancelled = defineAppEvent<{ orderId: string; reason: string }>(
    "order.cancelled",
  );
  const AppReady = defineAppEvent<void>("app.ready");

  it("identifies AppEvent contracts and dispatches typed sync, async, and @EmitEvent() flows", async () => {
    expect(isAppEvent(OrderCreated)).toBe(true);
    expect(isAppEvent({ name: "order.created" })).toBe(false);

    const createdPayloads: Array<AppEventPayload<typeof OrderCreated>> = [];
    const cancelledPayloads: Array<AppEventPayload<typeof OrderCancelled>> = [];
    const allOrderEvents: unknown[] = [];
    let readyCalls = 0;
    let readyArgCounts: number[] = [];

    @Injectable()
    class OrderListeners {
      @OnEvent(OrderCreated)
      handleCreated(payload: AppEventPayload<typeof OrderCreated>) {
        createdPayloads.push(payload);
        return `handled:${payload.orderId}`;
      }

      @OnEvent(OrderCancelled)
      async handleCancelled(payload: AppEventPayload<typeof OrderCancelled>) {
        await Promise.resolve();
        cancelledPayloads.push(payload);
        return `cancelled:${payload.orderId}`;
      }

      @OnEvent([OrderCreated, OrderCancelled])
      handleAnyOrderEvent(payload: unknown) {
        allOrderEvents.push(payload);
      }

      @OnEvent(AppReady)
      handleReady(...args: unknown[]) {
        readyCalls++;
        readyArgCounts.push(args.length);
        return "ready";
      }
    }

    @Injectable()
    class OrderService {
      @EmitEvent(OrderCreated)
      createOrder(orderId: string, total: number) {
        return { orderId, total };
      }

      @EmitEvent(OrderCancelled, {
        async: true,
        payload: (result) => ({
          orderId: (result as { id: string }).id,
          reason: "aspect_cancel",
        }),
        when: (result) => (result as { shouldEmit: boolean }).shouldEmit,
      })
      async cancelOrder(id: string, shouldEmit: boolean) {
        return { id, shouldEmit };
      }

      @EmitEvent((args) =>
        args[0] === "cancel" ? OrderCancelled : OrderCreated,
      )
      dispatchDynamic(action: "create" | "cancel", payload: unknown) {
        return payload;
      }
    }

    @Module({
      imports: [EventEmitterModule.forRoot()],
      providers: [OrderListeners, OrderService],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      const events = app.get(EventEmitterService);
      const orderService = app.get(OrderService);

      // 1. @EmitEvent(OrderCreated)
      orderService.createOrder("ord-1", 150);
      expect(createdPayloads).toEqual([{ orderId: "ord-1", total: 150 }]);

      // 2. emitAppEvent()
      events.emitAppEvent(OrderCreated, { orderId: "ord-2", total: 200 });
      expect(createdPayloads).toEqual([
        { orderId: "ord-1", total: 150 },
        { orderId: "ord-2", total: 200 },
      ]);

      // 3. emitAppEventAsync()
      const results = await events.emitAppEventAsync(OrderCancelled, {
        orderId: "ord-2",
        reason: "customer_request",
      });
      expect(results).toEqual(["cancelled:ord-2", undefined]);
      expect(cancelledPayloads).toEqual([
        { orderId: "ord-2", reason: "customer_request" },
      ]);

      // 4. @EmitEvent(Evt, { async: true, payload, when })
      await orderService.cancelOrder("ord-skip", false);
      expect(cancelledPayloads).toHaveLength(1);

      const cancelResult = await orderService.cancelOrder("ord-3", true);
      expect(cancelResult).toEqual({ id: "ord-3", shouldEmit: true });
      expect(cancelledPayloads).toEqual([
        { orderId: "ord-2", reason: "customer_request" },
        { orderId: "ord-3", reason: "aspect_cancel" },
      ]);

      // 5. Dynamic (args, res) => AppEvent
      orderService.dispatchDynamic("create", { orderId: "ord-4", total: 50 });
      expect(createdPayloads).toContainEqual({ orderId: "ord-4", total: 50 });

      // 6. @OnEvent([EvtA, EvtB]) received all 5 order events
      expect(allOrderEvents).toHaveLength(5);

      // 7. void AppEvent emits 0 arguments
      events.emitAppEvent(AppReady);
      const readyRes = await events.emitAppEventAsync(AppReady);
      expect(readyCalls).toBe(2);
      expect(readyArgCounts).toEqual([0, 0]);
      expect(readyRes).toEqual(["ready"]);
    } finally {
      await app.close();
    }
  });
});
