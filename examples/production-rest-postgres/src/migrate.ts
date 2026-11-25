import { DataSource, type OrmMigration } from "@bunest/orm";
import { loadAppConfig, logJson } from "./config";
import { ItemEntity } from "./item.entity";
import { ALL_MIGRATIONS, INITIAL_MIGRATIONS } from "./migrations";

export async function runProductionMigrations(
  databaseUrl: string,
  migrations: readonly OrmMigration[] = ALL_MIGRATIONS,
): Promise<readonly string[]> {
  const ds = new DataSource({
    type: "postgres",
    url: databaseUrl,
    entities: [ItemEntity],
    synchronize: false,
    migrations: [...migrations],
  });
  await ds.initialize();
  try {
    return await ds.runMigrations();
  } finally {
    await ds.destroy();
  }
}

if (import.meta.main) {
  const config = loadAppConfig();
  const target = Bun.argv.includes("--initial-only")
    ? INITIAL_MIGRATIONS
    : ALL_MIGRATIONS;
  try {
    const applied = await runProductionMigrations(config.databaseUrl, target);
    logJson("info", "migrations_complete", {
      appliedCount: applied.length,
      applied,
    });
  } catch (err) {
    logJson("error", "migrations_failed", { error: err });
    process.exit(1);
  }
}
