import { Repository } from "@bunest/orm";
import type { UserEntity } from "./user.entity";

@Repository<UserEntity, number>()
export abstract class UserRepository {
  abstract findByEmail(email: string): Promise<UserEntity | null>;
  abstract existsByEmail(email: string): Promise<boolean>;
  abstract findAllByAge(age: number): Promise<UserEntity[]>;
  abstract findAllByAgeGreaterThanEqualAndActiveIsTrueOrderByIdDesc(
    minAge: number,
  ): Promise<UserEntity[]>;
}
