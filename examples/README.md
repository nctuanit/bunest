# Bunest Examples (NestJS Sample Parity)

Runnable, zero-external-dependency examples modeled directly after the official [NestJS `sample/`](https://github.com/nestjs/nest/tree/master/sample) apps and recipes — built natively on **Bun >= 1.4.5**.

## NestJS Sample Mapping

| NestJS Sample / Recipe | Bunest Example | Highlights |
| --- | --- | --- |
| Minimal Starter | [`hello-world`](./hello-world) | Minimal `@Module`, `@Controller`, `@Injectable` on `Bun.serve()` |
| `01-cats-app` | [`cats-app`](./cats-app) | Full HTTP pipeline: Middleware, `RolesGuard`, `ParseIntPipe`, `ValidationPipe`, Promise Interceptors, `HttpExceptionFilter`, `@Actor()` |
| `02-gateways` / `16-gateways-ws` | [`websocket-chat`](./websocket-chat) | Native `Bun.serve({ websocket })` rooms, handshake auth, pub/sub |
| `03-microservices` | [`microservices-tcp`](./microservices-tcp) | HTTP gateway + native TCP microservice (`@MessagePattern`, `@EventPattern`, `ClientsModule`, `RpcException`) |
| `04-grpc` | [`grpc`](./grpc) | Unary `@GrpcMethod`, server-streaming `@GrpcStreamMethod`, `GrpcMetadata`, `GrpcException` |
| `05-sql-typeorm` / `07-sequelize` | [`starter`](./starter) · [`production-rest-postgres`](./production-rest-postgres) | `@bunest/orm` relations (`@OneToMany`/`@ManyToOne`), migrations, `@Transactional()`, PostgreSQL production setup |
| `11-swagger` | [`rest-crud`](./rest-crud) | REST CRUD + DTO `ValidationPipe` + OpenAPI 3.1 Swagger UI + custom `ExceptionFilter` |
| `12-graphql-schema-first` | [`graphql-schema-first`](./graphql-schema-first) | SDL `.graphql` schema-first resolvers, `@ResolveField`, `GqlExecutionContext` guard |
| `15-mvc` / `17-mvc-handlebars` | [`mvc`](./mvc) | Server-side HTML rendering via `@Render()`, `Bun.escapeHTML` view engine, form POST + `@Redirect` |
| `18-context` | [`application-context`](./application-context) | Standalone `createApplicationContext` (no HTTP server), lifecycle hooks, DI scopes, `ClsModule` |
| `19-auth-jwt` | [`auth-jwt-sqlite`](./auth-jwt-sqlite) | JWT, Argon2id, RBAC, Throttler, Security Headers + SQLite ORM migrations |
| `20-cache` | [`cache`](./cache) | `CacheModule`, HTTP `CacheInterceptor` (`@CacheKey`, `@CacheTTL`, `@NoCache`), service `@Cacheable`/`@CachePut`/`@CacheEvict` |
| `21-serializer` | [`serializer`](./serializer) | `ClassSerializerInterceptor`, `@Exclude`, `@Expose`, `@Transform`, role groups, `@SerializeOptions` |
| `23-graphql-code-first` | [`graphql-code-first`](./graphql-code-first) | Code-first `@ObjectType`, `@InputType`, `@ArgsType`, `@ResolveField`, `ValidationPipe`, `ApolloDriver`, GraphiQL |
| `24-serve-static` | [`serve-static`](./serve-static) | `ServeStaticModule` (`Bun.file`, ETag/304, SPA fallback) alongside `/api/*` and `StreamableFile` |
| `25-dynamic-modules` | [`dynamic-modules`](./dynamic-modules) | Manual `DynamicModule` (`register`/`registerAsync`), `ConfigurableModuleBuilder`, namespaced `ConfigModule` |
| `26-queues` | [`queues`](./queues) | Background audio transcoding queue with `BullModule`, `@Processor`/`WorkerHost`, worker & queue event listeners |
| `27-scheduling` | [`scheduling`](./scheduling) | `ScheduleModule`, `@Cron`, `@Interval`, `@Timeout`, and runtime `SchedulerRegistry` management |
| `28-sse` | [`sse`](./sse) | `@Sse()` native `AsyncGenerator` streaming, `@SseSignal()` cleanup, live push notifications |
| `29-file-upload` | [`file-upload`](./file-upload) | `FileInterceptor`, `FilesInterceptor`, `ParseFilePipeBuilder` magic-byte checks + `@bunest/storage` |
| `30-event-emitter` | [`event-emitter`](./event-emitter) | `EventEmitterModule`, `EventEmitter2`, `@OnEvent` wildcard & async listeners, `@EmitEvent` |
| `31-graphql-federation-code-first` | [`graphql-federation`](./graphql-federation) | Apollo Federation v2 multi-subgraph (`Users` + `Posts`) composed by `ApolloGatewayDriver` |
| CQRS Recipe | [`cqrs`](./cqrs) | Heroes & Dragons: `CommandBus`, `QueryBus`, `EventBus`, `AggregateRoot`, `EventPublisher`, `@Saga()` |
| Distributed Worker | [`distributed-worker`](./distributed-worker) | End-to-end CQRS + SQLite + Queues + Events + W3C Tracing + Prometheus Metrics + Health |
| IDE / VS Code Showcase | [`vscode-extension-showcase`](./vscode-extension-showcase) | Live typegen, declarative repositories, AOP pipelines, and IDE diagnostics |

## Production Deep Examples (Beyond NestJS)

Examples showcasing Bunest-native capabilities that directly solve common NestJS pain points (end-to-end typed RPC, zero-boilerplate functional APIs, zero-Passport identity, resilient brokers, and signed object storage):

| Focus | Bunest Example | Highlights |
| --- | --- | --- |
| Contract-First RPC + Auto OpenAPI | [`fullstack-contract-rpc`](./fullstack-contract-rpc) | Shared `defineContract()` + `implementContract()` + auto OpenAPI 3.1 + `createContractClient()` + zero-socket `createContractTestClient()` |
| Minimal Functional API | [`functional-minimal`](./functional-minimal) | Zero-decorator `defineRoutes()` + `BunestFactory.createRoutes()` + `createFetchHandler()` (Hono-level simplicity with Bunest DI) |
| Zero-Passport Multi-Auth + ABAC | [`multi-auth-security`](./multi-auth-security) | `AuthenticationModule` (JWT + rotating refresh tokens + reuse revocation + TOTP MFA + prefixed `ApiKeyProvider`) + `@Policy()` / `@Can()` ABAC |
| Modern Auth (Better Auth + API Keys) | [`modern-auth-integrations`](./modern-auth-integrations) | Drop-in `BetterAuthModule.forRoot()` mounting `/api/auth/*` + `@InjectBetterAuth()` + `ApiKeyProvider` + `@Policy()` / `@Can()` ABAC |
| Resilient Broker Microservices | [`broker-microservices`](./broker-microservices) | `InMemoryBroker` RPC/events + automatic cross-RPC CLS propagation + poison-message DLQ + `@Retry` / `@CircuitBreaker` / `@Fallback` + `@Idempotent()` |
| Signed Uploads & Range Streaming | [`storage-signed-uploads`](./storage-signed-uploads) | `@bunest/storage` presigned PUT/GET URLs, content-type/length enforcement, `inspectImage()`, HTTP Range `206`, and ETag `304` |

## Running Any Example

```bash
# Run in watch mode
bun run --cwd examples/<example-name> dev

# Run tests for one example
bun test examples/<example-name>

# Run tests for all examples
bun test examples
```
