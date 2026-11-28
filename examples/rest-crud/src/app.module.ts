import { Module, type BunestApplication } from "@bunest/core";
import { DocumentBuilder, SwaggerModule } from "@bunest/swagger";
import { ValidationPipe } from "@bunest/validation";
import { ApiExceptionFilter } from "./api-exception.filter";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [UsersModule],
})
export class AppModule {}

export function configureRestCrudApp(app: BunestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Bunest REST CRUD API")
    .setDescription("Flagship Bunest Users CRUD API with OpenAPI 3.1")
    .setVersion("1.0.0")
    .addTag("users")
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("/docs", app, document);
}
