import { Module } from "@bunest/core";
import { OrmModule } from "@bunest/orm";
import { BrandEntity } from "../brands/brand.entity";
import { ShoeEntity } from "./shoe.entity";
import { ShoeRepository } from "./shoe.repository";
import { ShoesController } from "./shoes.controller";
import { ShoesService } from "./shoes.service";

@Module({
  imports: [OrmModule.forFeature([ShoeEntity, BrandEntity, ShoeRepository])],
  controllers: [ShoesController],
  providers: [ShoesService],
  exports: [ShoesService, ShoeRepository],
})
export class ShoesModule {}
