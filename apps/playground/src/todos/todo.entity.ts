import { Column, Entity, PrimaryGeneratedColumn } from "@bunest/orm";

export interface TodoItem {
  readonly id: number;
  readonly title: string;
  readonly completed: boolean;
}

@Entity("todos")
export class Todo implements TodoItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({
    type: "text",
    minLength: 1,
    description: "Todo title",
    example: "Try Bunest Playground",
  })
  title!: string;

  @Column({
    type: "boolean",
    default: false,
    description: "Whether the todo is completed",
    example: false,
  })
  completed!: boolean;
}
