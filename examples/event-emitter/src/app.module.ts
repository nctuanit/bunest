import { Module, type BunestApplication } from "@bunest/core";
import { EventEmitterModule } from "@bunest/messaging/events";
import { ValidationPipe } from "@bunest/validation";
import { OrdersModule } from "./orders/orders.module";

@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,
      global: true,
    }),
    OrdersModule,
  ],
})
export class AppModule {}

export function configureEventEmitterApp(app: BunestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
