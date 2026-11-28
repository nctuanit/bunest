# Dynamic Modules (`25-dynamic-modules`)

Bunest counterpart of NestJS's [`sample/25-dynamic-modules`](https://github.com/nestjs/nest/tree/master/sample/25-dynamic-modules):

- **Manual `DynamicModule`**: `EnvConfigModule.register({ folder })` & `EnvConfigModule.registerAsync({ useFactory })` loading environment `.env` files
- **`ConfigurableModuleBuilder`**: `GreetingModule.forRoot({ prefix, isGlobal: true })` & `forRootAsync()`
- **Built-in `@bunest/core/config`**: `ConfigModule.forRoot()` with `registerAs` namespaced configuration

## Run

```bash
bun run --cwd examples/dynamic-modules dev
bun run --cwd examples/dynamic-modules test
```
