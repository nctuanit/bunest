import { Database } from "bun:sqlite";

export type Dialect =
  | "mysql"
  | "postgres"
  | "sqlite"
  | "mariadb"
  | "mssql"
  | "db2"
  | "snowflake"
  | "oracle"
  | (string & {});

export type ModelMatch = (filename: string, member: string) => boolean;

export type TransactionType = "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE";

export interface PoolOptions {
  max?: number;
  min?: number;
  idle?: number;
  acquire?: number;
  evict?: number;
  validate?: (client?: unknown) => boolean;
  maxUses?: number;
}

export interface SyncOptions {
  force?: boolean;
  match?: RegExp;
  logging?: boolean | ((sql: string, timing?: number) => void);
  schema?: string;
  searchPath?: string;
  hooks?: boolean;
  alter?: boolean | { drop?: boolean };
}

export interface QueryOptions {
  raw?: boolean;
  type?: string;
  replacements?: Record<string, unknown> | unknown[];
  bind?: Record<string, unknown> | unknown[];
  transaction?: SequelizeTransactionLike | null;
  logging?: boolean | ((sql: string, timing?: number) => void);
  benchmark?: boolean;
  [key: string]: unknown;
}

export interface DefaultSetOptions {
  [key: string]: unknown;
}

export interface ReplicationOptions {
  write: Record<string, unknown>;
  read: Array<Record<string, unknown>>;
}

export type OperatorsAliases = Record<string, symbol | string>;

export interface SequelizeHooks<
  _TModel = any,
  _TAttributes = any,
  _TCreationAttributes = any,
> {
  beforeValidate?: (...args: any[]) => unknown;
  afterValidate?: (...args: any[]) => unknown;
  beforeCreate?: (...args: any[]) => unknown;
  afterCreate?: (...args: any[]) => unknown;
  beforeDestroy?: (...args: any[]) => unknown;
  afterDestroy?: (...args: any[]) => unknown;
  beforeUpdate?: (...args: any[]) => unknown;
  afterUpdate?: (...args: any[]) => unknown;
  beforeSave?: (...args: any[]) => unknown;
  afterSave?: (...args: any[]) => unknown;
  beforeSync?: (...args: any[]) => unknown;
  afterSync?: (...args: any[]) => unknown;
  [hookName: string]: ((...args: any[]) => unknown) | undefined;
}

export interface RetryOptions {
  max?: number;
  match?: Array<string | RegExp | Error | (new (...args: any[]) => Error)>;
  backoffBase?: number;
  backoffExponent?: number;
  report?: (message: string, obj: Record<string, unknown>, err?: unknown) => void;
  name?: string;
}

export interface ModelOptions<_TModel = any> {
  tableName?: string;
  modelName?: string;
  timestamps?: boolean;
  paranoid?: boolean;
  underscored?: boolean;
  freezeTableName?: boolean;
  schema?: string;
  hooks?: Partial<SequelizeHooks>;
  [key: string]: unknown;
}

export interface FindOptionsLike<T = Record<string, any>> {
  where?: Partial<T> & Record<string, any>;
  order?: Array<[string, "ASC" | "DESC" | "asc" | "desc"]>;
  offset?: number;
  limit?: number;
  attributes?: string[];
  raw?: boolean;
  transaction?: SequelizeTransactionLike;
}

