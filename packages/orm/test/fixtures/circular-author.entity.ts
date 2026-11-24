import {
  Column,
  Embedded,
  Embeds,
  Entity,
  HasOne,
  OneToMany,
  PrimaryGeneratedColumn,
  entityRef,
  type Nested,
  type Relation,
} from "../../src/index";
import type { CircularBook } from "./circular-book.entity";
import { CircularProfile } from "./circular-profile.entity";

/**
 * Typed zero-runtime-import reference to `CircularBook`.
 */
export const CircularBookRef = entityRef<CircularBook>("CircularBook");

export class AuthorContact {
  @Column()
  city!: string;

  @Column({ nullable: true })
  website?: string;

  format(): string {
    return this.website ? `${this.city} (${this.website})` : this.city;
  }
}

/**
 * Notice THREE circular-safe patterns working together in real separate ESM files:
 * 1. `books`: `import type { CircularBook }` + `CircularBookRef` (ZERO runtime circular import!)
 * 2. `profile`: class-level `@HasOne` with value-imported `CircularProfile` & plain property type `profile?: CircularProfile` (ZERO `design:type` TDZ!)
 * 3. `contact` + `backupContact`: `@Embedded` with `Nested<T>` AND `@Embeds` class-level!
 */
@Entity("circular_authors")
@HasOne("profile", () => CircularProfile, {
  inverseSide: "author",
  cascade: true,
})
@Embeds("backupContact", () => AuthorContact, { prefix: "backup_" })
export class CircularAuthor {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Embedded(() => AuthorContact)
  contact?: Nested<AuthorContact>;

  backupContact?: AuthorContact;

  @OneToMany(CircularBookRef, (book) => book.author, { cascade: true })
  books!: Relation<CircularBook[]>;

  profile?: CircularProfile;
}
