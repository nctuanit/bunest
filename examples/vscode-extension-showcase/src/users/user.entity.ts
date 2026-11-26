import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "@bunest/core";

@Entity("users")
export class UserEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Unique()
  email: string;

  @Column()
  name: string;

  @Column()
  @Index()
  age = 18;

  @Column()
  active = true;

  passwordHash?: string;
  tags?: string[];
}
