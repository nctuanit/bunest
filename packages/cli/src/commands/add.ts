import type {
  AddLibraryOptions,
  AddLibraryResult,
  CliIO,
  SpawnFn,
} from "../types";

const VALID_LIBRARY_SPEC_RE =
  /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+(?:@[a-zA-Z0-9._^~>=<*-]+)?$/;

const defaultSpawn: SpawnFn = async (cmd, options) => {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  return { exitCode };
};

const PACKAGE_HINTS: Readonly<Record<string, string>> = {
  "@bunest/core":
    "Includes ConfigModule (`@bunest/core/config`), HTTP client (`@bunest/core/client`), WebSockets (`@bunest/core/ws`), and I18n (`@bunest/core/i18n`).",
  "@bunest/swagger":
    "Configure OpenAPI via `new DocumentBuilder()` and `SwaggerModule.setup('/docs', app, doc)`.",
  "@bunest/orm":
    "Import `OrmModule.forRoot({ type: 'sqlite', database: ':memory:', synchronize: true })` in your root AppModule.",
  "@bunest/graphql":
    "Import `GraphQLModule.forRoot({ autoSchemaFile: true })` (or `@bunest/graphql/apollo`) in your root AppModule.",
  "@bunest/security":
    "Configure SecurityModule.forRoot(), JwtModule (`@bunest/security/jwt`), ThrottlerModule (`@bunest/security/throttler`), Auth (`@bunest/security/auth`), and Authorization (`@bunest/security/authz`).",
  "@bunest/cache":
    "Import `CacheModule.forRoot({ isGlobal: true })` or use `RedisCacheStore` backed by `Bun.RedisClient`.",
  "@bunest/messaging":
    "Import `EventEmitterModule` (`./events`), `CqrsModule` (`./cqrs`), `OutboxModule` (`./outbox`), or `WebhooksModule` (`./webhooks`).",
  "@bunest/jobs":
    "Import `QueueModule` (`./queues`) or `ScheduleModule` (`./scheduler`) in your root AppModule.",
  "@bunest/resilience":
    "Use `@Retry`/`@CircuitBreaker`, `@WithLock` (`./locks`), and `@Idempotent` (`./idempotency`).",
  "@bunest/ai":
    "Import `AiModule` or `McpModule` (`@bunest/ai/mcp`) in your root AppModule.",
};

/**
 * Installs a `@bunest/*` or ecosystem package via `bun add <library>` (`bunest add <library>`).
 */
export async function addLibrary(
  options: AddLibraryOptions,
  io?: CliIO,
): Promise<AddLibraryResult> {
  const library = options.library.trim();
  if (
    !library ||
    library.includes("..") ||
    !VALID_LIBRARY_SPEC_RE.test(library)
  ) {
    throw new Error(
      `Invalid library specifier "${options.library}". Expected a valid npm/Bun package name (e.g. "@bunest/swagger").`,
    );
  }

  const cwd = options.cwd ?? io?.cwd ?? process.cwd();
  const dryRun = options.dryRun === true;
  const skipInstall = options.skipInstall === true;
  const displayCmd = ["bun", "add", library];
  const spawnCmd = [process.execPath, "add", library];

  if (dryRun || skipInstall) {
    if (io) {
      const label = dryRun ? "[dry-run]" : "[skip-install]";
      io.stdout(`${label} Would run: ${displayCmd.join(" ")}`);
      const baseName = library.replace(/@[^/]+$/, "");
      if (PACKAGE_HINTS[baseName]) {
        io.stdout(`Hint: ${PACKAGE_HINTS[baseName]}`);
      }
    }
    return {
      library,
      installed: false,
      dryRun,
      command: displayCmd,
      exitCode: 0,
    };
  }

  if (io) {
    io.stdout(`Adding ${library} via "${displayCmd.join(" ")}"...`);
  }

  const spawn = options.spawn ?? defaultSpawn;
  const { exitCode } = await spawn(spawnCmd, {
    cwd,
    env: Bun.env,
  });

  if (exitCode !== 0) {
    throw new Error(
      `Failed to add library "${library}" ("bun add" exited with code ${exitCode}).`,
    );
  }

  if (io) {
    io.stdout(`Successfully installed "${library}".`);
    const baseName = library.replace(/@[^/]+$/, "");
    if (PACKAGE_HINTS[baseName]) {
      io.stdout(`Next step: ${PACKAGE_HINTS[baseName]}`);
    }
  }

  return {
    library,
    installed: true,
    dryRun: false,
    command: displayCmd,
    exitCode: 0,
  };
}
