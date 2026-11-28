import { Module } from "@bunest/core";
import { ClassSerializerInterceptor } from "@bunest/validation";
import { UsersController } from "./users.controller";

@Module({
  controllers: [UsersController],
  providers: [ClassSerializerInterceptor],
})
export class AppModule {}
