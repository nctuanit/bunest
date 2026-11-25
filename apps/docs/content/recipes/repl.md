# REPL (Read-Eval-Print Loop)

Bunest includes an interactive **REPL** (`repl()` from `@bunest/core` and `bunest repl` from `@bunest/cli`) that boots your application's DI container without binding an HTTP port—letting you inspect modules, resolve providers, and invoke service methods directly from your terminal.

## Starting the REPL

Create a dedicated `src/repl.ts` entrypoint:

@@filename(src/repl.ts)

```ts
import { repl } from "@bunest/core";
import { AppModule } from "./app.module";

await repl(AppModule);
```

Run it directly with Bun:

```bash
bun run src/repl.ts
```

Or launch via the Bunest CLI:

```bash
bunest repl
```

## Built-in REPL Functions

Once inside the REPL prompt, Bunest exposes helper functions bound to your application's `BunestApplicationContext`:

| Function | Description | Example |
| --- | --- | --- |
| `get(token)` / `$(token)` | Retrieves a singleton provider or controller by class or injection token. | `get(UsersService)` |
| `resolve(token)` | Asynchronously resolves a `TRANSIENT` or `REQUEST`-scoped provider. | `await resolve(AuditService)` |
| `select(ModuleClass)` | Scopes lookups to a specific module in the module graph. | `select(UsersModule).get(UsersService)` |
| `methods(token)` | Lists all callable prototype methods on a provider or controller. | `methods(UsersService)` |
| `debug(module?)` | Prints the registered modules, controllers, and providers tree. | `debug()` |
| `help()` | Displays all available REPL commands and signatures. | `help()` |

## Interactive Session Example

```text
> debug()
AppModule
 ├── Controllers: [AppController]
 └── Imports:
      └── UsersModule
           ├── Controllers: [UsersController]
           └── Providers: [UsersService, UserRepository]

> methods(UsersService)
Methods:
 ◻ findAll
 ◻ findOne
 ◻ create

> await get(UsersService).findAll()
[ { id: 'usr_1', email: 'ada@bunest.dev' } ]
```

## Programmatic REPL Context

For custom admin scripts or embedded diagnostics, use `createReplContext(app)` directly:

@@filename(scripts/inspect.ts)

```ts
import { BunestFactory, createReplContext } from "@bunest/core";
import { AppModule } from "../src/app.module";
import { UsersService } from "../src/users/users.service";

const app = await BunestFactory.createApplicationContext(AppModule);
const ctx = createReplContext(app);

console.log(ctx.methods(UsersService));
await app.close();
```

> warning **Production Caution** Never expose an interactive REPL over public networks. Run REPL sessions locally or via an audited ephemeral bastion/container shell with read-only credentials when inspecting production data.
