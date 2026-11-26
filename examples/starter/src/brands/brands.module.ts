import { Module } from "@bunest/core";
import { OrmModule } from "@bunest/orm";
import { BrandEntity } from "./brand.entity";
import { BrandsController } from "./brands.controller";
import { BrandsService } from "./brands.service";

@Module({
  imports: [OrmModule.forFeature([BrandEntity])],
  controllers: [BrandsController],
  providers: [BrandsService],
  exports: [BrandsService],
})
export class BrandsModule {}
