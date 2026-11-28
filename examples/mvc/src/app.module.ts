import { Module, resolve, type BunestApplication } from "@bunest/core";
import { AppController } from "./app.controller";
import { bunHtmlViewEngine } from "./view-engine";

export const VIEWS_DIR = resolve(import.meta.dir, "..", "views");
export const PUBLIC_DIR = resolve(import.meta.dir, "..", "public");

@Module({
  controllers: [AppController],
})
export class AppModule {}

export function configureMvcApp(app: BunestApplication): void {
  app.setBaseViewsDir(VIEWS_DIR);
  app.setViewEngine(bunHtmlViewEngine);
  app.useStaticAssets(PUBLIC_DIR, { prefix: "/static" });
}