export interface SequelizeTransactionLike {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface ModelCtor<M extends Model = Model> {
  new (...args: any[]): M;
  name: string;
  tableName?: string;
  sequelize?: SequelizeLike;
}

export interface SequelizeOptions {
  name?: string;
  models?: string[] | ModelCtor[];
  modelPaths?: string[];
  modelMatch?: ModelMatch;
  repositoryMode?: boolean;
  validateOnly?: boolean;
  dialect?: Dialect;
  dialectModule?: object;
  dialectModulePath?: string;
  dialectOptions?: object;
  storage?: string;
  database?: string;
  username?: string;
  password?: string;
  host?: string;
  port?: number;
  ssl?: boolean;
  protocol?: string;
  define?: ModelOptions<Model<any, any>>;
  query?: QueryOptions;
  set?: DefaultSetOptions;
  sync?: SyncOptions;
  timezone?: string;
  omitNull?: boolean;
  native?: boolean;
  replication?: false | ReplicationOptions;
  pool?: PoolOptions;
  quoteIdentifiers?: boolean;
  isolationLevel?: string;
  transactionType?: TransactionType;
  typeValidation?: boolean;
  operatorsAliases?: OperatorsAliases;
  standardConformingStrings?: boolean;
  clientMinMessages?: string | boolean;
  hooks?: Partial<SequelizeHooks<Model<any, any>, any, any>>;
  minifyAliases?: boolean;
  logQueryParameters?: boolean;
  retry?: RetryOptions;
  schema?: string;
  attributeBehavior?: "throw" | "escape" | "unsafe-legacy";
  logging?: boolean | ((sql: string, timing?: number) => void);
  benchmark?: boolean;
}

export interface SequelizeRepositoryLike<T = Record<string, any>> {
  readonly model: Function;
  readonly tableName: string;
  create(values: Partial<T>): Promise<T>;
  bulkCreate(records: Array<Partial<T>>): Promise<T[]>;
  findAll(options?: FindOptionsLike<T>): Promise<T[]>;
  findOne(options?: FindOptionsLike<T>): Promise<T | null>;
  findByPk(identifier: string | number): Promise<T | null>;
  findAndCountAll(
    options?: FindOptionsLike<T>,
  ): Promise<{ rows: T[]; count: number }>;
  update(
    values: Partial<T>,
    options: { where: Partial<T> & Record<string, any> },
  ): Promise<[number]>;
  destroy(options: {
    where?: Partial<T> & Record<string, any>;
    truncate?: boolean;
  }): Promise<number>;
  count(options?: FindOptionsLike<T>): Promise<number>;
  upsert(values: Partial<T>): Promise<[T, boolean]>;
}

export interface SequelizeLike {
  readonly options: SequelizeOptions;
  readonly repositoryMode?: boolean;
  readonly models: Record<string, Function>;
  addModels(models: Array<Function | string>): void;
  authenticate(): Promise<void>;
  sync(options?: SyncOptions): Promise<any>;
  close(): Promise<void>;
  getRepository<M extends Function>(model: M): any;
  model(name: string): any;
  query(sql: string, options?: QueryOptions): Promise<[unknown[], unknown]>;
  transaction<T>(
    callback: (t: SequelizeTransactionLike) => Promise<T>,
  ): Promise<T>;
}

function sanitizeIdent(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

function matchesWhere(
  row: Record<string, any>,
  where?: Record<string, any>,
): boolean {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (expected === undefined) continue;
    if (row[key] !== expected) return false;
  }
  return true;
}

export class Model<
  TModelAttributes extends Record<string, any> = any,
  _TCreationAttributes extends Record<string, any> = TModelAttributes,
> {
  static sequelize?: Sequelize;
  static tableName?: string;

  [key: string]: any;

  constructor(values?: Partial<TModelAttributes>) {
    if (values) {
      Object.assign(this, values);
    }
  }

  private static requireRepo<T extends Record<string, any>>(
    this: typeof Model,
  ): SequelizeRepository<T> {
    if (!this.sequelize) {
      throw new Error(
        `Model "${this.name}" is not attached to a Sequelize connection. Register it via SequelizeModule.forFeature([${this.name}]) with autoLoadModels: true or options.models.`,
      );
    }
    return this.sequelize.getRepository(this) as SequelizeRepository<T>;
  }

  static create<T extends Record<string, any> = any>(
    values: Record<string, any>,
  ): Promise<T> {
    return this.requireRepo<T>().create(values as Partial<T>);
  }

  static bulkCreate<T extends Record<string, any> = any>(
    records: Array<Record<string, any>>,
  ): Promise<T[]> {
    return this.requireRepo<T>().bulkCreate(records as Array<Partial<T>>);
  }

  static findAll<T extends Record<string, any> = any>(
    options?: FindOptionsLike<T>,
  ): Promise<T[]> {
    return this.requireRepo<T>().findAll(options);
  }

  static findOne<T extends Record<string, any> = any>(
    options?: FindOptionsLike<T>,
  ): Promise<T | null> {
    return this.requireRepo<T>().findOne(options);
  }

  static findByPk<T extends Record<string, any> = any>(
    identifier: string | number,
  ): Promise<T | null> {
    return this.requireRepo<T>().findByPk(identifier);
  }

  static findAndCountAll<T extends Record<string, any> = any>(
    options?: FindOptionsLike<T>,
  ): Promise<{ rows: T[]; count: number }> {
    return this.requireRepo<T>().findAndCountAll(options);
  }

  static update<T extends Record<string, any> = any>(
    values: Partial<T>,
    options: { where: Partial<T> & Record<string, any> },
  ): Promise<[number]> {
    return this.requireRepo<T>().update(values, options);
  }

  static destroy<T extends Record<string, any> = any>(options: {
    where?: Partial<T> & Record<string, any>;
    truncate?: boolean;
  }): Promise<number> {
    return this.requireRepo<T>().destroy(options);
  }

  static count<T extends Record<string, any> = any>(
    options?: FindOptionsLike<T>,
  ): Promise<number> {
    return this.requireRepo<T>().count(options);
  }

  static upsert<T extends Record<string, any> = any>(
    values: Partial<T>,
  ): Promise<[T, boolean]> {
    return this.requireRepo<T>().upsert(values);
  }
}

export class SequelizeRepository<T extends Record<string, any> = any>
  implements SequelizeRepositoryLike<T>
{
  readonly model: Function;
  readonly tableName: string;

  constructor(
    model: Function,
    private readonly connection: Sequelize,
  ) {
    this.model = model;
    const explicit = (model as { tableName?: string }).tableName;
    this.tableName = sanitizeIdent(explicit || model.name || "model");
  }

  private hydrate(raw: Record<string, any>): T {
    try {
      const Ctor = this.model as new (vals?: Record<string, any>) => T;
      const inst = new Ctor(raw);
      return Object.assign(inst, raw);
    } catch {
      return { ...raw } as T;
    }
  }

  async create(values: Partial<T>): Promise<T> {
    const rec: Record<string, any> = { ...values };
    if (rec.id === undefined || rec.id === null) {
      rec.id = this.connection._nextId(this.tableName);
    }
    this.connection._upsert(this.tableName, String(rec.id), rec);
    return this.hydrate(rec);
  }

  async bulkCreate(records: Array<Partial<T>>): Promise<T[]> {
    const out: T[] = [];
    for (const r of records) {
      out.push(await this.create(r));
    }
    return out;
  }

  async findAll(options?: FindOptionsLike<T>): Promise<T[]> {
    let rows = this.connection
      ._getAll(this.tableName)
      .filter((r) => matchesWhere(r, options?.where));

    if (options?.order) {
      rows = [...rows].sort((a, b) => {
        for (const [col, dir] of options.order!) {
          if (a[col] === b[col]) continue;
          const mult = dir.toUpperCase() === "DESC" ? -1 : 1;
          return a[col] < b[col] ? -1 * mult : 1 * mult;
        }
        return 0;
      });
    }

    if (options?.offset !== undefined || options?.limit !== undefined) {
      const start = options.offset ?? 0;
      const end = options.limit !== undefined ? start + options.limit : undefined;
      rows = rows.slice(start, end);
    }

    if (options?.attributes) {
      rows = rows.map((r) => {
        const picked: Record<string, any> = {};
        for (const key of options.attributes!) {
          if (key in r) picked[key] = r[key];
        }
        return picked;
      });
    }

    return options?.raw ? (rows as T[]) : rows.map((r) => this.hydrate(r));
  }

  async findOne(options?: FindOptionsLike<T>): Promise<T | null> {
    const rows = await this.findAll({ ...options, limit: 1 });
    return rows[0] ?? null;
  }

  async findByPk(identifier: string | number): Promise<T | null> {
    return this.findOne({ where: { id: identifier } as unknown as Partial<T> });
  }

  async findAndCountAll(
    options?: FindOptionsLike<T>,
  ): Promise<{ rows: T[]; count: number }> {
    const allMatched = this.connection
      ._getAll(this.tableName)
      .filter((r) => matchesWhere(r, options?.where));
    const rows = await this.findAll(options);
    return { rows, count: allMatched.length };
  }

  async update(
    values: Partial<T>,
    options: { where: Partial<T> & Record<string, any> },
  ): Promise<[number]> {
    const all = this.connection._getAll(this.tableName);
    let count = 0;
    for (const row of all) {
      if (matchesWhere(row, options.where)) {
        const next = { ...row, ...values };
        this.connection._upsert(this.tableName, String(next.id), next);
        count++;
      }
    }
    return [count];
  }

  async destroy(options: {
    where?: Partial<T> & Record<string, any>;
    truncate?: boolean;
  }): Promise<number> {
    if (options.truncate) {
      const existing = this.connection._getAll(this.tableName).length;
      this.connection._clear(this.tableName);
      return existing;
    }
    const all = this.connection._getAll(this.tableName);
    let deleted = 0;
    for (const row of all) {
      if (matchesWhere(row, options.where)) {
        if (this.connection._deleteById(this.tableName, String(row.id))) {
          deleted++;
        }
      }
    }
    return deleted;
  }

  async count(options?: FindOptionsLike<T>): Promise<number> {
    return this.connection
      ._getAll(this.tableName)
      .filter((r) => matchesWhere(r, options?.where)).length;
  }

  async upsert(values: Partial<T>): Promise<[T, boolean]> {
    const rec: Record<string, any> = { ...values };
    const existed =
      rec.id !== undefined &&
      rec.id !== null &&
      (await this.findByPk(rec.id)) !== null;
    if (rec.id === undefined || rec.id === null) {
      rec.id = this.connection._nextId(this.tableName);
    }
    this.connection._upsert(this.tableName, String(rec.id), rec);
    return [this.hydrate(rec), !existed];
  }
}

export class Sequelize implements SequelizeLike {
  readonly options: SequelizeOptions;
  readonly repositoryMode: boolean;
  readonly models: Record<string, Function> = {};

