import { Injectable, WithLogger } from "@bunest/core";
import { ConfigService } from "@bunest/core/config";
import { EventEmitterService } from "@bunest/messaging/events";
import { Transactional } from "@bunest/orm";
import { AuditedOperation } from "../magic/aop-pipeline";
import { Money, UserNotFoundError } from "./money.vo";
import { UserEntity } from "./user.entity";
import { UserRepository } from "./user.repository";

export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
  readonly age?: number;
}

/**
 * 👉 Test Secret Redaction Hover:
 *    - Hover vào `"JWT_SECRET"` -> hiển thị `[REDACTED]` (bảo vệ secret!)
 *    - Hover vào `"PORT"`       -> hiển thị `3100`
 * 👉 Test Cross-Jump:
 *    - Cmd+Click vào `"user.created"` -> nhảy thẳng tới `@OnEvent("user.created")` trong `users.events.ts`!
 *    - Cmd+Click vào `"PORT"`         -> nhảy thẳng tới dòng `PORT=3100` trong `.env`!
 */
@Injectable()
@WithLogger()
export class UsersService {
  constructor(
    private readonly usersRepo: UserRepository,
    private readonly events: EventEmitterService,
    private readonly config: ConfigService,
  ) { }

  getRuntimeBanner(): { app: string; port: string; hasJwtSecret: boolean; emailField: string } {
    const port = this.config.get("PORT") ?? "3100";
    const appName = this.config.get("APP_NAME") ?? "Bunest Showcase";
    const secret = this.config.get("JWT_SECRET");
    return {
      app: appName,
      port: String(port),
      hasJwtSecret: Boolean(secret),
      emailField: UserEntity.Fields.email,
    };
  }

  @AuditedOperation("users.findAll")
  async findAll(): Promise<UserEntity[]> {
    this.logger.log("Fetching all users");
    return this.usersRepo.findAll();
  }

  async findAdults(minAge = 18): Promise<UserEntity[]> {
    return this.usersRepo.findAllByAgeGreaterThanEqualAndActiveIsTrueOrderByIdDesc(
      minAge,
    );
  }

  async findByIdOrThrow(id: number): Promise<UserEntity> {
    const user = await this.usersRepo.findById(id);
    if (!user) {
      throw UserNotFoundError.from(`User #${id} not found`);
    }
    return user;
  }

  @Transactional()
  async create(input: CreateUserInput): Promise<UserEntity> {
    const draft = UserEntity.builder()
      .email(input.email)
      .name(input.name)
      .age(input.age ?? 22)
      .active(true)
      .tag("member")
      .build();

    const saved = await this.usersRepo.save({
      email: draft.email,
      name: draft.name,
      age: draft.age,
      active: draft.active,
    });

    await this.events.emitAsync("user.created", {
      id: saved.id,
      email: saved.email,
      name: saved.name,
    });

    // Demo immutable @Value + @WithBy
    const bonus = Money.of({ amount: 100, currency: "USD" }).withAmountBy(
      (n) => n + 25,
    );
    this.logger.log(`Created user ${saved.email} (welcome bonus: ${bonus.toString()})`);
    return saved;
  }

  async remove(id: number): Promise<{ deleted: true; id: number }> {
    await this.usersRepo.deleteById(id);
    return { deleted: true, id };
  }
}
