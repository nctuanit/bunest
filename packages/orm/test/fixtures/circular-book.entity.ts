import {
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from "../../src/index";
import { CircularAuthor } from "./circular-author.entity";

/**
 * Value-imports `CircularAuthor` directly AND annotates `author!: Relation<CircularAuthor>`.
 * Zero TDZ ReferenceError in ESM/Bun!
 */
@Entity("circular_books")
export class CircularBook {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column({ name: "author_id", nullable: true })
  authorId?: number | null;

  @ManyToOne(() => CircularAuthor, (author) => author.books, {
    cascade: true,
    onDelete: "CASCADE",
  })
  author?: Relation<CircularAuthor>;
}