  isAuthenticated = false;
  isSynced = false;
  isClosed = false;

  private db?: Database;
  private readonly ensuredTables = new Set<string>();
  private readonly sequences = new Map<string, number>();
  private readonly repositories = new Map<Function, SequelizeRepository<any>>();
  private savepointDepth = 0;

  constructor(options?: SequelizeOptions);
  constructor(uri: string, options?: SequelizeOptions);
  constructor(
    uriOrOptions?: string | SequelizeOptions,
    maybeOptions?: SequelizeOptions,
  ) {
    if (typeof uriOrOptions === "string") {
      this.options = { ...(maybeOptions ?? {}), storage: maybeOptions?.storage };
    } else {
      this.options = { ...(uriOrOptions ?? {}) };
    }
    this.repositoryMode = Boolean(this.options.repositoryMode);

    if (Array.isArray(this.options.models)) {
      this.addModels(this.options.models);
    }
  }

  private getDb(): Database {
    if (this.isClosed) {
      throw new Error("Sequelize connection has been closed.");
    }
    if (!this.db) {
      const storage =
        this.options.dialect === "sqlite" || !this.options.dialect
          ? this.options.storage || ":memory:"
          : ":memory:";
      this.db = new Database(storage);
    }
    return this.db;
  }

  private physicalTable(tableName: string): string {
    return `__bunest_seq_${sanitizeIdent(tableName)}`;
  }

