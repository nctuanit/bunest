import { normalizeDialect } from "../identifiers";
import type {
  OrmConnectionCredentials,
  OrmDataSourceOptions,
  OrmDialect,
  OrmDriverLike,
} from "../types";
import { BunSqlOrmDriver } from "./bun-sql.driver";
import { D1OrmDriver } from "./d1.driver";
import { OrmDriverRegistry } from "./driver.interface";
import { LibSqlOrmDriver } from "./libsql.driver";
import { MongoOrmDriver } from "./mongodb.driver";
import { ReplicatedOrmDriver } from "./replicated.driver";
import { SqliteOrmDriver } from "./sqlite.driver";

function mergeNodeOptions(
  base: OrmDataSourceOptions,
  node: OrmConnectionCredentials,
): OrmDataSourceOptions {
  return {
    ...base,
    ...node,
    replication: undefined,
  };
}

function createSingleDriver(options: OrmDataSourceOptions): OrmDriverLike {
  if (options.driver) {
    return options.driver;
  }

  const rawType = options.type ?? "sqlite";
  const customFactory = OrmDriverRegistry.get(String(rawType));
  if (customFactory) {
    return customFactory(options);
  }

  const dialect: OrmDialect = normalizeDialect(rawType);
  const customDialectFactory = OrmDriverRegistry.get(dialect);
  if (customDialectFactory) {
    return customDialectFactory(options);
  }

  switch (dialect) {
    case "sqlite": {
      const urlStr = options.url !== undefined ? String(options.url) : "";
      if (options.useBunSql || urlStr.startsWith("sqlite://")) {
        return new BunSqlOrmDriver({
          dialect: "sqlite",
          url: options.url,
          database: options.database,
          readonly: options.readonly,
          create: options.create,
          readwrite: options.readwrite,
          safeIntegers: options.safeIntegers,
          strict: options.strict,
          bigint: options.bigint,
          enableWAL: options.enableWAL,
          enforceForeignKeys: options.enforceForeignKeys,
          onconnect: options.onconnect,
          onclose: options.onclose,
          logging: options.logging,
          dataSourceName: options.name ?? "default",
        });
      }
      return new SqliteOrmDriver({
        database: options.database ?? (urlStr || ":memory:"),
        enableWAL: options.enableWAL,
        enforceForeignKeys: options.enforceForeignKeys,
        readonly: options.readonly,
        create: options.create,
        readwrite: options.readwrite,
        safeIntegers: options.safeIntegers,
        strict: options.strict,
        busyTimeout: options.busyTimeout,
        logging: options.logging,
        dataSourceName: options.name ?? "default",
      });
    }

    case "postgres":
    case "cockroachdb":
    case "mysql":
    case "mariadb":
      return new BunSqlOrmDriver({
        dialect,
        url: options.url,
        host: options.host,
        hostname: options.hostname,
        port: options.port,
        username: options.username,
        user: options.user,
        password: options.password,
        database: options.database,
        schema: options.schema,
        ssl: options.ssl,
        tls: options.tls,
        socketPath: options.socketPath,
        path: options.path,
        poolSize: options.poolSize,
        max: options.max,
        idleTimeout: options.idleTimeout,
        connectionTimeout: options.connectionTimeout,
        connectTimeoutMS: options.connectTimeoutMS,
        maxLifetime: options.maxLifetime,
        bigint: options.bigint,
        prepare: options.prepare,
        allowPublicKeyRetrieval: options.allowPublicKeyRetrieval,
        applicationName: options.applicationName,
        connection: options.connection,
        onconnect: options.onconnect,
        onclose: options.onclose,
        logging: options.logging,
        dataSourceName: options.name ?? "default",
      });

    case "libsql": {
      const url = options.url ?? options.database;
      if (!url) {
        throw new Error(
          'LibSQL / Turso DataSource requires `url` (e.g. "libsql://my-db.turso.io" or "http://127.0.0.1:8080").',
        );
      }
      return new LibSqlOrmDriver({
        url,
        authToken: options.authToken,
        headers: options.headers,
        logging: options.logging,
        dataSourceName: options.name ?? "default",
      });
    }

    case "d1":
      return new D1OrmDriver({
        binding: options.d1Binding,
        accountId: options.accountId,
        databaseId: options.databaseId,
        apiToken: options.apiToken,
        apiBaseUrl: options.url !== undefined ? String(options.url) : undefined,
        headers: options.headers,
        logging: options.logging,
        dataSourceName: options.name ?? "default",
      });

    case "mongodb":
      return new MongoOrmDriver({
        url: options.url,
        host: options.host,
        hostname: options.hostname,
        port: options.port,
        username: options.username,
        user: options.user,
        password: options.password,
        database: options.database,
        authSource: options.authSource,
        ssl: options.ssl,
        tls: options.tls,
        logging: options.logging,
      });

    case "mssql":
    case "oracle":
    case "sap":
    case "spanner":
      throw new Error(
        `Dialect "${dialect}" has full SQL compilation & DDL support in @bunest/orm, ` +
          `but Bun does not ship a native wire client for "${dialect}". ` +
          `Pass a custom \`driver\` in DataSourceOptions or register one via \`OrmDriverRegistry.register("${dialect}", factory)\`.`,
      );
  }
}

/**
 * Instantiates the appropriate Bun-native `OrmDriver` (including Master/Slave
 * `ReplicatedOrmDriver` when `options.replication` is provided) for ANY TypeORM database type!
 */
export function createDriverFromOptions(
  options: OrmDataSourceOptions,
): OrmDriverLike {
  if (options.driver) {
    return options.driver;
  }

  if (options.replication) {
    const master = createSingleDriver(
      mergeNodeOptions(options, options.replication.master),
    );
    const slaves = options.replication.slaves.map((s) =>
      createSingleDriver(mergeNodeOptions(options, s)),
    );
    return new ReplicatedOrmDriver(
      master,
      slaves,
      options.replication.defaultMode ?? "slave",
    );
  }

  return createSingleDriver(options);
}
