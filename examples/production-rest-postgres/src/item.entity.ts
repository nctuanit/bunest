import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "@bunest/orm";

@Entity("items")
export class ItemEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text" })
  name: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({ type: "integer", default: 0 })
  quantity: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date | string;
}
