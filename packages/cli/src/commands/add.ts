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
  "@bunest/swagger":
    "Configure OpenAPI via `new DocumentBuilder()` and `SwaggerModule.setup('/docs', app, doc)`.",
  "@bunest/config":
    "Import `ConfigModule.forRoot({ isGlobal: true })` in your root AppModule.",
  "@bunest/graphql":
    "Import `GraphQLModule.forRoot({ autoSchemaFile: true })` in your root AppModule.",
  "@bunest/websockets":
    "Generate a WebSocket gateway with `bunest g ga <name>`.",
  "@bunest/security":
    "Configure JWT, Throttler, and Auth strategies via `JwtModule`, `ThrottlerModule`, and `AuthModule`.",
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
    env: process.env,
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
