import {
  Module,
  type BunestApplication,
  type BunestModule,
  type MiddlewareConsumer,
} from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { CatsController } from "./cats/cats.controller";
import { CatsModule } from "./cats/cats.module";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { LoggerMiddleware } from "./common/middleware/logger.middleware";

@Module({
  imports: [CatsModule],
  providers: [LoggerMiddleware],
})
export class AppModule implements BunestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(LoggerMiddleware).forRoutes(CatsController);
  }
}

export function configureCatsApp(app: BunestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
}
