import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "@bunest/orm";

@Entity("tasks")
export class TaskEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: "user_id", type: "integer" })
  userId: number;

  @Column({ type: "text" })
  title: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
