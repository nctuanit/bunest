import { invokeLifecycleHooks } from "./hydrator";
import { OrmRepository } from "./repository";
import type { DeepPartial, OrmDocumentDriverLike } from "./types";

export interface MongoFindOptions {
  readonly sort?: Record<string, 1 | -1>;
  readonly skip?: number;
  readonly limit?: number;
  readonly projection?: Record<string, 0 | 1>;
}

/**
 * TypeORM-compatible `MongoRepository<Entity>` powered by `@bunest/orm`'s
 * Bun-native `MongoOrmDriver` (`Bun.connect()` Wire Protocol `OP_MSG` + BSON
 * OR embedded local Bun document store), with full nested `@Embedded` class
 * hydration and cycle-safe JSON serialization!
 */
export class MongoRepository<
  Entity extends object = Record<string, unknown>,
> extends OrmRepository<Entity> {
  private requireDocDriver(): OrmDocumentDriverLike {
    const driver = this.documentDriver;
    if (!driver) {
      throw new Error(
        `MongoRepository<${this.metadata.name}> requires a MongoDB DataSource (type: "mongodb").`,
      );
    }
    return driver;
  }

  async insertOne(
    doc: DeepPartial<Entity>,
  ): Promise<{ insertedId: unknown; acknowledged: boolean }> {
    const driver = this.requireDocDriver();
    const inst = this.create(doc);
    await invokeLifecycleHooks(this.metadata, "before-insert", inst);
    const serialized = this.dehydrateDocument(inst as Record<string, unknown>);
    const res = await driver.docInsertMany(this.metadata.tableName, [serialized]);
    await invokeLifecycleHooks(this.metadata, "after-insert", inst);
    return {
      acknowledged: true,
      insertedId: res.insertedIds[0],
    };
  }

  async insertMany(
    docs: ReadonlyArray<DeepPartial<Entity>>,
  ): Promise<{ insertedCount: number; insertedIds: unknown[]; acknowledged: boolean }> {
    const driver = this.requireDocDriver();
    const instances = docs.map((d) => this.create(d));
    const serialized: Array<Record<string, unknown>> = [];
    for (const inst of instances) {
      await invokeLifecycleHooks(this.metadata, "before-insert", inst);
      serialized.push(this.dehydrateDocument(inst as Record<string, unknown>));
    }
    const res = await driver.docInsertMany(this.metadata.tableName, serialized);
    for (const inst of instances) {
      await invokeLifecycleHooks(this.metadata, "after-insert", inst);
    }
    return {
      acknowledged: true,
      insertedCount: res.insertedCount,
      insertedIds: res.insertedIds,
    };
  }

  /**
   * Executes a native MongoDB filter query (`$gt`, `$in`, `$regex`, `$and`, `$or`, dot-paths)
   * and hydrates results back into genuine Entity + nested `@Embedded` class instances!
   */
  async findByFilter(
    filter: Record<string, unknown> = {},
    options: MongoFindOptions = {},
  ): Promise<Entity[]> {
    const driver = this.requireDocDriver();
    const docs = await driver.docFind(this.metadata.tableName, filter, options);
    const out: Entity[] = [];
    for (const d of docs) {
      const inst = this.hydrateDocument(d);
      await invokeLifecycleHooks(this.metadata, "after-load", inst);
      out.push(inst);
    }
    return out;
  }

  async findOneByFilter(
    filter: Record<string, unknown> = {},
    options: Omit<MongoFindOptions, "limit"> = {},
  ): Promise<Entity | null> {
    const items = await this.findByFilter(filter, { ...options, limit: 1 });
    return items[0] ?? null;
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { upsert?: boolean } = {},
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedId?: unknown }> {
    const driver = this.requireDocDriver();
    return await driver.docUpdate(this.metadata.tableName, filter, update, {
      multi: false,
      upsert: options.upsert,
    });
  }

  async updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { upsert?: boolean } = {},
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedId?: unknown }> {
    const driver = this.requireDocDriver();
    return await driver.docUpdate(this.metadata.tableName, filter, update, {
      multi: true,
      upsert: options.upsert,
    });
  }

  async replaceOne(
    filter: Record<string, unknown>,
    replacement: DeepPartial<Entity>,
    options: { upsert?: boolean } = {},
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedId?: unknown }> {
    const driver = this.requireDocDriver();
    const inst = this.create(replacement);
    const doc = this.dehydrateDocument(inst as Record<string, unknown>);
    return await driver.docUpdate(this.metadata.tableName, filter, doc, {
      multi: false,
      upsert: options.upsert,
    });
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { returnDocument?: "before" | "after"; upsert?: boolean } = {},
  ): Promise<Entity | null> {
    const before = await this.findOneByFilter(filter);
    if (!before && !options.upsert) return null;
    await this.updateOne(filter, update, { upsert: options.upsert });
    if (options.returnDocument === "before") {
      return before;
    }
    return await this.findOneByFilter(filter);
  }

  async findOneAndDelete(
    filter: Record<string, unknown>,
  ): Promise<Entity | null> {
    const found = await this.findOneByFilter(filter);
    if (!found) return null;
    await this.deleteOne(filter);
    return found;
  }

  async deleteOne(
    filter: Record<string, unknown>,
  ): Promise<{ deletedCount: number }> {
    const driver = this.requireDocDriver();
    return await driver.docDelete(this.metadata.tableName, filter, {
      multi: false,
    });
  }

  async deleteMany(
    filter: Record<string, unknown>,
  ): Promise<{ deletedCount: number }> {
    const driver = this.requireDocDriver();
    return await driver.docDelete(this.metadata.tableName, filter, {
      multi: true,
    });
  }

  async countDocuments(filter: Record<string, unknown> = {}): Promise<number> {
    const driver = this.requireDocDriver();
    return await driver.docCount(this.metadata.tableName, filter);
  }

  async distinct<T = unknown>(
    field: string,
    filter: Record<string, unknown> = {},
  ): Promise<T[]> {
    const driver = this.requireDocDriver();
    return await driver.docDistinct<T>(this.metadata.tableName, field, filter);
  }

  async aggregate<T = Record<string, unknown>>(
    pipeline: readonly Record<string, unknown>[],
  ): Promise<T[]> {
    const driver = this.requireDocDriver();
    return await driver.docAggregate<T>(this.metadata.tableName, pipeline);
  }

  async createCollectionIndex(
    keys: Record<string, 1 | -1>,
    options?: { unique?: boolean; name?: string },
  ): Promise<string> {
    const driver = this.requireDocDriver();
    if (!driver.docCreateIndex) {
      throw new Error("Driver does not support createCollectionIndex().");
    }
    return await driver.docCreateIndex(this.metadata.tableName, keys, options);
  }
}
