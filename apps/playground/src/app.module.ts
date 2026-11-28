import { Module, type BunestApplication } from "@bunest/core";
import { DevtoolsModule, ObservabilityModule } from "@bunest/observability";
import { OrmModule } from "@bunest/orm";
import { DocumentBuilder, SwaggerModule } from "@bunest/swagger";
import { ValidationPipe } from "@bunest/validation";
import { TodosController } from "./todos/todos.controller";
import { TodosService } from "./todos/todos.service";

@Module({
  imports: [
    OrmModule.forRoot({
      type: "sqlite",
      database: ":memory:",
      synchronize: true,
      autoLoadEntities: true,
      autoRegisterRepositories: true,
    }),
    ObservabilityModule.forRoot({
      tracing: {
        serviceName: "bunest-playground",
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
    DevtoolsModule.forRoot({
      path: "/_devtools",
      global: true,
    }),
  ],
  controllers: [TodosController],
  providers: [TodosService],
})
export class AppModule {}

export function configurePlaygroundApp(app: BunestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Bunest Interactive Playground")
    .setDescription(
      "All-in-one showcase: Decorator-First @Entity + @bunest/orm SQLite synchronize + Swagger + Health + Prometheus Metrics + Devtools",
    )
    .setVersion("0.1.0")
    .addTag("todos")
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("/docs", app, document);
}
