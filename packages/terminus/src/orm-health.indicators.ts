import {
  Injectable,
  Optional,
  Scope,
  type OnModuleInit,
} from "@bunest/common";
import { ModuleRef } from "@bunest/core";
import {
  HealthIndicator,
  HealthIndicatorService,
  type HealthCheckAttempt,
} from "@bunest/observability";

/**
 * Thrown when a database health check detects a disconnected client/connection.
 */
export class DatabaseNotConnectedError extends Error {
  constructor(message = "Database is not connected") {
    super(message);
    this.name = "DatabaseNotConnectedError";
  }
}

function tryResolveFromModuleRef(
  moduleRef: ModuleRef | undefined,
  tokens: readonly string[],
): any {
  if (!moduleRef) {
    return null;
  }
  for (const token of tokens) {
    try {
      const resolved = moduleRef.get(token, { strict: false });
      if (resolved) {
        return resolved;
      }
    } catch {
      // Try next fallback token
    }
  }
  return null;
}

function extractErrorCode(error: unknown): string | number | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") {
      return code;
    }
  }
  return undefined;
}

// ============================================================================
// TypeOrmHealthIndicator (Zero-Dep Structural Duck-Typing)
// ============================================================================

export interface TypeOrmConnectionLike {
  options?: { type?: string };
  query?: (sql: string) => Promise<unknown> | unknown;
  driver?: {
    queryRunner?: {
      databaseConnection?: {
        db?: () => {
          command: (cmd: Record<string, unknown>) => Promise<unknown> | unknown;
        };
      };
    };
  };
  isInitialized?: boolean;
}

export interface TypeOrmPingCheckSettings {
  /**
   * The connection/DataSource on which the ping check should be executed.
   */
  connection?: TypeOrmConnectionLike | any;
  /**
   * The amount of time the check should require in ms.
   * @deprecated Chain `.withTimeout(ms)` on the returned attempt instead.
   */
  timeout?: number;
}

/**
 * Checks TypeORM `DataSource`/`Connection` health without requiring `typeorm`
 * or `@nestjs/typeorm` as runtime dependencies.
 */
@Injectable({ scope: Scope.TRANSIENT })
export class TypeOrmHealthIndicator
  extends HealthIndicator
  implements OnModuleInit
{
  private readonly healthIndicatorService: HealthIndicatorService;

  constructor(
    @Optional()
    private readonly moduleRef?: ModuleRef,
    @Optional()
    healthIndicatorService?: HealthIndicatorService,
  ) {
    super();
    this.healthIndicatorService =
      healthIndicatorService ?? new HealthIndicatorService();
  }

  async onModuleInit(): Promise<void> {
    // Zero-dep structural indicator requires no external peer loading.
  }

  private getContextConnection(): any {
    return tryResolveFromModuleRef(this.moduleRef, [
      "DataSource",
      "defaultDataSource",
      "Connection",
      "TYPEORM_DATA_SOURCE",
    ]);
  }

  private async pingDb(connection: TypeOrmConnectionLike): Promise<void> {
    if (connection.isInitialized === false) {
      throw new DatabaseNotConnectedError("TypeORM connection is not initialized");
    }

    switch (connection.options?.type) {
      case "mongodb": {
        const db = connection.driver?.queryRunner?.databaseConnection?.db?.();
        if (!db || typeof db.command !== "function") {
          throw new Error(
            "TypeORM MongoDB connection does not expose driver.queryRunner.databaseConnection.db().command()",
          );
        }
        await db.command({ ping: 1 });
        return;
      }
      case "oracle":
        if (typeof connection.query !== "function") {
          throw new Error("TypeORM connection must implement query()");
        }
        await connection.query("SELECT 1 FROM DUAL");
        return;
      case "sap":
        if (typeof connection.query !== "function") {
          throw new Error("TypeORM connection must implement query()");
        }
        await connection.query("SELECT now() FROM dummy");
        return;
      default:
        if (typeof connection.query !== "function") {
          throw new Error("TypeORM connection must implement query()");
        }
        await connection.query("SELECT 1");
    }
  }

  pingCheck<Key extends string = string>(
    key: Key,
    options: TypeOrmPingCheckSettings = {},
  ): HealthCheckAttempt<Key, void, {}, undefined, { code?: string | number }> {
    return this.healthIndicatorService
      .check(key)
      .attempt(async () => {
        const connection = options.connection ?? this.getContextConnection();
        if (!connection) {
          throw new Error(
            "Connection provider not found in application context",
          );
        }
        await this.pingDb(connection);
      })
      .withFailureData((error) => ({
        code: extractErrorCode(error),
      }))
      .withTimeout(options.timeout ?? 1000);
  }
}

