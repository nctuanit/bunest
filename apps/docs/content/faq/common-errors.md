# Common Errors & `BUNEST_E*` Catalog

Every bootstrap, DI, and routing error thrown by `@bunest/core` carries a **stable error code** (`err.code`, such as `BUNEST_E001`) along with ordered fix suggestions. You can also format errors programmatically via `toBunestErrorReport(err)` (JSON) or `formatBunestErrorForAgent(err)` (compact text).

## Error Code Index

| Code | Exception Class | Summary |
| --- | --- | --- |
| [`BUNEST_E001`](#bunest_e001-unknown-dependency) | `UnknownDependencyException` | DI container cannot resolve a constructor or property dependency |
| [`BUNEST_E002`](#bunest_e002-circular-dependency) | `CircularDependencyException` | Two or more providers or modules depend on each other |
| [`BUNEST_E003`](#bunest_e003-scope-leak) | `ScopeLeakException` | Longer-lived provider (`SINGLETON`) depends on a `REQUEST`-scoped provider |
| [`BUNEST_E004`](#bunest_e004-ambiguous-provider) | `AmbiguousProviderException` | Same token exported by multiple imported/global modules |
| [`BUNEST_E005`](#bunest_e005-invalid-module) | `InvalidModuleException` | Entry in `imports` is not a `@Module()` class or valid `DynamicModule` |
| [`BUNEST_E006`](#bunest_e006-duplicate-provider) | `DuplicateProviderException` | Same provider token declared more than once in a single module |
| [`BUNEST_E007`](#bunest_e007-invalid-export) | `InvalidExportException` | Module exports a token it neither provides nor imports |
| [`BUNEST_E101`](#bunest_e101-duplicate-route) | `DuplicateRouteException` | Two handlers resolve to the same HTTP method + canonical path (+ host/version) |
| [`BUNEST_E102`](#bunest_e102-invalid-controller) | `InvalidControllerException` | Class in `controllers` array is missing `@Controller()` |
| [`BUNEST_E103`](#bunest_e103-invalid-route) | `InvalidRouteException` | Invalid route path or conflicting parameter decorator metadata |

---

## `BUNEST_E001` — Unknown Dependency

**`UnknownDependencyException`**: The DI container cannot resolve a constructor parameter or property of a provider/controller in the owning module.

**Ordered fixes:**
1. Add the missing class to the `providers` array of the module.
2. If it belongs to another module, add it to that module's `exports` and import that module in `imports`.
3. If the parameter type is an interface, union, or generic (erased at runtime), inject with `@Inject(TOKEN)` and register `{ provide: TOKEN, useClass | useValue | useFactory }`.
4. Ensure you **value-import** the class (never `import type`) so `design:paramtypes` is emitted.
5. If the dependency is genuinely optional, decorate it with `@Optional()`.

@@filename(orders.module.ts)

```ts
@Module({
  imports: [UsersModule], // UsersModule must export UsersService
  providers: [OrdersService],
})
export class OrdersModule {}
```

## `BUNEST_E002` — Circular Dependency

**`CircularDependencyException`**: Two or more providers (or modules) form a cycle so neither can be constructed first.

**Ordered fixes:**
1. Extract shared logic into a third provider that both depend on *(preferred)*.
2. For providers: wrap one side with `@Inject(forwardRef(() => OtherService))`.
3. For modules: wrap one side with `forwardRef(() => OtherModule)` in `imports`.

See [Circular dependency](/fundamentals/circular-dependency) for full examples.

## `BUNEST_E003` — Scope Leak

**`ScopeLeakException`**: A `SINGLETON` provider depends on a `REQUEST`-scoped provider, which would leak per-request state across concurrent requests.

**Ordered fixes:**
1. Mark every provider in the chain with `@Injectable({ scope: Scope.REQUEST })`.
2. Or keep the service singleton and read request data via `ClsService` / `RequestContext` inside methods.

See [Injection scopes](/fundamentals/injection-scopes) for details.

## `BUNEST_E004` — Ambiguous Provider

**`AmbiguousProviderException`**: The same token is exported by more than one imported or global module.

**Ordered fixes:**
1. Use distinct `Symbol()` or string tokens (e.g., `Symbol("PRIMARY_DB")`, `Symbol("REPORTING_DB")`).
2. Override the token locally in the consuming module's `providers`.
3. Remove the duplicate export from one of the modules.

## `BUNEST_E005` — Invalid Module

**`InvalidModuleException`**: A value in `imports` (or the root module passed to `BunestFactory.create()`) is not decorated with `@Module()` nor a valid `DynamicModule`.

**Ordered fixes:**
1. Decorate the class with `@Module({ ... })`.
2. For dynamic modules, return `{ module: MyModule, providers, exports }` from `forRoot()` / `register()`.
3. Check for `undefined` entries caused by circular ESM file imports and wrap with `forwardRef(() => OtherModule)`.

## `BUNEST_E006` — Duplicate Provider

**`DuplicateProviderException`**: The same provider token appears more than once in a module's `providers` array.

**Ordered fixes:**
1. Remove the duplicated entry from `providers`.
2. If you need multiple implementations, register them under distinct injection tokens.

## `BUNEST_E007` — Invalid Export

**`InvalidExportException`**: A module lists a token in `exports` that it neither declares in `providers` nor imports from another module.

**Ordered fixes:**
1. Add the token to `providers` before exporting it.
2. Or import the module providing it and re-export that module.

## `BUNEST_E101` — Duplicate Route

**`DuplicateRouteException`**: Two controller handlers map to the same HTTP method + canonical path (including renamed params such as `/users/:id` vs `/users/:userId`).

**Ordered fixes:**
1. Change the route path or controller prefix on one of the handlers.
2. Differentiate intentionally using `@Version()` ([API Versioning](/recipes/versioning)) or `@Controller({ host })`.
3. If shadowing is intentional, configure `routeConflictPolicy` on application creation.

## `BUNEST_E102` — Invalid Controller

**`InvalidControllerException`**: A class in `controllers` is missing the `@Controller()` decorator.

**Ordered fixes:**
1. Decorate the class with `@Controller("prefix")`.
2. If it is a service/provider rather than an HTTP controller, move it to `providers`.

## `BUNEST_E103` — Invalid Route

**`InvalidRouteException`**: Route metadata or parameter bindings are malformed (e.g., invalid path syntax or conflicting parameter decorators on the same parameter).

**Ordered fixes:**
1. Check the error message for the exact controller class, method name, and parameter index.
2. Ensure each handler parameter uses at most one binding decorator (`@Body`, `@Param`, `@Query`, etc.).

---

## Runtime Error Tracing for AI Agents (`enableDevDiagnostics`)

In development or test environments, enable structured runtime error tracing and dev-only diagnostics endpoints on your `BunestApplication` (automatically disabled when `NODE_ENV=production`):

@@filename(main.ts)

```ts
const app = await BunestFactory.create(AppModule);
app.enableDevDiagnostics({
  filePath: ".bunest/errors.jsonl", // Optional JSONL persistence for cross-process agent reads
});
await app.listen(3000);
```

When enabled:
- Every error response receives an `X-Request-Id` header (`req_...`) and records the exact pipeline `stage` (`routing`, `security`, `middleware`, `guard`, `interceptor`, `pipe`, `handler`, `serialization`), `controller.handler`, filtered user-code `appFrames`, validation `details`, and ordered `fixes`.
- Three dev-only JSON/text endpoints are exposed:
  - `GET /__bunest/errors?limit=20&format=agent` (or `?id=req_...`)
  - `GET /__bunest/routes` — compiled route table
  - `GET /__bunest/graph` — DI module/provider graph
- Pair with [`bunest mcp`](/observability/cli) so coding agents can inspect runtime errors directly via `bunest_recent_errors` and `bunest_inspect_diagnostics`.
