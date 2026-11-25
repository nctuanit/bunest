# Các Package & Monorepo

Bunest được tổ chức thành một **monorepo Bun workspace gồm 19 package, 6 lĩnh vực** (`Bun >= 1.4.5`) với **0 import vòng lặp**, **0 RxJS**, **19/19 package (100%) không có runtime dependency npm bên ngoài**, và **0 import `node:*` trên toàn repo** ngoại trừ 2 kernel adapter được cách ly trong `@bunest/core`.

> info **Kiến trúc Subpath Hợp nhất** Các năng lực liên quan nằm cùng nhau trong các package lĩnh vực gắn kết và cung cấp các ESM subpath có thể tree-shake (`@bunest/core/config`, `@bunest/security/auth`, `@bunest/messaging/events`, `@bunest/jobs/queues`, v.v.).

## 1. Lõi & Xác thực dữ liệu (2 Package)

| Package | Subpaths | Nhiệm vụ | Tài liệu |
| --- | --- | --- | --- |
| **`@bunest/core`** | `.`, `./common`, `./http`, `./config`, `./client`, `./ws`, `./i18n` | Runtime lõi thống nhất: decorators, `MetadataRegistry`, `Reflector`, `DIContainer`, `MethodAspectWeaver`, hybrid `Bun.serve({ routes, fetch, websocket })` + `FallbackRadixRouter`, `Bun.Cookie`, các header Helmet-8, `ServeStaticModule`, `ConfigModule` (`.env` + `Bun.YAML`/`TOML`/`JSONC`), HTTP client `fetch()` không phụ thuộc ngoài (`./client`), WebSocket gateway gốc (`./ws`), ALS `I18nModule` (`./i18n`), `ClsModule`, `GraphInspector`, `repl()` | [Controllers](/overview/controllers), [Modules](/overview/modules), [Configuration](/techniques/configuration), [WebSockets](/apis/websockets) |
| **`@bunest/validation`** | `.`, `./validator`, `./transformer`, `./standard-schema` | Bộ kiểm tra DTO biên dịch một lần gốc trên Bun không phụ thuộc ngoài (**336/336** API `class-validator`) & biến đổi (**21/21** API `class-transformer`), `ValidationPipe`, `StandardSchemaValidationPipe`, `SchemaValidationPipe`, `ClassSerializerInterceptor`, các hàm hỗ trợ DTO ánh xạ (mapped DTO helpers) và đồng tồn tại mượt mà hai engine | [Validation](/techniques/validation), [Mapped Types](/techniques/mapped-types) |

## 2. Bảo mật (1 Package)

| Package | Subpaths | Nhiệm vụ | Tài liệu |
| --- | --- | --- | --- |
| **`@bunest/security`** | `.`, `./auth`, `./authz`, `./jwt`, `./throttler`, `./testing` | `SecurityModule.forRoot()`, `@Auth()`, `@Protected()`, WebCrypto `JwtModule`/`JwksModule`/`OAuth2`/`Oidc` (PKCE), `PassportModule`, phiên đăng nhập, chuỗi refresh-token, TOTP MFA, magic link, API key, `Bun.password` (`argon2id`), `Bun.CSRF`, phân quyền theo chính sách `@Policy()`/`@Can()` (`./authz`), `ThrottlerModule` (`./throttler`), và `SecurityHeadersMiddleware` | [Security, JWT & Throttler](/security/security-module), [Authentication](/security/authentication), [Authorization](/security/authorization) |

## 3. API & AI (3 Package)

