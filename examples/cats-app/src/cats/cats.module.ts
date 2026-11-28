import { Module } from "@bunest/core";
import { RolesGuard } from "../common/guards/roles.guard";
import { LoggingInterceptor } from "../common/interceptors/logging.interceptor";
import { TransformInterceptor } from "../common/interceptors/transform.interceptor";
import { CatsController } from "./cats.controller";
import { CatsService } from "./cats.service";

@Module({
  controllers: [CatsController],
  providers: [
    CatsService,
    RolesGuard,
    LoggingInterceptor,
    TransformInterceptor,
  ],
  exports: [CatsService],
})
export class CatsModule {}
