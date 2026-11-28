import { Module } from "@bunest/core";
import { CacheInterceptor, CacheModule } from "@bunest/cache";
import { AppController } from "./app.controller";
import { ProductsService } from "./products.service";

@Module({
  imports: [
    CacheModule.register({
      isGlobal: true,
      ttl: 5000,
    }),
  ],
  controllers: [AppController],
  providers: [ProductsService, CacheInterceptor],
})
export class AppModule {}
