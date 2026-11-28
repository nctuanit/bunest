import { Column, Entity, PrimaryGeneratedColumn } from "@bunest/orm";

@Entity("users")
export class UserEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text", unique: true })
  email: string;

  @Column({ name: "password_hash", type: "text" })
  passwordHash: string;

  @Column({ type: "json" })
  roles: string[];
}
