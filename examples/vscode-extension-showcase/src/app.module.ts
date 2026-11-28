import { Module, type OnApplicationBootstrap } from "@bunest/core";
import { ConfigModule } from "@bunest/core/config";
import { EventEmitterModule } from "@bunest/messaging/events";
import { OrmModule } from "@bunest/orm";
import { appConfig } from "./config/app.config";
import { DevShowcaseBanner } from "./magic/dev-showcase-banner";
import { InMemoryShowcaseCacheStore } from "./magic/in-memory-showcase-cache.store";
import { ShowcaseAspectTrace } from "./magic/showcase-aspect-trace";
import { ShowcaseAuditAspect } from "./magic/showcase-audit.aspect";
import { ShowcaseCacheStore } from "./magic/showcase-cache-store";
import { ShowcaseObservabilityAspect } from "./magic/showcase-observability.aspect";
import { OrderEntity } from "./orders/order.entity";
import { OrderRepository } from "./orders/order.repository";
import { OrdersController } from "./orders/orders.controller";
import { OrdersService } from "./orders/orders.service";
import { UserEntity } from "./users/user.entity";
import { UserRepository } from "./users/user.repository";
import { UsersController } from "./users/users.controller";
import { UsersEventsListener } from "./users/users.events";
import { UsersService } from "./users/users.service";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
    }),
    EventEmitterModule.forRoot({
      global: true,
    }),
    OrmModule.forRoot({
      type: "sqlite",
      database: ":memory:",
      synchronize: true,
      entities: [UserEntity, OrderEntity],
    }),
    OrmModule.forFeature([UserRepository, OrderRepository]),
  ],
  controllers: [UsersController, OrdersController],
  providers: [
    UsersService,
    UsersEventsListener,
    OrdersService,
    ShowcaseAspectTrace,
    ShowcaseObservabilityAspect,
    ShowcaseAuditAspect,
    {
      provide: ShowcaseCacheStore,
      useClass: InMemoryShowcaseCacheStore,
    },
    DevShowcaseBanner,
  ],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(private readonly usersService: UsersService) {}

  async onApplicationBootstrap(): Promise<void> {
    const existing = await this.usersService.findAll();
    if (existing.length === 0) {
      await this.usersService.create({
        email: "alice@bunest.dev",
        name: "Alice Nguyen",
        age: 28,
      });
      await this.usersService.create({
        email: "bob@bunest.dev",
        name: "Bob Tran",
        age: 19,
      });
    }
  }
}
