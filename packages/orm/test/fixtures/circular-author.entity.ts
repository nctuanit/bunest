import {
  Column,
  Embedded,
  Entity,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  entityRef,
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

@Entity("circular_authors")
export class CircularAuthor {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Embedded(() => AuthorContact)
  contact?: AuthorContact;

  @Embedded(() => AuthorContact, { prefix: "backup_" })
  backupContact?: AuthorContact;

  @OneToMany(CircularBookRef, (book) => book.author, { cascade: true })
  books!: CircularBook[];

  @OneToOne(() => CircularProfile, (profile) => profile.author, {
    cascade: true,
  })
  profile?: CircularProfile;
}
