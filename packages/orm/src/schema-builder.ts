import { getDialectProfile } from "./dialect/dialect-profile";
import { isDocumentDriver } from "./driver/driver.interface";
import {
  formatTableRef,
  quoteIdentifier,
} from "./identifiers";
import type {
  CompiledColumnMetadata,
  CompiledEntityMetadata,
  CompiledIndexMetadata,
  CompiledJoinTableMetadata,
  CompiledMetadataGraph,
  CompiledRelationMetadata,
} from "./metadata-graph";
import type { OrmDialect, OrmDriverLike } from "./types";

export interface GeneratedSchemaPlan {
  readonly dialect: OrmDialect;
  readonly tableSqls: readonly string[];
  readonly joinTableSqls: readonly string[];
  readonly deferredForeignKeySqls: readonly string[];
  readonly indexSqls: readonly string[];
  readonly dropSqls: readonly string[];
  readonly hasCyclicForeignKeys: boolean;
}

const UNSAFE_WHERE_PATTERN = /(?:;|--|\/\*|\*\/)/;

function buildColumnSql(
  col: CompiledColumnMetadata,
  dialect: OrmDialect,
  isSinglePrimary: boolean,
): string {
  const profile = getDialectProfile(dialect);
  const quoted = quoteIdentifier(col.columnName, dialect, "column name");
  const isAutoInc =
    col.primary &&
    col.generated &&
    col.generationStrategy === "increment" &&
    isSinglePrimary;

  if (isAutoInc) {
    return profile.autoIncrementColumnSql(col, quoted);
  }

  const parts: string[] = [quoted, profile.columnSqlType(col)];

  // Spanner declares PRIMARY KEY outside the parenthesized column list
  if (col.primary && isSinglePrimary && dialect !== "spanner") {
    parts.push("PRIMARY KEY");
  } else {
    if (!col.nullable) {
      parts.push("NOT NULL");
    }
    if (col.unique && dialect !== "spanner") {
      parts.push("UNIQUE");
    }
  }

  const def = profile.formatDefault(col);
  if (def !== undefined) {
    parts.push(def);
  }

  return parts.join(" ");
}

function buildInlineForeignKeyClause(
  rel: CompiledRelationMetadata,
  targetMeta: CompiledEntityMetadata,
  dialect: OrmDialect,
): string {
  const profile = getDialectProfile(dialect);
  const fkCol = quoteIdentifier(rel.joinColumnName!, dialect, "foreign key column");
  const targetRef = formatTableRef(targetMeta.tableName, targetMeta.schema, dialect);
  const refCol = quoteIdentifier(
    rel.referencedColumnName ?? targetMeta.primaryColumn.columnName,
    dialect,
    "referenced column",
  );
  const constraintName = rel.foreignKeyConstraintName
    ? `CONSTRAINT ${quoteIdentifier(rel.foreignKeyConstraintName, dialect, "constraint name")} `
    : "";
  const deferrable = profile.supportsDeferrableForeignKeys
    ? " DEFERRABLE INITIALLY DEFERRED"
    : "";

  if (dialect === "spanner") {
    return `${constraintName}FOREIGN KEY (${fkCol}) REFERENCES ${targetRef} (${refCol})`;
  }
  if (dialect === "oracle") {
    const onDel = rel.onDelete === "CASCADE" || rel.onDelete === "SET NULL"
      ? ` ON DELETE ${rel.onDelete}`
      : "";
    return `${constraintName}FOREIGN KEY (${fkCol}) REFERENCES ${targetRef} (${refCol})${onDel}${deferrable}`;
  }

  return `${constraintName}FOREIGN KEY (${fkCol}) REFERENCES ${targetRef} (${refCol}) ON DELETE ${rel.onDelete} ON UPDATE ${rel.onUpdate}${deferrable}`;
}

