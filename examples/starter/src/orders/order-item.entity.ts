import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "@bunest/orm";
import { ShoeEntity } from "../shoes/shoe.entity";
import { OrderEntity } from "./order.entity";

@Entity("order_items")
export class OrderItemEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column("integer")
  quantity: number;

  @Column("integer")
  size: number;

  @Column("integer")
  unitPrice: number;

  @ManyToOne(() => OrderEntity, (order) => order.items, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "order_id" })
  order: OrderEntity;

  @ManyToOne(() => ShoeEntity)
  @JoinColumn({ name: "shoe_id" })
  shoe: ShoeEntity;
}
