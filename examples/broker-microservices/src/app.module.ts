import { ClsModule, Module } from "@bunest/core";
import {
  InMemoryBroker,
  InMemoryClientProxy,
  MicroserviceModule,
  Transport,
  type MicroserviceDeadLetterContext,
} from "@bunest/microservices";
import { ResilienceModule } from "@bunest/resilience";
import { IdempotencyModule } from "@bunest/resilience/idempotency";
import {
  InventoryRpcController,
  type AuditEntry,
} from "./inventory.rpc-controller";
import { OrdersHttpController } from "./orders.http-controller";
import {
  AUDIT_LOG_TOKEN,
  DEAD_LETTERS_TOKEN,
  ORDERS_RPC_CLIENT,
} from "./orders.types";
import { PaymentGatewayService } from "./payments.service";

export function createBrokerMicroservicesModule() {
  const broker = new InMemoryBroker();
  const rpcClient = new InMemoryClientProxy({ channel: "orders-bus", broker });
  const auditLog: AuditEntry[] = [];
  const deadLetters: MicroserviceDeadLetterContext[] = [];

  @Module({
    imports: [
      ClsModule.forRoot({ global: true }),
      ResilienceModule.forRoot(),
      IdempotencyModule.forRoot(),
      MicroserviceModule.forRoot({
        transport: Transport.IN_MEMORY,
        options: {
          channel: "orders-bus",
          broker,
          deadLetterHandler: (ctx) => {
            deadLetters.push(ctx);
          },
        },
      }),
    ],
    controllers: [OrdersHttpController, InventoryRpcController],
    providers: [
      PaymentGatewayService,
      { provide: ORDERS_RPC_CLIENT, useValue: rpcClient },
      { provide: AUDIT_LOG_TOKEN, useValue: auditLog },
      { provide: DEAD_LETTERS_TOKEN, useValue: deadLetters },
    ],
  })
  class BrokerMicroservicesAppModule {}

  return {
    AppModule: BrokerMicroservicesAppModule,
    broker,
    rpcClient,
    auditLog,
    deadLetters,
  };
}
