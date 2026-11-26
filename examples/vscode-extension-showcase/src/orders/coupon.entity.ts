import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
} from "@bunest/core";

@Entity("coupons")
export class CouponEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  code: string;

  @Column()
  discountPercent = 10;
}