function buildDeferredForeignKeySql(
  ownerMeta: CompiledEntityMetadata,
  rel: CompiledRelationMetadata,
  targetMeta: CompiledEntityMetadata,
  dialect: OrmDialect,
): string {
  const ownerRef = formatTableRef(ownerMeta.tableName, ownerMeta.schema, dialect);
  const clause = buildInlineForeignKeyClause(rel, targetMeta, dialect);
  return `ALTER TABLE ${ownerRef} ADD ${clause}`;
}

function buildJoinTableSql(
  jt: CompiledJoinTableMetadata,
  graph: CompiledMetadataGraph,
  dialect: OrmDialect,
): string {
  const profile = getDialectProfile(dialect);
  const ownerMeta = graph.get(jt.ownerEntityName);
  const targetMeta = graph.get(jt.targetEntityName);

  const ownerRefCol =
    ownerMeta.columnsByColumnName.get(jt.joinReferencedColumnName) ??
    ownerMeta.primaryColumn;
  const targetRefCol =
    targetMeta.columnsByColumnName.get(jt.inverseReferencedColumnName) ??
    targetMeta.primaryColumn;

  const jtRef = formatTableRef(jt.tableName, ownerMeta.schema, dialect);
  const colA = quoteIdentifier(jt.joinColumnName, dialect, "join column");
  const colB = quoteIdentifier(
    jt.inverseJoinColumnName,
    dialect,
    "inverse join column",
  );
  const typeA = profile.columnSqlType(ownerRefCol);
  const typeB = profile.columnSqlType(targetRefCol);
  const ownerTableRef = formatTableRef(
    ownerMeta.tableName,
    ownerMeta.schema,
    dialect,
  );
  const targetTableRef = formatTableRef(
    targetMeta.tableName,
    targetMeta.schema,
    dialect,
  );
  const ownerPkQuoted = quoteIdentifier(
    ownerRefCol.columnName,
    dialect,
    "referenced column",
  );
  const targetPkQuoted = quoteIdentifier(
    targetRefCol.columnName,
    dialect,
    "referenced column",
  );

  const fkClauseA =
    dialect === "spanner"
      ? `FOREIGN KEY (${colA}) REFERENCES ${ownerTableRef} (${ownerPkQuoted})`
      : dialect === "oracle"
        ? `FOREIGN KEY (${colA}) REFERENCES ${ownerTableRef} (${ownerPkQuoted}) ON DELETE CASCADE`
        : `FOREIGN KEY (${colA}) REFERENCES ${ownerTableRef} (${ownerPkQuoted}) ON DELETE ${jt.onDelete} ON UPDATE ${jt.onUpdate}`;

  const fkClauseB =
    dialect === "spanner"
      ? `FOREIGN KEY (${colB}) REFERENCES ${targetTableRef} (${targetPkQuoted})`
      : dialect === "oracle"
        ? `FOREIGN KEY (${colB}) REFERENCES ${targetTableRef} (${targetPkQuoted}) ON DELETE CASCADE`
        : `FOREIGN KEY (${colB}) REFERENCES ${targetTableRef} (${targetPkQuoted}) ON DELETE ${jt.onDelete} ON UPDATE ${jt.onUpdate}`;

  if (dialect === "spanner") {
    const lines = [`${colA} ${typeA} NOT NULL`, `${colB} ${typeB} NOT NULL`, fkClauseA, fkClauseB];
    return `${profile.formatCreateTablePrefix(jtRef)} (\n  ${lines.join(",\n  ")}\n) PRIMARY KEY (${colA}, ${colB})`;
  }

  const lines = [
    `${colA} ${typeA} NOT NULL`,
    `${colB} ${typeB} NOT NULL`,
    `PRIMARY KEY (${colA}, ${colB})`,
    fkClauseA,
    fkClauseB,
  ];

  return `${profile.formatCreateTablePrefix(jtRef)} (\n  ${lines.join(",\n  ")}\n)`;
}

