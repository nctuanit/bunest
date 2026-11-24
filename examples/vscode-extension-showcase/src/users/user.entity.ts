import {
  Builder,
  Column,
  Data,
  Entity,
  FieldNameConstants,
  Index,
  PrimaryGeneratedColumn,
  Secret,
  Singular,
  Unique,
} from "@bunest/core";

/**
 * 👉 Hover lên `@Data()` / `@Builder()` / `UserEntity` để xem bảng toàn bộ generated members!
 * 👉 Bấm CodeLens `✨ ... macro members` (hoặc `Cmd+.`) để thử 1-click Expand (Delombok)!
 */
@Entity("users")
@Data()
@Builder({ toBuilder: true })
@FieldNameConstants()
export class UserEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  @Unique()
  email!: string;

  @Column()
  name!: string;

  @Column()
  @Index()
  @Builder.Default(18)
  age!: number;

  @Column()
  @Builder.Default(true)
  active!: boolean;

  @Secret()
  passwordHash?: string;

  @Singular()
  tags?: string[];
}