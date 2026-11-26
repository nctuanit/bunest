import { Module } from "@bunest/core";
import { OrmModule } from "@bunest/orm";
import { ShoeEntity } from "../shoes/shoe.entity";
import { ShoesModule } from "../shoes/shoes.module";
import { OrderItemEntity } from "./order-item.entity";
import { OrderEntity } from "./order.entity";
import { OrderRepository } from "./order.repository";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({
  imports: [
    OrmModule.forFeature([OrderEntity, OrderItemEntity, ShoeEntity, OrderRepository]),
    ShoesModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
