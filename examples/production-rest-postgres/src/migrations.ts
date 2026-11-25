import type { OrmMigration, OrmQueryExecutor } from "@bunest/orm";

/**
 * Migration 001: Initial `items` table for Bunest 0.1 production preview.
 */
export const CreateItems001: OrmMigration = {
  id: "001_create_items",
  name: "CreateItems001",
  async up(ctx: OrmQueryExecutor): Promise<void> {
    await ctx.query(`
      CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        quantity INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await ctx.query(`
      CREATE INDEX IF NOT EXISTS idx_items_created_at ON items (created_at DESC)
    `);
  },
  async down(ctx: OrmQueryExecutor): Promise<void> {
    await ctx.query(`DROP TABLE IF EXISTS items`);
  },
};

/**
 * Migration 002: Additive, backward-compatible column addition.
 * Older app images (v1) continue reading/writing `items` safely without running
 * destructive down migrations during a rollback.
 */
export const AddItemsMetadata002: OrmMigration = {
  id: "002_add_items_metadata",
  name: "AddItemsMetadata002",
  async up(ctx: OrmQueryExecutor): Promise<void> {
    await ctx.query(`
      ALTER TABLE items
      ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    `);
  },
  async down(ctx: OrmQueryExecutor): Promise<void> {
    await ctx.query(`
      ALTER TABLE items
      DROP COLUMN IF EXISTS metadata
    `);
  },
};

export const INITIAL_MIGRATIONS: readonly OrmMigration[] = [CreateItems001];

export const ALL_MIGRATIONS: readonly OrmMigration[] = [
  CreateItems001,
  AddItemsMetadata002,
];