function buildIndexSql(
  entity: CompiledEntityMetadata,
  idx: CompiledIndexMetadata,
  dialect: OrmDialect,
): string {
  const profile = getDialectProfile(dialect);
  const tableRef = formatTableRef(entity.tableName, entity.schema, dialect);
  const idxName = quoteIdentifier(idx.name, dialect, "index name");
  const cols = idx.columns
    .map((c) => quoteIdentifier(c, dialect, "index column"))
    .join(", ");

  let whereClause = "";
  if (idx.where && idx.where.trim().length > 0) {
    if (UNSAFE_WHERE_PATTERN.test(idx.where)) {
      throw new Error(
        `Unsafe WHERE clause in index "${idx.name}" on table "${entity.tableName}".`,
      );
    }
    if (profile.supportsPartialIndexWhere) {
      whereClause = ` WHERE ${idx.where.trim()}`;
    }
  }

  return `${profile.formatCreateIndexPrefix(idx.unique, idxName)} ON ${tableRef} (${cols})${whereClause}`;
}

/**
 * Generates a complete, cycle-aware DDL schema plan for ANY of the 11 SQL dialects
 * (`sqlite`, `libsql`, `d1`, `postgres`, `cockroachdb`, `mysql`, `mariadb`,
 * `mssql`, `oracle`, `sap`, `spanner`).
 */
export function generateSchemaPlan(
  graph: CompiledMetadataGraph,
  dialect: OrmDialect = "sqlite",
): GeneratedSchemaPlan {
  const profile = getDialectProfile(dialect);
  if (profile.isDocumentStore) {
    return {
      dialect,
      tableSqls: [],
      joinTableSqls: [],
      deferredForeignKeySqls: [],
      indexSqls: [],
      dropSqls: [],
      hasCyclicForeignKeys: false,
    };
  }

  const tableSqls: string[] = [];
  const deferredForeignKeySqls: string[] = [];
  const indexSqls: string[] = [];

  for (const entity of graph.creationOrder) {
    const tableRef = formatTableRef(entity.tableName, entity.schema, dialect);
    const isSinglePrimary = entity.primaryColumns.length === 1;

    const definitions: string[] = entity.columns.map((col) =>
      buildColumnSql(col, dialect, isSinglePrimary),
    );

    if (entity.primaryColumns.length > 1 && dialect !== "spanner") {
      const pkCols = entity.primaryColumns
        .map((c) => quoteIdentifier(c.columnName, dialect, "primary key column"))
        .join(", ");
      definitions.push(`PRIMARY KEY (${pkCols})`);
    }

    for (const rel of entity.relations) {
      if (
        !rel.isOwning ||
        !rel.joinColumnName ||
        !rel.createForeignKeyConstraints
      ) {
        continue;
      }
      const targetMeta = graph.byTarget.get(rel.target);
      if (!targetMeta) continue;

      const edgeKey = `${entity.tableName}.${rel.joinColumnName}`;
      const isCyclic = graph.cyclicForeignKeys.has(edgeKey);

      if (
        isCyclic &&
        dialect !== "sqlite" &&
        dialect !== "libsql" &&
        dialect !== "d1"
      ) {
        deferredForeignKeySqls.push(
          buildDeferredForeignKeySql(entity, rel, targetMeta, dialect),
        );
      } else {
        definitions.push(buildInlineForeignKeyClause(rel, targetMeta, dialect));
      }
    }

    if (dialect === "spanner") {
      const pkCols = entity.primaryColumns
        .map((c) => quoteIdentifier(c.columnName, dialect, "primary key column"))
        .join(", ");
      tableSqls.push(
        `${profile.formatCreateTablePrefix(tableRef)} (\n  ${definitions.join(",\n  ")}\n) PRIMARY KEY (${pkCols})`,
      );
    } else {
      tableSqls.push(
        `${profile.formatCreateTablePrefix(tableRef)} (\n  ${definitions.join(",\n  ")}\n)`,
      );
    }

    for (const idx of entity.indexes) {
      indexSqls.push(buildIndexSql(entity, idx, dialect));
    }
  }

  const joinTableSqls = graph.joinTables.map((jt) =>
    buildJoinTableSql(jt, graph, dialect),
  );

  const dropSqls: string[] = [];
  const dropSuffix = profile.supportsDropCascade ? " CASCADE" : "";
  for (const jt of graph.joinTables) {
    const ownerMeta = graph.get(jt.ownerEntityName);
    const jtRef = formatTableRef(jt.tableName, ownerMeta.schema, dialect);
    dropSqls.push(`DROP TABLE IF EXISTS ${jtRef}${dropSuffix}`);
  }
  for (let i = graph.creationOrder.length - 1; i >= 0; i--) {
    const entity = graph.creationOrder[i]!;
    const tableRef = formatTableRef(entity.tableName, entity.schema, dialect);
    dropSqls.push(`DROP TABLE IF EXISTS ${tableRef}${dropSuffix}`);
  }

  return {
    dialect,
    tableSqls,
    joinTableSqls,
    deferredForeignKeySqls,
    indexSqls,
    dropSqls,
    hasCyclicForeignKeys: graph.cyclicForeignKeys.size > 0,
  };
}

