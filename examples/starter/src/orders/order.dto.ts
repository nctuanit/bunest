import { Type } from "@bunest/validation/transformer";
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from "@bunest/validation/validator";
import type { OrderStatus } from "./order.entity";

export class OrderItemInputDto {
  @IsInt()
  @Min(1)
  shoeId: number;

  @IsInt()
  @Min(1)
  quantity: number;
}

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  customerName: string;

  @IsString()
  @IsNotEmpty()
  customerPhone: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items: OrderItemInputDto[];
}

export class UpdateOrderStatusDto {
  @IsIn(["PENDING", "CONFIRMED", "SHIPPED", "CANCELLED"])
  status: OrderStatus;
}
