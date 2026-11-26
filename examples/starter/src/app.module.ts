import {
  Controller,
  Get,
  Module,
  type Logger,
  type OnApplicationBootstrap,
} from "@bunest/core";
import { OrmModule } from "@bunest/orm";
import { BrandEntity } from "./brands/brand.entity";
import { BrandsModule } from "./brands/brands.module";
import { BrandsService } from "./brands/brands.service";
import { OrderItemEntity } from "./orders/order-item.entity";
import { OrderEntity } from "./orders/order.entity";
import { OrdersModule } from "./orders/orders.module";
import { ShoeEntity } from "./shoes/shoe.entity";
import { ShoesModule } from "./shoes/shoes.module";
import { ShoesService } from "./shoes/shoes.service";

@Controller()
export class HealthController {
  @Get("health")
  health() {
    return {
      status: "ok",
      shop: Bun.env.APP_NAME ?? "Bunest Sneaker Shop",
      runtime: `Bun ${Bun.version}`,
    };
  }
}

@Module({
  imports: [
    OrmModule.forRoot({
      type: "sqlite",
      database: Bun.env.DATABASE_URL ?? ":memory:",
      synchronize: true,
      entities: [BrandEntity, ShoeEntity, OrderEntity, OrderItemEntity],
    }),
    BrandsModule,
    ShoesModule,
    OrdersModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements OnApplicationBootstrap {
  declare readonly logger: Logger;

  constructor(
    private readonly brandsService: BrandsService,
    private readonly shoesService: ShoesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const existing = await this.shoesService.findAll();
    if (existing.length > 0) return;

    const nike = await this.brandsService.create({ name: "Nike", country: "USA" });
    const adidas = await this.brandsService.create({ name: "Adidas", country: "Germany" });
    const nb = await this.brandsService.create({ name: "New Balance", country: "USA" });
    const converse = await this.brandsService.create({ name: "Converse", country: "USA" });
    const asics = await this.brandsService.create({ name: "Asics", country: "Japan" });

    const catalog = [
      {
        sku: "NIKE-AF1-42",
        name: "Nike Air Force 1 '07 White",
        brandId: nike.id,
        category: "Lifestyle",
        size: 42,
        price: 2_929_000,
        stock: 15,
      },
      {
        sku: "ADI-UB23-41",
        name: "Adidas Ultraboost Light",
        brandId: adidas.id,
        category: "Running",
        size: 41,
        price: 4_500_000,
        stock: 8,
      },
      {
        sku: "NB-550-42",
        name: "New Balance 550 White Green",
        brandId: nb.id,
        category: "Lifestyle",
        size: 42,
        price: 3_250_000,
        stock: 10,
      },
      {
        sku: "CONV-70-40",
        name: "Converse Chuck 70 High Black",
        brandId: converse.id,
        category: "Classic",
        size: 40,
        price: 2_100_000,
        stock: 20,
      },
      {
        sku: "ASICS-K14-43",
        name: "Asics Gel-Kayano 14 Silver",
        brandId: asics.id,
        category: "Running",
        size: 43,
        price: 4_200_000,
        stock: 5,
      },
    ];

    for (const item of catalog) {
      await this.shoesService.create(item);
    }
    this.logger.log(`Seeded 5 brands and ${catalog.length} sneakers`);
  }
}
