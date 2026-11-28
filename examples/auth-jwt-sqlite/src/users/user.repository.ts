import { Repository } from "@bunest/orm";
import type { UserEntity } from "./user.entity";

@Repository<UserEntity, number>()
export abstract class UserRepository {
  abstract findByEmail(email: string): Promise<UserEntity | null>;
  abstract existsByEmail(email: string): Promise<boolean>;

  async countRegisteredUsers(): Promise<number> {
    const row = await this.queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM users",
    );
    return Number(row?.count ?? 0);
  }
}
