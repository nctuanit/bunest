import type { OrmMigration } from "@bunest/orm";

export const ORDER_MIGRATIONS: readonly OrmMigration[] = [
  {
    id: "001_create_orders",
    up: `
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL
      );
    `,
    down: "DROP TABLE orders;",
  },
];
