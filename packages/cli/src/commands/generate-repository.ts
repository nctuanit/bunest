import { basename, dirname, relative, resolve } from "@bunest/core";
import {
  BunestStaticAnalyzer,
  buildGenerateRepositorySource,
  type RepoSqlDialect,
} from "../analyzer";
import { loadCliConfiguration } from "../config/configuration.loader";
import type { CliIO, GeneratedFile } from "../types";
import { writePlannedFiles } from "../utils/fs-writer";
import { parseSchematicName } from "../utils/naming";

export interface GenerateRepositoryOptions {
  readonly target: string;
  readonly dialect?: RepoSqlDialect;
  readonly dir?: string;
  readonly sourceRoot?: string;
  readonly config?: string;
  readonly cwd?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

export interface GenerateRepositoryResult {
  readonly entityName: string;
  readonly packageName: "@bunest/orm";
  readonly dialect: RepoSqlDialect;
  readonly files: readonly GeneratedFile[];
  readonly dryRun: boolean;
}

/**
 * Generates a declarative `@bunest/orm` `CrudRepository`
 * (`bunest generate repository <Entity>` / `bunest g repo <Entity>`)
 * directly from an `@Entity()` class discovered via the Bunest native TypeScript
 * AST engine, automatically synthesizing derived finders for `@Unique()` and `@Index()` columns.
 */
export async function generateRepositoryCommand(
  options: GenerateRepositoryOptions,
  io?: CliIO,
): Promise<GenerateRepositoryResult> {
  const cwd = resolve(options.cwd ?? io?.cwd ?? process.cwd());
  const loaded = await loadCliConfiguration(cwd, options.config);
  const sourceRoot = options.sourceRoot ?? loaded.config.sourceRoot ?? "src";
  const dialect: RepoSqlDialect = options.dialect ?? "sqlite";
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;

  const analyzer = new BunestStaticAnalyzer({ cwd, sourceRoot });
  const snap = analyzer.analyze();

  const needle = options.target.trim();
  const needleLower = needle.toLowerCase();
  const absNeedle = resolve(cwd, needle);

  const entity = snap.entities.find(
    (e) =>
      e.className === needle ||
      e.className.toLowerCase() === needleLower ||
      e.className.replace(/Entity$/i, "").toLowerCase() === needleLower ||
      e.tableName.toLowerCase() === needleLower ||
      e.sourceFile === absNeedle ||
      basename(e.sourceFile).toLowerCase() === needleLower,
  );

  let baseDir: string;
  let fileName: string;
  let content: string;
  let entityName: string;

  if (entity) {
    entityName = entity.className;
    baseDir = options.dir ? resolve(cwd, options.dir) : dirname(entity.sourceFile);
    let relImport = relative(baseDir, entity.sourceFile)
      .replace(/\\/g, "/")
      .replace(/\.ts$/, "");
    if (!relImport.startsWith(".")) relImport = `./${relImport}`;
    const built = buildGenerateRepositorySource({
      entity,
      entityImportPath: relImport,
      dialect,
    });
    fileName = built.fileName;
    content = built.content;
  } else {
    // Graceful fallback template when no matching @Entity() class exists yet
    const parsed = parseSchematicName(needle);
    entityName = `${parsed.pascal}Entity`;
    const repoClass = `${parsed.pascal}Repository`;
    baseDir = resolve(cwd, options.dir ?? sourceRoot, parsed.subDir);
    fileName = `${parsed.kebab}.repository.ts`;
    content = [
      'import { CrudRepository, Entity, OrmRepository, PrimaryGeneratedColumn } from "@bunest/orm";',
      "",
      "@Entity()",
      `export class ${entityName} {`,
      "  @PrimaryGeneratedColumn()",
      "  id!: number;",
      "}",
      "",
      `@OrmRepository(${entityName})`,
      `export abstract class ${repoClass} extends CrudRepository<${entityName}, number> {`,
      `  // Add derived finders here, e.g.: abstract findById(id: number): Promise<${entityName} | null>;`,
      "}",
      "",
    ].join("\n");
  }

  const files = await writePlannedFiles({
    baseDir,
    files: [{ relativePath: fileName, content }],
    dryRun,
    force,
  });

  if (io) {
    for (const f of files) {
      const tag =
        f.action === "dry-run"
          ? "DRY-RUN"
          : f.action === "overwrite"
            ? "OVERWRITE"
            : "CREATE";
      const relOut = relative(cwd, f.path).replace(/\\/g, "/");
      io.stdout(`  ${tag} ${relOut}`);
    }
  }

  return {
    entityName,
    packageName: "@bunest/orm",
    dialect,
    files,
    dryRun,
  };
}
