import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@bunest/core";
import type { CreateUserDto } from "./create-user.dto";
import type { UpdateUserDto } from "./update-user.dto";

export interface UserRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly age?: number;
  readonly createdAt: string;
}

@Injectable()
export class UsersService {
  private readonly store = new Map<string, UserRecord>();
  private seq = 0;
  public createInvocations = 0;

  findAll(): UserRecord[] {
    return [...this.store.values()];
  }

  findOne(id: string): UserRecord {
    const user = this.store.get(id);
    if (!user) {
      throw new NotFoundException(`User "${id}" not found`);
    }
    return user;
  }

  create(dto: CreateUserDto): UserRecord {
    this.createInvocations++;
    for (const existing of this.store.values()) {
      if (existing.email.toLowerCase() === dto.email.toLowerCase()) {
        throw new ConflictException(`Email "${dto.email}" is already in use`);
      }
    }
    const id = `usr_${++this.seq}`;
    const record: UserRecord = {
      id,
      name: dto.name,
      email: dto.email,
      age: dto.age,
      createdAt: new Date().toISOString(),
    };
    this.store.set(id, record);
    return record;
  }

  update(id: string, dto: UpdateUserDto): UserRecord {
    const existing = this.findOne(id);
    const updated: UserRecord = {
      ...existing,
      name: dto.name ?? existing.name,
      email: dto.email ?? existing.email,
      age: dto.age !== undefined ? dto.age : existing.age,
    };
    this.store.set(id, updated);
    return updated;
  }

  remove(id: string): void {
    this.findOne(id);
    this.store.delete(id);
  }
}