| Package | Subpaths | Nhiệm vụ | Tài liệu |
| --- | --- | --- | --- |
| **`@bunest/swagger`** | `.` | Bộ sinh OpenAPI 3.1, `DocumentBuilder`, `SwaggerModule`, các decorator `@Api*`, giao diện Try-It-Out tương tác + preset Scalar/Swagger-UI | [OpenAPI (Swagger)](/apis/openapi) |
| **`@bunest/graphql`** | `.`, `./apollo` | GraphQL code-first & schema-first, `ApolloDriver`, Federation v2 Subgraph & Gateway (`./apollo`), `@UseFilters`, `BunestDataLoader`, SSE & subscription `graphql-ws` | [GraphQL & Apollo](/apis/graphql) |
| **`@bunest/ai`** | `.`, `./mcp`, `./mcp/testing`, `./workflows`, `./testing` | Client SSE `fetch()` gốc cho OpenAI, Anthropic & Google Gemini (`generateText`, `generateObject`, `streamText`, `@AgentFunction`, quy trình agent bền vững) + máy chủ Model Context Protocol (`./mcp`: `@Tool`, `@Resource`, `@ResourceTemplate`, `@Prompt` qua Streamable HTTP, SSE & stdio JSON-RPC 2.0) | [AI SDK](/ai/ai-sdk), [Model Context Protocol (MCP)](/ai/mcp) |

## 4. Dữ liệu & Tích hợp (5 Package)

| Package | Subpaths | Nhiệm vụ | Tài liệu |
| --- | --- | --- | --- |
| **`@bunest/orm`** | `.`, `./plugin`, `./store`, `./postgres`, `./mysql`, `./testing` | ORM & bộ công cụ SQL gốc trên Bun không phụ thuộc ngoài hỗ trợ 12 dialect qua `bun:sqlite`, `Bun.SQL`, `fetch()`, & `Bun.connect()`, với `@OrmRepository`/`CrudRepository`/`@Query`/`@Modifying`, `@Transactional`, `OrmMigrationRunner`, và SQL Store Kit (`createBunSqlExecutor`) | [Bunest ORM](/data/orm-adapters), [SQLite](/data/sqlite), [SQL (Bun.SQL)](/data/sql), [Store Kit](/data/store-kit) |
| **`@bunest/cache`** | `.`, `./redis` | `CacheModule`, `CacheService`, `CacheInterceptor`, `@Cacheable`/`@CacheEvict`/`@CachePut`, khử trùng lặp single-flight, `MemoryCacheStore`, và `RedisCacheStore` dùng `Bun.RedisClient` gốc (`./redis`) | [Caching](/techniques/caching) |
| **`@bunest/storage`** | `.`, `./s3`, `./local`, `./memory` | API lưu trữ thống nhất: `LocalDisk` (`Bun.file().slice().stream()`), `InMemoryDisk`, `BunS3Disk` gốc (`Bun.S3Client`/`Bun.s3`), và SigV4 `S3Disk` (`Bun.CryptoHasher` + `Bun.XML.parse`) | [Storage & Static Files](/techniques/storage) |
| **`@bunest/mail`** | `.`, `./smtp`, `./templates` | Các class gửi thư có định kiểu, template `Bun.escapeHTML` (`./templates`), SMTP gốc (`./smtp`), cùng các transport Resend, Postmark, SendGrid & Amazon SES | [Mail](/techniques/mail) |
| **`@bunest/elasticsearch`** | `.` | Tương đồng `@nestjs/elasticsearch` v12: `ElasticsearchModule` + REST client dùng `fetch()` gốc của Bun không phụ thuộc ngoài | [Elasticsearch](/data/elasticsearch) |

## 5. Phân tán & Bất đồng bộ (5 Package)

