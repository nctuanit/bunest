import { Injectable, NotFoundException } from "@bunest/core";
import { DataSource, InjectDataSource } from "@bunest/orm";
import type { CreateItemDto } from "./item.dto";
import { ItemEntity } from "./item.entity";
import { ItemRepository } from "./item.repository";

export interface ItemResponse {
  readonly id: number;
  readonly name: string;
  readonly description: string | null;
  readonly quantity: number;
  readonly createdAt: string;
}

function toItemResponse(row: {
  id: number;
  name: string;
  description?: string | null;
  quantity?: number;
  createdAt?: Date | string;
  created_at?: Date | string;
}): ItemResponse {
  const rawDate = row.createdAt ?? row.created_at ?? new Date();
  const createdAt =
    rawDate instanceof Date ? rawDate.toISOString() : String(rawDate);
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description ?? null,
    quantity: Number(row.quantity ?? 0),
    createdAt,
  };
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly items: ItemRepository,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async create(dto: CreateItemDto): Promise<ItemResponse> {
    const entity = new ItemEntity();
    entity.name = dto.name.trim();
    entity.description = dto.description ?? null;
    entity.quantity = dto.quantity ?? 0;

    const saved = await this.items.save(entity);
    return toItemResponse(saved);
  }

  async findById(rawId: string): Promise<ItemResponse> {
    if (!/^[1-9]\d*$/.test(rawId)) {
      throw new NotFoundException(`Item "${rawId}" not found`);
    }
    const id = Number(rawId);
    if (!Number.isSafeInteger(id)) {
      throw new NotFoundException(`Item "${rawId}" not found`);
    }
    const found = await this.items.findById(id);
    if (!found) {
      throw new NotFoundException(`Item "${id}" not found`);
    }
    return toItemResponse(found);
  }

  /**
   * Used by transaction integrity integration tests to verify that a failure
   * mid-transaction rolls back all prior inserts atomically on PostgreSQL.
   */
  async createAtomicPair(
    first: CreateItemDto,
    second: CreateItemDto,
    options?: { failAfterFirst?: boolean },
  ): Promise<[ItemResponse, ItemResponse]> {
    return this.dataSource.transaction(async () => {
      const a = await this.create(first);
      if (options?.failAfterFirst) {
        throw new Error("Simulated transaction failure after first insert");
      }
      const b = await this.create(second);
      return [a, b];
    });
  }
}
