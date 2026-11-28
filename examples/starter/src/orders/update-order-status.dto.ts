import { IsIn } from "@bunest/validation/validator";
import type { OrderStatus } from "./order.entity";

export class UpdateOrderStatusDto {
  @IsIn(["PENDING", "CONFIRMED", "SHIPPED", "CANCELLED"])
  status: OrderStatus;
}