// ============================================================================
// MongooseHealthIndicator (Zero-Dep Structural Duck-Typing)
// ============================================================================

export interface MongooseConnectionLike {
  readyState: number;
  db?: {
    command?: (cmd: Record<string, unknown>) => Promise<unknown> | unknown;
    admin?: () => {
      ping?: () => Promise<unknown> | unknown;
    };
  };
  ping?: () => Promise<unknown> | unknown;
}

export interface MongoosePingCheckSettings {
  /**
   * The Mongoose connection on which the ping check should be executed.
   */
  connection?: MongooseConnectionLike | any;
  /**
   * The amount of time the check should require in ms.
   * @deprecated Chain `.withTimeout(ms)` on the returned attempt instead.
   */
  timeout?: number;
}

/**
 * Checks MongoDB/Mongoose connection health without requiring `mongoose`
 * or `@nestjs/mongoose` as runtime dependencies.
 */
@Injectable({ scope: Scope.TRANSIENT })
export class MongooseHealthIndicator
  extends HealthIndicator
  implements OnModuleInit
{
  private readonly healthIndicatorService: HealthIndicatorService;

  constructor(
    @Optional()
    private readonly moduleRef?: ModuleRef,
    @Optional()
    healthIndicatorService?: HealthIndicatorService,
  ) {
    super();
    this.healthIndicatorService =
      healthIndicatorService ?? new HealthIndicatorService();
  }

  async onModuleInit(): Promise<void> {
    // Zero-dep structural indicator requires no external peer loading.
  }

  private getContextConnection(): any {
    return tryResolveFromModuleRef(this.moduleRef, [
      "DatabaseConnection",
      "MongooseConnection",
      "MONGOOSE_CONNECTION",
    ]);
  }

  private async pingDb(connection: MongooseConnectionLike): Promise<void> {
    if (connection.readyState !== 1) {
      throw new DatabaseNotConnectedError();
    }
    if (typeof connection.db?.command === "function") {
      await connection.db.command({ ping: 1 });
      return;
    }
    if (typeof connection.db?.admin === "function") {
      const admin = connection.db.admin();
      if (typeof admin?.ping === "function") {
        await admin.ping();
        return;
      }
    }
    if (typeof connection.ping === "function") {
      await connection.ping();
    }
  }

  pingCheck<Key extends string = string>(
    key: Key,
    options: MongoosePingCheckSettings = {},
  ): HealthCheckAttempt<Key, void, {}, undefined, { code?: string | number }> {
    return this.healthIndicatorService
      .check(key)
      .attempt(async () => {
        const connection = options.connection ?? this.getContextConnection();
        if (!connection) {
          throw new Error(
            "Connection provider not found in application context",
          );
        }
        await this.pingDb(connection);
      })
      .withFailureData((error) => ({
        code: extractErrorCode(error),
      }))
      .withTimeout(options.timeout ?? 1000);
  }
}

// ============================================================================
// SequelizeHealthIndicator (Zero-Dep Structural Duck-Typing)
// ============================================================================

export interface SequelizeConnectionLike {
  query?: (sql: string) => Promise<unknown> | unknown;
  authenticate?: () => Promise<unknown> | unknown;
}

export interface SequelizePingCheckSettings {
  /**
   * The Sequelize instance on which the ping check should be executed.
   */
  connection?: SequelizeConnectionLike | any;
  /**
   * The amount of time the check should require in ms.
   * @deprecated Chain `.withTimeout(ms)` on the returned attempt instead.
   */
  timeout?: number;
}

/**
 * Checks Sequelize connection health without requiring `sequelize`
 * or `@nestjs/sequelize` as runtime dependencies.
 */
