import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "@bunest/core";

@Entity("orders")
export class OrderEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Unique()
  orderCode: string;

  @Column()
  @Index()
  status: string;

  @Column()
  totalCents: number;

  @Column({ name: "deleted_at", nullable: true })
  deletedAt?: string | null;
}
