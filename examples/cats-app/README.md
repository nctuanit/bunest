# Cats App (`01-cats-app`)

Bunest counterpart of NestJS's [`sample/01-cats-app`](https://github.com/nestjs/nest/tree/master/sample/01-cats-app), showcasing the complete HTTP request pipeline:

- **Modules & DI**: `AppModule`, `CatsModule`, `CatsController`, `CatsService`
- **Middleware**: `LoggerMiddleware` applied via `BunestModule.configure(consumer)`
- **Guards & Metadata**: `@Roles("admin")` + `RolesGuard` using `Reflector`
- **Pipes**: Global `ValidationPipe` (`@bunest/validation`) + route-level `ParseIntPipe`
- **Interceptors (Promise-based)**: `LoggingInterceptor` (adds `X-Response-Time`) & `TransformInterceptor` (`{ data }`)
- **Exception Filter**: `HttpExceptionFilter` (`@Catch(HttpException)`)
- **Custom Param Decorator**: `@Actor()` using `createParamDecorator`

## Run

```bash
bun run --cwd examples/cats-app dev
bun run --cwd examples/cats-app test
```
