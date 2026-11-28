# Modern Auth Integrations (Better Auth + API Keys + ABAC Policy)

Shows how to drop **Better Auth** directly into Bunest via `BetterAuthModule.forRoot()` — with **zero Passport.js**, automatic `/api/auth/*` Web `Request`/`Response` mounting, `@CurrentUser()` / `@CurrentSession()` / `@InjectBetterAuth()`, **ABAC `@Policy()` / `@Can()`** authorization, and seamless co-existence with **`ApiKeyProvider`** for service-to-service callers.

## Swap in Real `better-auth` in Your App

This workspace example uses a self-contained zero-dependency Better Auth-compatible engine in `src/auth.instance.ts` so `bun test` runs anywhere with zero external DB/secrets. In your production app, simply install `better-auth` and replace `src/auth.instance.ts`:

```ts
import { betterAuth } from "better-auth";
import { Database } from "bun:sqlite";

export const auth = betterAuth({
  database: new Database("./auth.sqlite"),
  emailAndPassword: { enabled: true },
  basePath: "/api/auth",
});
```

`BetterAuthModule.forRoot({ auth })` works identically without changing a single controller, guard, or policy.

## Run

```bash
bun run --cwd examples/modern-auth-integrations dev
bun test examples/modern-auth-integrations
```
