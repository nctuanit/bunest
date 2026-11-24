import {
  Builder,
  Column,
  Data,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "@bunest/core";

/**
 * 👉 Entity này cố tình CHƯA có Repository!
 *    Bấm CodeLens `✨ Generate CrudRepository for CouponEntity` ngay trên tên class
 *    để tự động sinh file `coupon.repository.ts` với `findByCode`, `existsByCode`, `findAllByActive`!
 */
@Entity("coupons")
@Data()
@Builder()
export class CouponEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  @Unique()
  code!: string;

  @Column()
  discountPercent!: number;

  @Column()
  @Index()
  active!: boolean;
}

