import { Module } from "@bunest/core";
import { MemoryQueueDriver, QueueModule } from "@bunest/jobs/queues";
import { CqrsModule } from "@bunest/messaging/cqrs";
import { EventEmitterModule } from "@bunest/messaging/events";
import {
  InMemorySpanExporter,
  ObservabilityModule,
} from "@bunest/observability";
import { OrmModule } from "@bunest/orm";
import { CreateOrderHandler } from "./orders/create-order.handler";
import { OrderEventAuditListener } from "./orders/order-event-audit.listener";
import { ORDER_MIGRATIONS } from "./orders/order.migrations";
import { OrderRepository } from "./orders/order.repository";
import { OrdersController } from "./orders/orders.controller";
import { OrdersProcessor } from "./orders/orders.processor";
import { OrdersService } from "./orders/orders.service";

export function createDistributedWorkerModule(
  exporter: InMemorySpanExporter = new InMemorySpanExporter(),
) {
  @Module({
    imports: [
      ObservabilityModule.forRoot({
        tracing: {
          serviceName: "bunest-distributed-worker",
          exporter,
          registerGlobalInterceptor: true,
          global: true,
        },
        metrics: {
          path: "/metrics",
          registerGlobalInterceptor: true,
          global: true,
        },
        health: {
          livenessPath: "/health",
          readinessPath: "/ready",
          global: true,
        },
      }),
      OrmModule.forRoot({
        type: "sqlite",
        database: ":memory:",
        migrations: ORDER_MIGRATIONS,
        autoMigrate: true,
      }),
      OrmModule.forFeature([OrderRepository]),
      EventEmitterModule.forRoot({ global: true }),
      CqrsModule.forRoot({ global: true }),
      QueueModule.forRoot({
        driver: new MemoryQueueDriver(),
        global: true,
      }),
      QueueModule.registerQueue({
        name: "orders",
        concurrency: 2,
      }),
    ],
    controllers: [OrdersController],
    providers: [
      OrdersService,
      CreateOrderHandler,
      OrdersProcessor,
      OrderEventAuditListener,
    ],
  })
  class DistributedWorkerModule {}

  return DistributedWorkerModule;
}

export const AppModule = createDistributedWorkerModule();
