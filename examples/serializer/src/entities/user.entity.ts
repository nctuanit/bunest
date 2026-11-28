import { Exclude, Expose, Transform, Type } from "@bunest/validation/transformer";
import { RoleEntity } from "./role.entity";

export class UserEntity {
  id: number;
  firstName: string;
  lastName: string;

  @Exclude()
  password: string;

  _internalToken: string;

  @Expose({ groups: ["admin"] })
  auditNote: string;

  @Type(() => RoleEntity)
  @Transform(({ value }) =>
    value && typeof value === "object" && "name" in value
      ? (value as RoleEntity).name
      : value,
  )
  role: RoleEntity;

  @Expose()
  get fullName(): string {
    return `${this.firstName} ${this.lastName}`;
  }

  constructor(partial: Partial<UserEntity>) {
    Object.assign(this, partial);
  }
}