@Injectable({ scope: Scope.TRANSIENT })
export class SequelizeHealthIndicator
  extends HealthIndicator
  implements OnModuleInit
{
  private readonly healthIndicatorService: HealthIndicatorService;

  constructor(
    @Optional()
    private readonly moduleRef?: ModuleRef,
    @Optional()
    healthIndicatorService?: HealthIndicatorService,
  ) {
    super();
    this.healthIndicatorService =
      healthIndicatorService ?? new HealthIndicatorService();
  }

  async onModuleInit(): Promise<void> {
    // Zero-dep structural indicator requires no external peer loading.
  }

  private getContextConnection(): any {
    return tryResolveFromModuleRef(this.moduleRef, [
      "Sequelize",
      "defaultConnection",
      "SEQUELIZE",
    ]);
  }

  private async pingDb(connection: SequelizeConnectionLike): Promise<void> {
    if (typeof connection.query === "function") {
      await connection.query("SELECT 1");
      return;
    }
    if (typeof connection.authenticate === "function") {
      await connection.authenticate();
      return;
    }
    throw new Error(
      "Sequelize connection must implement query() or authenticate()",
    );
  }

  pingCheck<Key extends string = string>(
    key: Key,
    options: SequelizePingCheckSettings = {},
  ): HealthCheckAttempt<Key, void, {}, undefined, { code?: string | number }> {
    return this.healthIndicatorService
      .check(key)
      .attempt(async () => {
        const connection = options.connection ?? this.getContextConnection();
        if (!connection) {
          throw new Error(
            "Connection provider not found in application context",
          );
        }
        await this.pingDb(connection);
      })
      .withFailureData((error) => {
        const parentCode =
          typeof error === "object" &&
          error !== null &&
          "parent" in error
            ? extractErrorCode((error as { parent?: unknown }).parent)
            : undefined;
        return {
          code: parentCode ?? extractErrorCode(error),
        };
      })
      .withTimeout(options.timeout ?? 1000);
  }
}

// ============================================================================
// MikroOrmHealthIndicator (Zero-Dep Structural Duck-Typing)
// ============================================================================

export type MikroOrmConnectionLike =
  | {
      isConnected(): Promise<boolean> | boolean;
    }
  | {
      em: {
        getConnection(): {
          isConnected(): Promise<boolean> | boolean;
        };
      };
    };

export interface MikroOrmPingCheckSettings {
  /**
   * The MikroORM connection (or `MikroORM` instance) on which the ping check should be executed.
   */
  connection?: MikroOrmConnectionLike | any;
  /**
   * The amount of time the check should require in ms.
   * @deprecated Chain `.withTimeout(ms)` on the returned attempt instead.
   */
  timeout?: number;
}

/**
 * Checks MikroORM connection health without requiring `@mikro-orm/core`
 * or `@mikro-orm/nestjs` as runtime dependencies.
 */
@Injectable({ scope: Scope.TRANSIENT })
export class MikroOrmHealthIndicator
  extends HealthIndicator
  implements OnModuleInit
{
  private readonly healthIndicatorService: HealthIndicatorService;

  constructor(
    @Optional()
    private readonly moduleRef?: ModuleRef,
    @Optional()
    healthIndicatorService?: HealthIndicatorService,
  ) {
    super();
    this.healthIndicatorService =
      healthIndicatorService ?? new HealthIndicatorService();
  }

  async onModuleInit(): Promise<void> {
    // Zero-dep structural indicator requires no external peer loading.
  }

  private getContextConnection(): any {
    const resolved = tryResolveFromModuleRef(this.moduleRef, [
      "MikroORM",
      "MIKRO_ORM",
      "defaultMikroORM",
    ]);
    if (!resolved) {
      return null;
    }
    if (typeof resolved.em?.getConnection === "function") {
      return resolved.em.getConnection();
    }
    return resolved;
  }

  private async pingDb(connection: MikroOrmConnectionLike): Promise<void> {
    const conn =
      typeof (connection as { isConnected?: unknown }).isConnected ===
      "function"
        ? (connection as { isConnected: () => Promise<boolean> | boolean })
        : (
            connection as {
              em?: {
                getConnection?: () => {
                  isConnected: () => Promise<boolean> | boolean;
                };
              };
            }
          ).em?.getConnection?.();

    if (!conn || typeof conn.isConnected !== "function") {
      throw new Error(
        "MikroORM connection must implement isConnected() or em.getConnection()",
      );
    }

    if (!(await conn.isConnected())) {
      throw new DatabaseNotConnectedError();
    }
  }

  pingCheck<Key extends string = string>(
    key: Key,
    options: MikroOrmPingCheckSettings = {},
  ): HealthCheckAttempt<Key> {
    return this.healthIndicatorService
      .check(key)
      .attempt(async () => {
        const connection = options.connection ?? this.getContextConnection();
        if (!connection) {
          throw new Error(
            "Connection provider not found in application context",
          );
        }
        await this.pingDb(connection);
      })
      .withTimeout(options.timeout ?? 1000) as unknown as HealthCheckAttempt<Key>;
  }
}
