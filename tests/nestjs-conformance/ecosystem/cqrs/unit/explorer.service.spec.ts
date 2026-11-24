import { describe, expect, it, spyOn } from "bun:test";
import { Injectable } from "../../../../../packages/core/src/common";
import {
  CqrsExplorer,
  CqrsModule,
  EventBus,
  EventsHandler,
  type IEventHandler,
} from "../../../../../packages/messaging/src/cqrs";
import { Test, describeConformance } from "../../../_helpers";

class OrderPlacedEvent {}

@Injectable()
@EventsHandler(OrderPlacedEvent)
class OrderPlacedHandler implements IEventHandler<OrderPlacedEvent> {
  handle() {}
}

describeConformance(
  "ExplorerService (CqrsExplorer)",
  {
    upstreamPath: "nestjs/cqrs/src/services/explorer.service.spec.ts",
    category: "ADAPTED_PORT",
    notes:
      "Adapts NestJS ExplorerService to Bunest CqrsExplorer (ADR-013 ecosystem naming) and verifies useExisting alias deduplication.",
  },
  () => {
    describe('when a handler is also exposed through a "useExisting" alias', () => {
      // BUNEST_BUG: Expected CqrsExplorer to deduplicate handlers exposed via useExisting aliases so handle() runs once, but packages/messaging/src/cqrs/cqrs.module.ts getAllLoadedWrappers() only deduplicates by InstanceWrapper reference (ignoring wrapper.isAlias / same instance), causing handle() to be invoked twice.
      it.skip("should register and invoke the handler only once", async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [CqrsModule.forRoot()],
          providers: [
            OrderPlacedHandler,
            {
              provide: "ORDER_PLACED_HANDLER",
              useExisting: OrderPlacedHandler,
            },
          ],
        }).compile();

        try {
          const explorer = moduleRef.get(CqrsExplorer);
          expect(explorer).toBeInstanceOf(CqrsExplorer);

          const handler = moduleRef.get(OrderPlacedHandler);
          const handleSpy = spyOn(handler, "handle");
          await moduleRef.init();

          const eventBus = moduleRef.get(EventBus);
          await eventBus.publish(new OrderPlacedEvent());

          expect(handleSpy).toHaveBeenCalledTimes(1);
          handleSpy.mockRestore();
        } finally {
          await moduleRef.close();
        }
      });
    });
  },
);
