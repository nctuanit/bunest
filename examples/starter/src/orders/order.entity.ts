import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
} from "@bunest/orm";
import { OrderItemEntity } from "./order-item.entity";

export type OrderStatus = "PENDING" | "CONFIRMED" | "SHIPPED" | "CANCELLED";

@Entity("orders")
export class OrderEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Unique()
  orderCode: string;

  @Column()
  customerName: string;

  @Column()
  customerPhone: string;

  @Column("integer")
  totalAmount: number;

  @Column()
  @Index()
  status: OrderStatus = "PENDING";

  @CreateDateColumn()
  createdAt: Date;

  @OneToMany(() => OrderItemEntity, (item) => item.order, { cascade: true })
  items: OrderItemEntity[];
}