  private ensureTable(tableName: string): void {
    const physical = this.physicalTable(tableName);
    if (this.ensuredTables.has(physical)) return;
    this.getDb().run(
      `CREATE TABLE IF NOT EXISTS "${physical}" (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
    );
    this.ensuredTables.add(physical);
  }

  /** @internal */
  _getAll(tableName: string): Array<Record<string, any>> {
    this.ensureTable(tableName);
    const physical = this.physicalTable(tableName);
    const rows = this.getDb()
      .query(`SELECT payload FROM "${physical}" ORDER BY rowid ASC`)
      .all() as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as Record<string, any>);
  }

  /** @internal */
  _upsert(tableName: string, id: string, record: Record<string, any>): void {
    this.ensureTable(tableName);
    const physical = this.physicalTable(tableName);
    this.getDb()
      .query(
        `INSERT INTO "${physical}" (id, payload) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
      )
      .run(id, JSON.stringify(record));
  }

  /** @internal */
  _deleteById(tableName: string, id: string): boolean {
    this.ensureTable(tableName);
    const physical = this.physicalTable(tableName);
    const res = this.getDb()
      .query(`DELETE FROM "${physical}" WHERE id = ?1`)
      .run(id);
    return (res.changes ?? 0) > 0;
  }

  /** @internal */
  _clear(tableName: string): void {
    this.ensureTable(tableName);
    const physical = this.physicalTable(tableName);
    this.getDb().run(`DELETE FROM "${physical}"`);
  }

