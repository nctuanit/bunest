import type { OrmMigration } from "@bunest/orm";

export const AUTH_SQLITE_MIGRATIONS: readonly OrmMigration[] = [
  {
    id: "001_create_users",
    up: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        roles TEXT NOT NULL
      );
    `,
    down: "DROP TABLE users;",
  },
  {
    id: "002_create_tasks",
    up: `
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE task_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        action TEXT NOT NULL
      );
    `,
    down: "DROP TABLE task_audit; DROP TABLE tasks;",
  },
];
