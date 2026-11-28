import { IsInt, Min } from "@bunest/validation/validator";

export class OrderItemInputDto {
  @IsInt()
  @Min(1)
  shoeId: number;

  @IsInt()
  @Min(1)
  quantity: number;
}
