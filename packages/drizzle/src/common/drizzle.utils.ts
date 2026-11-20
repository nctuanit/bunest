import {
  DEFAULT_CONNECTION_NAME,
  DRIZZLE_INSTANCE,
} from "../drizzle.constants";

/**
 * Returns the injection token of the Drizzle database registered under the
 * given connection name.
 *
 * @param name Connection name (default: `"default"`)
 * @returns The database injection token (`"DrizzleDatabase"` or `"${name}DrizzleDatabase"`)
 *
 * @publicApi
 */
export function getDrizzleToken(
  name: string = DEFAULT_CONNECTION_NAME,
): string {
  return name === DEFAULT_CONNECTION_NAME
    ? DRIZZLE_INSTANCE
    : `${name}DrizzleDatabase`;
}

export type DrizzleClient = {
  end?: () => unknown;
  close?: () => unknown;
  promise?: () => DrizzleClient;
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  listenerCount?: (event: string) => number;
};

interface DrizzleDatabaseHolder {
  $client?: unknown;
  $primary?: { $client?: unknown };
  $replicas?: Array<{ $client?: unknown }>;
}

const closedClients = new WeakSet<object>();
const watchedClients = new WeakSet<object>();

/**
 * Returns the driver clients a Drizzle database holds: `db.$client` and, for a
 * database created with `withReplicas()`, the clients of its primary and
 * replica databases (`$primary` and `$replicas`).
 */
export function getDrizzleClients(db: unknown): DrizzleClient[] {
  const database = db as DrizzleDatabaseHolder | undefined;
  const databases = [
    database,
    database?.$primary,
    ...(Array.isArray(database?.$replicas) ? database.$replicas : []),
  ];
  const clients = new Set<DrizzleClient>();
  for (const candidate of databases) {
    const client = candidate?.$client;
    if (
      client &&
      (typeof client === "object" || typeof client === "function")
    ) {
      clients.add(client as DrizzleClient);
    }
  }
  return [...clients];
}

/**
 * Closes a driver client idempotently (tracked via `WeakSet`).
 * Supports `end()`, `close()`, and mysql2 callback `.promise()` wrappers.
 */
export async function closeDrizzleClient(client: DrizzleClient): Promise<void> {
  if (closedClients.has(client)) {
    return;
  }
  closedClients.add(client);

  const target =
    typeof client.promise === "function" ? client.promise() : client;
  if (typeof target.end === "function") {
    await target.end();
  } else if (typeof target.close === "function") {
    await target.close();
  }
}

interface NodePostgresPoolLike extends DrizzleClient {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
}

function isNodePostgresPool(
  client: DrizzleClient,
): client is NodePostgresPoolLike {
  const pool = client as Partial<NodePostgresPoolLike>;
  return (
    typeof pool.totalCount === "number" &&
    typeof pool.idleCount === "number" &&
    typeof pool.waitingCount === "number"
  );
}

function watchCheckedOutConnections(
  pool: NodePostgresPoolLike,
  onError: (error: unknown) => void,
): void {
  const watchedConnections = new WeakSet<object>();
  pool.on("acquire", (connection: DrizzleClient | undefined) => {
    if (
      !connection ||
      typeof connection.on !== "function" ||
      typeof connection.listenerCount !== "function" ||
      watchedConnections.has(connection)
    ) {
      return;
    }
    watchedConnections.add(connection);
    connection.on("error", (error: unknown) => {
      if (connection.listenerCount!("error") === 1) {
        onError(error);
      }
    });
  });
}

/**
 * Attaches an `error` event listener to background database clients/pools
 * unless already watched or handled by the application.
 */
export function watchDrizzleClient(
  client: DrizzleClient,
  onError: (error: unknown) => void,
): void {
  if (typeof client.on !== "function" || watchedClients.has(client)) {
    return;
  }
  watchedClients.add(client);

  if (isNodePostgresPool(client)) {
    watchCheckedOutConnections(client, onError);
  }

  if ((client.listenerCount?.("error") ?? 0) > 0) {
    return;
  }
  client.on("error", onError);
}
