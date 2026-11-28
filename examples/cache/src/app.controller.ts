import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  UseInterceptors,
} from "@bunest/core";
import {
  CACHE_MANAGER,
  Cache,
  CacheInterceptor,
  CacheKey,
  CacheTTL,
  NoCache,
} from "@bunest/cache";
import { ProductsService } from "./products.service";

@Controller()
export class AppController {
  public summaryCalls = 0;
  public liveCalls = 0;

  constructor(
    private readonly products: ProductsService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  @Get("summary")
  @UseInterceptors(CacheInterceptor)
  @CacheKey("app_summary")
  @CacheTTL(5000)
  getSummary() {
    this.summaryCalls += 1;
    return {
      computedAt: this.summaryCalls,
      items: ["alpha", "beta"],
    };
  }

  @Get("live")
  @UseInterceptors(CacheInterceptor)
  @NoCache()
  getLive() {
    this.liveCalls += 1;
    return { liveTick: this.liveCalls };
  }

  @Get("products/:id")
  getProduct(@Param("id") id: string) {
    return this.products.findOne(id);
  }

  @Patch("products/:id")
  updateProduct(
    @Param("id") id: string,
    @Body() body: { price: number },
  ) {
    return this.products.updatePrice(id, body.price);
  }

  @Delete("products/cache")
  evictProductCache() {
    return this.products.invalidateAllProducts();
  }

  @Delete("cache")
  async clearAllCache() {
    await this.cache.clear();
    return { cleared: true };
  }
}