/**
 * Executes `synchronize()` or `dropSchema()` against ANY `OrmDriver` (SQL or MongoDB).
 */
export class SchemaBuilder {
  constructor(
    private readonly driver: OrmDriverLike,
    private readonly graph: CompiledMetadataGraph,
    private readonly enforceForeignKeys: boolean = true,
  ) {}

  getPlan(): GeneratedSchemaPlan {
    return generateSchemaPlan(this.graph, this.driver.dialect);
  }

  async dropSchema(): Promise<void> {
    if (isDocumentDriver(this.driver)) {
      for (const entity of this.graph.entities) {
        await this.driver.dropCollection(entity.tableName);
      }
      return;
    }

    const plan = this.getPlan();
    await this.withDisabledForeignKeys(async () => {
      for (const sql of plan.dropSqls) {
        await this.driver.execute(sql);
      }
    });
  }

  async synchronize(dropBeforeSync = false): Promise<void> {
    if (isDocumentDriver(this.driver)) {
      if (dropBeforeSync) {
        await this.dropSchema();
      }
      for (const entity of this.graph.entities) {
        await this.driver.ensureCollection(entity.tableName);
        if (this.driver.docCreateIndex) {
          for (const idx of entity.indexes) {
            const keys: Record<string, 1 | -1> = {};
            for (const c of idx.columns) keys[c] = 1;
            await this.driver.docCreateIndex(entity.tableName, keys, {
              unique: idx.unique,
              name: idx.name,
            });
          }
        }
      }
      return;
    }

    const plan = this.getPlan();
    await this.withDisabledForeignKeys(async () => {
      if (dropBeforeSync) {
        for (const sql of plan.dropSqls) {
          await this.driver.execute(sql);
        }
      }
      for (const sql of plan.tableSqls) {
        await this.driver.execute(sql);
      }
      for (const sql of plan.joinTableSqls) {
        await this.driver.execute(sql);
      }
      for (const sql of plan.deferredForeignKeySqls) {
        try {
          await this.driver.execute(sql);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already exists|duplicate/i.test(msg)) {
            throw err;
          }
        }
      }
      for (const sql of plan.indexSqls) {
        await this.driver.execute(sql);
      }
    });
  }

  private async withDisabledForeignKeys(fn: () => Promise<void>): Promise<void> {
    const profile = getDialectProfile(this.driver.dialect);
    if (
      profile.fkSyncStrategy === "sqlite-pragma" &&
      this.driver.setForeignKeysEnabled
    ) {
      await this.driver.setForeignKeysEnabled(false);
      try {
        await fn();
      } finally {
        if (this.enforceForeignKeys) {
          await this.driver.setForeignKeysEnabled(true);
        }
      }
      return;
    }

    if (profile.fkSyncStrategy === "mysql-fk-checks") {
      await this.driver.execute("SET FOREIGN_KEY_CHECKS = 0");
      try {
        await fn();
      } finally {
        await this.driver.execute("SET FOREIGN_KEY_CHECKS = 1");
      }
      return;
    }

    await fn();
  }
}
