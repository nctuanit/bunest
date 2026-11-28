# Standalone Application Context (`18-context`)

Bunest counterpart of NestJS's [`sample/18-context`](https://github.com/nestjs/nest/tree/master/sample/18-context):

- **Standalone DI Container**: `BunestFactory.createApplicationContext(AppModule)` with zero HTTP server overhead (ideal for CLIs, seed scripts, and batch workers)
- **Lifecycle Hooks**: `OnModuleInit`, `OnApplicationBootstrap`, `OnModuleDestroy`, `BeforeApplicationShutdown`
- **DI Scopes**: `Scope.SINGLETON`, `Scope.TRANSIENT`, and `Scope.REQUEST` resolved via `ContextIdFactory.create()` + `app.resolve()`
- **Async Context (`ClsModule`)**: Propagates `tenantId` / `correlationId` across async boundaries using `ClsService`

## Run

```bash
bun run --cwd examples/application-context start
bun run --cwd examples/application-context test
```
