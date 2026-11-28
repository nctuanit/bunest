import { Module, resolve, type BunestApplication } from "@bunest/core";
import { ServeStaticModule } from "@bunest/core/http";
import { AppController } from "./app.controller";

export const CLIENT_DIR = resolve(import.meta.dir, "..", "client");

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: CLIENT_DIR,
      exclude: ["/api/{*path}"],
    }),
  ],
  controllers: [AppController],
})
export class AppModule {}

export function configureServeStaticApp(app: BunestApplication): void {
  app.setGlobalPrefix("api");
}
