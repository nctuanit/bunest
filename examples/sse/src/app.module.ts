import { Module } from "@bunest/core";
import { AppController } from "./app.controller";
import { NotificationsService } from "./notifications.service";

@Module({
  controllers: [AppController],
  providers: [NotificationsService],
})
export class AppModule {}
