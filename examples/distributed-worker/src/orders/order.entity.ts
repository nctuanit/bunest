import { Column, Entity, PrimaryGeneratedColumn } from "@bunest/orm";

export interface OrderRecord {
  readonly id: number;
  readonly item: string;
  readonly amount: number;
  readonly status: string;
}

@Entity("orders")
export class OrderEntity implements OrderRecord {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text" })
  item: string;

  @Column({ type: "integer" })
  amount: number;

  @Column({ type: "text" })
  status: string;
}
