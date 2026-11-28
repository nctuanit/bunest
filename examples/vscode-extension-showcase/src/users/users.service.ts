import { Injectable, Logger } from "@bunest/core";
import { ConfigService } from "@bunest/core/config";
import { EventEmitterService } from "@bunest/messaging/events";
import { Transactional } from "@bunest/orm";
import { AuditedOperation } from "../magic/aop-pipeline";
import { Money } from "./money.vo";
import { UserNotFoundError } from "./user-not-found.error";
import { UserEntity } from "./user.entity";
import { UserRepository } from "./user.repository";

export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
  readonly age?: number;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly usersRepo: UserRepository,
    private readonly events: EventEmitterService,
    private readonly config: ConfigService<Record<string, string | undefined>>,
  ) {}

  getRuntimeBanner(): { app: string; port: string; hasJwtSecret: boolean } {
    const port = this.config.get("PORT") ?? "3100";
    const appName = this.config.get("APP_NAME") ?? "Bunest Showcase";
    const secret = this.config.get("JWT_SECRET");
    return {
      app: appName,
      port: String(port),
      hasJwtSecret: Boolean(secret),
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
      throw new UserNotFoundError(`User #${id} not found`);
    }
    return user;
  }

  @Transactional()
  async create(input: CreateUserInput): Promise<UserEntity> {
    const saved = await this.usersRepo.save({
      email: input.email,
      name: input.name,
      age: input.age ?? 22,
      active: true,
    });

    await this.events.emitAsync("user.created", {
      id: saved.id,
      email: saved.email,
      name: saved.name,
    });

    const bonus = new Money(100, "USD").withAmount(125);
    this.logger.log(`Created user ${saved.email} (welcome bonus: ${bonus.toString()})`);
    return saved;
  }

  async remove(id: number): Promise<{ deleted: true; id: number }> {
    await this.usersRepo.deleteById(id);
    return { deleted: true, id };
  }
}