  /** @internal */
  _nextId(tableName: string): number {
    const next = (this.sequences.get(tableName) ?? 0) + 1;
    this.sequences.set(tableName, next);
    return next;
  }

  addModels(models: Array<Function | string>): void {
    for (const model of models) {
      if (typeof model !== "function") continue;
      const modelName = model.name || "Model";
      this.models[modelName] = model;
      if (!this.repositoryMode) {
        (model as { sequelize?: Sequelize }).sequelize = this;
      }
      if (!this.repositories.has(model)) {
        this.repositories.set(model, new SequelizeRepository(model, this));
      }
    }
  }

  async authenticate(): Promise<void> {
    this.getDb().query("SELECT 1 AS ok").get();
    this.isAuthenticated = true;
  }

  async sync(options?: SyncOptions): Promise<this> {
    const db = this.getDb();
    for (const model of Object.values(this.models)) {
      const explicit = (model as { tableName?: string }).tableName;
      const tableName = sanitizeIdent(explicit || model.name || "model");
      this.ensureTable(tableName);
      if (options?.force) {
        db.run(`DELETE FROM "${this.physicalTable(tableName)}"`);
      }
    }
    this.isSynced = true;
    return this;
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.ensuredTables.clear();
    this.db?.close();
    this.db = undefined;
  }

  getRepository<M extends Function>(model: M): SequelizeRepository<any> {
    let repo = this.repositories.get(model);
    if (!repo) {
      repo = new SequelizeRepository(model, this);
      this.repositories.set(model, repo);
      if (model.name) {
        this.models[model.name] = model;
      }
    }
    return repo;
  }

  model(name: string): Function | SequelizeRepository<any> {
    const found = this.models[name];
    if (!found) {
      throw new Error(`Model "${name}" has not been defined on this Sequelize instance.`);
    }
    return this.repositoryMode ? this.getRepository(found) : found;
  }

  async query(
    sql: string,
    options?: QueryOptions,
  ): Promise<[unknown[], unknown]> {
    const db = this.getDb();
    const params = Array.isArray(options?.bind)
      ? options.bind
      : Array.isArray(options?.replacements)
        ? options.replacements
        : [];
    const trimmed = sql.trim().toUpperCase();
    const stmt = db.query(sql);
    if (
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("WITH") ||
      trimmed.includes("RETURNING")
    ) {
      const rows = stmt.all(...(params as any[]));
      return [rows, rows];
    }
    const meta = stmt.run(...(params as any[]));
    return [[], meta];
  }

  async transaction<T>(
    callback: (t: SequelizeTransactionLike) => Promise<T>,
  ): Promise<T> {
    const db = this.getDb();
    const depth = this.savepointDepth;
    if (depth === 0) {
      db.run("BEGIN TRANSACTION");
    } else {
      db.run(`SAVEPOINT sp_${depth}`);
    }
    this.savepointDepth++;

    let finished = false;
    const tx: SequelizeTransactionLike = {
      commit: async () => {
        if (finished) return;
        finished = true;
        this.savepointDepth--;
        if (this.savepointDepth === 0) {
          db.run("COMMIT");
        } else {
          db.run(`RELEASE SAVEPOINT sp_${this.savepointDepth}`);
        }
      },
      rollback: async () => {
        if (finished) return;
        finished = true;
        this.savepointDepth--;
        if (this.savepointDepth === 0) {
          db.run("ROLLBACK");
        } else {
          db.run(`ROLLBACK TO SAVEPOINT sp_${this.savepointDepth}`);
        }
      },
    };

    try {
      const result = await callback(tx);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }
}
