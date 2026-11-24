import {
  Column,
  Data,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "@bunest/core";

/**
 * Showcase `@Entity("orders")` + `@Data()` dùng chung với `OrderRepository`
 * (`@SoftDelete()`, `@Projection()`, `Page<T>`, `@IgnoreScope()`, và custom operator `IContains`).
 */
@Entity("orders")
@Data()
export class OrderEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  @Unique()
  orderCode!: string;

  @Column()
  @Index()
  status!: string;

  @Column()
  totalCents!: number;

  @Column({ name: "deleted_at", nullable: true })
  deletedAt?: string | null;
}