| Package | Subpaths | Nhiệm vụ | Tài liệu |
| --- | --- | --- | --- |
| **`@bunest/messaging`** | `.`, `./events`, `./cqrs`, `./outbox/*`, `./webhooks/*` | EventEmitter2 (`./events`), CQRS (`./cqrs`), transactional outbox & consumer inbox (`./outbox`, Postgres/MySQL/testing + CLI `nest-outbox`), và outbound/inbound webhooks (`./webhooks`, `Bun.dns.lookup`, HMAC-SHA256, SSRF `AddressPolicy`, mã hóa AES-256-GCM + CLI `nest-webhooks`) | [Events](/techniques/events), [CQRS](/distributed/cqrs), [Outbox & Webhooks](/distributed/outbox-webhooks) |
| **`@bunest/jobs`** | `.`, `./queues`, `./scheduler`, `./redis` | `QueueModule`, `BullModule`/`BullMQModule`, `@Processor`/`@Process`, `WorkerHost`, `FlowProducer`, retry/backoff/DLQ, `MemoryQueueDriver`, `RedisQueueDriver` Lua nguyên tử dựa trên `Bun.RedisClient` (`./queues`, `./redis`), và `ScheduleModule`/`@Cron` dùng fast-path `Bun.cron.parse` (`./scheduler`) | [Queues](/techniques/queues), [Task Scheduling](/techniques/task-scheduling) |
| **`@bunest/resilience`** | `.`, `./locks/*`, `./idempotency/*` | `@Retry`, `@Timeout`, `@CircuitBreaker`, `@Bulkhead`, `@RateLimit`, `@Fallback` (entrypoint + AOP tầng service), khóa phân tán có thời hạn với fencing token & `@WithLock()`/`@OnOneInstance()` (`./locks`), và `@Idempotent()` chống trùng lặp retry an toàn (`./idempotency`) | [Resilience](/distributed/resilience), [Locks & Idempotency](/distributed/locks-idempotency) |
| **`@bunest/microservices`** | `.` | `@MessagePattern`, `@EventPattern`, `@GrpcMethod`, `ClientProxy`, hybrid `connectMicroservice()`, TCP, InMemory, gRPC, Kafka, MQTT, Redis dùng `Bun.RedisClient` gốc, NATS & RabbitMQ | [Microservices](/distributed/microservices) |
| **`@bunest/workflows`** | `.`, `./core`, `./cqrs`, `./postgres`, `./mysql`, `./testing` | Quy trình bền vững (durable workflows) viết bằng mã async thuần túy với khả năng phát lại tất định (deterministic replay), tín hiệu, bộ hẹn giờ, saga, lịch chạy, bộ mã hóa AES-GCM `Bun.deflateSync`, SQL store & CLI | [Durable Workflows](/distributed/workflows) |

## 6. Trải nghiệm Lập trình viên & Vận hành (3 Package)

| Package | Subpaths | Nhiệm vụ | Tài liệu |
| --- | --- | --- | --- |
| **`@bunest/observability`** | `.`, `./tracing`, `./metrics`, `./health`, `./devtools` | `ObservabilityModule.forRoot()`, `@Span`/`@Trace`/`@Timed`/`@Counted`, W3C Trace Context + OTLP (`./tracing`), chỉ số Prometheus (`./metrics`), `TerminusModule`/`HealthModule` với kiểm tra TCP qua `Bun.connect()` (`./health`), và đồ thị `DevtoolsModule` (`./devtools`) | [Observability, Health & Devtools](/observability/observability) |
| **`@bunest/testing`** | `.` | `Test.createTestingModule`, ghi đè provider/module, `ModuleMocker`, `request(app)` & `TestClient` không mở socket, `app.inject()`, `readSseEvents`, `CapturingLogger`, `ContextIdFactory` | [Testing](/fundamentals/testing) |
| **`@bunest/cli`** | `.`, `./analyzer` | `bunest new`, `generate`/`g`, `dev`, `start`, `build`, `check`/`doctor`, `typegen`, `delombok`, `codemod`, `add`, `upgrade`, `deploy`, `repl`, `info`, và `bunestMetadataPlugin()` cho `Bun.build()` | [CLI](/observability/cli) |

## Các lệnh Workspace

```bash
bun install             # Install & link all 19 workspace packages
bun test                # Run full test suite via bun:test
bun run typecheck       # Multi-threaded typecheck (`bun check`)
bun run build           # Build all 19 packages + docs site
bun run docs:dev        # Start this documentation site locally
bun run docs:build      # Build static documentation bundle to apps/docs/dist
bun run verify:release  # Validate publish metadata, subpath exports, DAG, cycles & CLI smoke tests
```
