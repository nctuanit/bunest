import {
  FunctionalModule,
  Module,
  type BunestApplication,
} from "@bunest/core";
import { DocumentBuilder, SwaggerModule } from "@bunest/swagger";
import { appContract } from "./shared/contract";
import { ApiKeyGuard } from "./tasks/api-key.guard";
import { TasksService } from "./tasks/tasks.service";

@Module({
  imports: [
    FunctionalModule.forContract(
      appContract,
      {
        tasks: {
          list: ({ query, get }) => get(TasksService).list(query),
          getById: ({ params, get }) => get(TasksService).getById(params.id),
          create: {
            guards: [ApiKeyGuard],
            httpCode: 201,
            handler: ({ body, get }) => get(TasksService).create(body),
          },
          update: {
            guards: [ApiKeyGuard],
            handler: ({ params, body, get }) =>
              get(TasksService).update(params.id, body),
          },
          remove: {
            guards: [ApiKeyGuard],
            handler: ({ params, get }) => get(TasksService).remove(params.id),
          },
        },
      },
      {
        providers: [TasksService, ApiKeyGuard],
      },
    ),
  ],
})
export class AppModule {}

export function configureFullstackContractApp(app: BunestApplication): void {
  const swaggerConfig = new DocumentBuilder()
    .setTitle("Bunest Full-Stack Contract API")
    .setDescription(
      "Auto-generated OpenAPI 3.1 directly from a shared defineContract() + s.* schema",
    )
    .setVersion("1.0.0")
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("/docs", app, document);
}
