import { CrudRepository, OrmRepository } from "@bunest/orm";
import { UserEntity } from "./user.entity";

@OrmRepository(UserEntity)
export abstract class UserRepository extends CrudRepository<UserEntity, number> {
  abstract findByEmail(email: string): Promise<UserEntity | null>;
  abstract existsByEmail(email: string): Promise<boolean>;
  abstract findAllByAge(age: number): Promise<UserEntity[]>;
  abstract findAllByAgeGreaterThanEqualAndActiveIsTrueOrderByIdDesc(
    minAge: number,
  ): Promise<UserEntity[]>;
}
