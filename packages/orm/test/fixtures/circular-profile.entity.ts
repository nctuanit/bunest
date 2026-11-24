import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from "../../src/index";
import { CircularAuthor } from "./circular-author.entity";

/**
 * Mutually value-imported with `CircularAuthor` (`CircularAuthor` imports `CircularProfile`
 * AND `CircularProfile` imports `CircularAuthor`)!
 * Loads cleanly in Bun ESM with ZERO TDZ ReferenceError!
 */
@Entity("circular_profiles")
export class CircularProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  bio!: string;

  @OneToOne(() => CircularAuthor, (author) => author.profile, {
    cascade: true,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "author_id" })
  author?: Relation<CircularAuthor>;
}
