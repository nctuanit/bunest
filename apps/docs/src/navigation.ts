export interface NavPage {
  /** URL slug without leading slash ("" for root introduction page) */
  slug: string;
  /** Display title in sidebar & <title> */
  title: string;
  /** Relative markdown file path under apps/docs/content/ */
  file: string;
  /** Short badge displayed in sidebar or page header (optional) */
  badge?: string;
  /** Short summary used in search & meta description */
  description: string;
  /** Extra search keywords (decorators, classes, ADRs) */
  keywords?: readonly string[];
}

export interface NavCategory {
  id: string;
  title: string;
  defaultOpen?: boolean;
  pages: readonly NavPage[];
}

export interface FlattenedPage extends NavPage {
  categoryId: string;
  categoryTitle: string;
  href: string;
  prev?: { title: string; href: string; categoryTitle: string };
  next?: { title: string; href: string; categoryTitle: string };
}

export const INTRO_PAGE: NavPage = {
  slug: "",
  title: "Introduction",
  file: "introduction.md",
  description:
    "Bunest is a progressive, NestJS-style TypeScript backend framework built natively on Bun.",
  keywords: [
    "bunest",
    "nestjs",
    "bun",
    "philosophy",
    "introduction",
    "getting started",
    "Bun.serve",
  ],
};

export const NAV_CATEGORIES: readonly NavCategory[] = [
  {
    id: "overview",
    title: "OVERVIEW",
    defaultOpen: true,
    pages: [
      {
        slug: "overview/first-steps",
        title: "First steps",
        file: "overview/first-steps.md",
        description:
          "Install Bunest, configure tsconfig.json for legacy decorators, and boot your first application.",
        keywords: [
          "setup",
          "install",
          "tsconfig",
          "reflect-metadata",
          "BunestFactory",
          "verbatimModuleSyntax",
          "ADR-002",
        ],
      },
      {
        slug: "overview/controllers",
        title: "Controllers",
        file: "overview/controllers.md",
        description:
          "Handle incoming HTTP requests with @Controller, method decorators, parameter binding, and status codes.",
        keywords: [
          "@Controller",
          "@Get",
          "@Post",
          "@Put",
          "@Patch",
          "@Delete",
          "@Body",
          "@Param",
          "@Query",
          "@Headers",
          "@HttpCode",
          "@Header",
          "@Redirect",
          "routing",
          "RFC-001",
          "ADR-003",
          "ADR-006",
        ],
      },
      {
        slug: "overview/providers",
        title: "Providers",
        file: "overview/providers.md",
        description:
          "Services, repositories, dependency injection via constructor types, and @Injectable() metadata.",
        keywords: [
          "@Injectable",
          "@Inject",
          "@Optional",
          "DI",
          "dependency injection",
          "services",
          "design:paramtypes",
        ],
      },
      {
        slug: "overview/modules",
        title: "Modules",
        file: "overview/modules.md",
        description:
          "Organize application structure with @Module(), provider encapsulation, re-exports, @Global(), and DynamicModule.",
        keywords: [
          "@Module",
          "@AutoModule",
          "@Global",
          "@RegisterIf",
          "@RegisterIfEnv",
          "@RegisterIfMissing",
          "@Profile",
          "DynamicModule",
          "exports",
          "imports",
          "re-export",
          "forRoot",
          "ADR-007",
          "ADR-018",
        ],
      },
      {
        slug: "overview/middleware",
        title: "Middleware",
        file: "overview/middleware.md",
        description:
          "Intercept requests before guards and route handlers with BunestMiddleware and MiddlewareConsumer.",
        keywords: [
          "BunestMiddleware",
          "MiddlewareConsumer",
          "BunestModule",
          "configure",
          "forRoutes",
          "exclude",
          "app.use",
        ],
      },
      {
        slug: "overview/exception-filters",
        title: "Exception filters",
        file: "overview/exception-filters.md",
        description:
          "Centralized error handling with HttpException, built-in HTTP exceptions, @Catch(), and @UseFilters().",
        keywords: [
          "HttpException",
          "BadRequestException",
          "NotFoundException",
          "UnauthorizedException",
          "ForbiddenException",
          "@Catch",
          "@UseFilters",
          "APP_FILTER",
          "ExceptionFilter",
        ],
      },
      {
        slug: "overview/pipes",
        title: "Pipes",
        file: "overview/pipes.md",
        description:
          "Transform and validate route inputs with built-in parse pipes, custom PipeTransform, and @UsePipes().",
        keywords: [
          "PipeTransform",
          "@UsePipes",
          "APP_PIPE",
          "ParseIntPipe",
          "ParseFloatPipe",
          "ParseBoolPipe",
          "ParseUUIDPipe",
          "ParseEnumPipe",
          "ParseArrayPipe",
          "DefaultValuePipe",
        ],
      },
      {
        slug: "overview/guards",
        title: "Guards",
        file: "overview/guards.md",
        description:
          "Implement authentication and role-based authorization with CanActivate, Reflector, and @UseGuards().",
        keywords: [
          "CanActivate",
          "@UseGuards",
          "APP_GUARD",
          "Reflector",
          "@SetMetadata",
          "auth",
          "RBAC",
        ],
      },
      {
        slug: "overview/interceptors",
        title: "Interceptors",
        file: "overview/interceptors.md",
        description:
          "Wrap route execution with Bunest's zero-RxJS Promise onion CallHandler, response mapping, and caching.",
        keywords: [
          "BunestInterceptor",
          "CallHandler",
          "@UseInterceptors",
          "APP_INTERCEPTOR",
          "onion",
          "Promise",
          "ADR-008",
        ],
      },
      {
        slug: "overview/custom-decorators",
        title: "Custom decorators",
        file: "overview/custom-decorators.md",
        description:
          "Create reusable parameter decorators with createParamDecorator() and typed metadata decorators via Reflector.",
        keywords: [
          "createParamDecorator",
          "Reflector.createDecorator",
          "@SetMetadata",
          "CustomDecorator",
          "ADR-004",
        ],
      },
      {
        slug: "overview/decorators",
        title: "Decorators reference",
        file: "overview/decorators.md",
        badge: "447",
        description:
          "Complete reference of all 447 built-in Bunest decorators across 15 packages with usage tables and code examples.",
        keywords: [
          "decorators",
          "reference",
          "catalog",
          "@Controller",
          "@Injectable",
          "@Data",
          "@Builder",
          "@Memoize",
          "@Transactional",
          "@Cacheable",
          "@Retry",
          "@WithLock",
          "@ApiProperty",
          "@IsEmail",
          "@Tool",
          "@Workflow",
        ],
      },
    ],
  },
  {
    id: "fundamentals",
    title: "FUNDAMENTALS",
    defaultOpen: false,
    pages: [
      {
        slug: "fundamentals/custom-providers",
        title: "Custom providers",
        file: "fundamentals/custom-providers.md",
        description:
          "Configure DI tokens using useClass, useValue, async useFactory, useExisting, and optional factory dependencies.",
        keywords: [
          "useClass",
          "useValue",
          "useFactory",
          "useExisting",
          "InjectionToken",
          "Provider",
          "async provider",
        ],
      },
      {
        slug: "fundamentals/injection-scopes",
        title: "Injection scopes",
        file: "fundamentals/injection-scopes.md",
        badge: "Strict",
        description:
          "Singleton, Transient, and Request scopes with AsyncLocalStorage propagation and fail-fast ScopeLeakException.",
        keywords: [
          "Scope.SINGLETON",
          "Scope.TRANSIENT",
          "Scope.REQUEST",
          "ScopeLeakException",
          "AsyncLocalStorage",
          "RequestContainer",
          "REQUEST",
          "REQUEST_CONTEXT",
          "ADR-012",
        ],
      },
      {
        slug: "fundamentals/circular-dependency",
        title: "Circular dependency",
        file: "fundamentals/circular-dependency.md",
        description:
          "Detect dependency cycles at bootstrap and resolve intentional cycles with forwardRef().",
        keywords: [
          "forwardRef",
          "CircularDependencyException",
          "cycle",
          "DFS",
          "ADR-007",
        ],
      },
      {
        slug: "fundamentals/module-reference",
        title: "Module reference",
        file: "fundamentals/module-reference.md",
        description:
          "Dynamically retrieve or instantiate providers using ModuleRef.get(), resolve(), and create().",
        keywords: ["ModuleRef", "strict", "resolve", "create", "DIContainer"],
      },
      {
        slug: "fundamentals/lifecycle-events",
        title: "Lifecycle events",
        file: "fundamentals/lifecycle-events.md",
        description:
          "Hook into deterministic topological bootstrap and reverse-order graceful shutdown lifecycle hooks.",
        keywords: [
          "OnModuleInit",
          "OnApplicationBootstrap",
          "OnModuleDestroy",
          "BeforeApplicationShutdown",
          "OnApplicationShutdown",
          "OnRequestDestroy",
          "LifecycleManager",
        ],
      },
      {
        slug: "fundamentals/execution-context",
        title: "Execution context",
        file: "fundamentals/execution-context.md",
        description:
          "Inspect the active controller class, handler method, Reflector metadata, and native Web Request via ExecutionContext.",
        keywords: [
          "ExecutionContext",
          "ArgumentsHost",
          "switchToHttp",
          "getClass",
          "getHandler",
          "Reflector",
          "getAllAndOverride",
          "getAllAndMerge",
        ],
      },
      {
        slug: "fundamentals/testing",
        title: "Testing",
        file: "fundamentals/testing.md",
        badge: "E2E & DI",
        description:
          "Unit and E2E testing with @bunest/testing: Test.createTestingModule, overrides, auto-mocking, zero-socket request(app), TestClient, app.inject(), SSE, and ContextId.",
        keywords: [
          "@bunest/testing",
          "Test",
          "createTestingModule",
          "TestingModule",
          "TestingModuleBuilder",
          "overrideProvider",
          "overrideGuard",
          "overridePipe",
          "overrideInterceptor",
          "overrideFilter",
          "overrideModule",
          "useMocker",
          "createAutoMocker",
          "ModuleMocker",
          "TestingLogger",
          "CapturingLogger",
          "ContextIdFactory",
          "registerRequestByContextId",
          "TestClient",
          "TestAgent",
          "request",
          "supertest",
          "inject",
          "readSseEvents",
          "createNodeHttpServer",
          "createMockExecutionContext",
          "e2e",
          "bun:test",
        ],
      },
    ],
  },
  {
    id: "techniques",
    title: "TECHNIQUES",
    defaultOpen: false,
    pages: [
      {
        slug: "techniques/validation",
        title: "Validation",
        file: "techniques/validation.md",
        badge: "Core",
        description:
          "Secure-by-default DTO validation with ValidationPipe, class-validator, prototype-pollution guards, and SchemaValidationPipe (Zod/Valibot).",
        keywords: [
          "ValidationPipe",
          "SchemaValidationPipe",
          "class-validator",
          "class-transformer",
          "whitelist",
          "forbidNonWhitelisted",
          "prototype pollution",
          "Zod",
          "ADR-005",
          "ADR-009",
        ],
      },
      {
        slug: "techniques/serialization",
        title: "Serialization",
        file: "techniques/serialization.md",
        description:
          "Strip sensitive fields and shape responses cleanly with ClassSerializerInterceptor and @SerializeOptions().",
        keywords: [
          "ClassSerializerInterceptor",
          "@SerializeOptions",
          "@Exclude",
          "@Expose",
          "instanceToPlain",
          "@bunest/validation",
        ],
      },
      {
        slug: "techniques/cookies-cors",
        title: "Cookies & CORS",
        file: "techniques/cookies-cors.md",
        description:
          "Read native Bun CookieMap via @Cookies(), append Set-Cookie via @Res(), and configure CORS preflight & origins.",
        keywords: [
          "@Cookies",
          "CookieOptions",
          "CorsOptions",
          "Set-Cookie",
          "preflight",
          "OPTIONS",
          "@Ip",
          "trustProxy",
        ],
      },
      {
        slug: "techniques/streaming-uploads",
        title: "Streaming & File upload",
        file: "techniques/streaming-uploads.md",
        description:
          "Zero-copy Bun.file() responses, ReadableStream passthrough, and multipart @UploadedFile / @UploadedFiles.",
        keywords: [
          "Bun.file",
          "ReadableStream",
          "Blob",
          "@UploadedFile",
          "@UploadedFiles",
          "UploadedFileInfo",
          "multipart",
          "sendfile",
        ],
      },
      {
        slug: "techniques/sse",
        title: "Server-Sent Events",
        file: "techniques/sse.md",
        description:
          "Push real-time events over HTTP using @Sse(), AsyncIterable<SseMessageEvent>, and automatic abort cleanup.",
        keywords: [
          "@Sse",
          "SseMessageEvent",
          "text/event-stream",
          "AsyncGenerator",
          "request.signal",
          "ADR-010",
        ],
      },
      {
        slug: "techniques/logger",
        title: "Logger",
        file: "techniques/logger.md",
        description:
          "Structured text and JSON logging with automatic deep secret redaction built into @bunest/core.",
        keywords: [
          "Logger",
          "LoggerService",
          "LoggerOptions",
          "DEFAULT_REDACT_KEYS",
          "redact",
          "json",
          "LogLevel",
        ],
      },
      {
        slug: "techniques/configuration",
        title: "Configuration",
        file: "techniques/configuration.md",
        description:
          "Typed .env loading, variable expansion, registerAs namespaces, DTO/Standard Schema validation, and @InjectConfig/@ConfigValue via @bunest/core/config.",
        keywords: [
          "@bunest/core/config",
          "ConfigModule",
          "ConfigService",
          "registerAs",
          "@InjectConfig",
          "@ConfigValue",
          "ConditionalModule",
        ],
      },
      {
        slug: "techniques/caching",
        title: "Caching",
        file: "techniques/caching.md",
        description:
          "Declarative @Cacheable/@CacheEvict/@CachePut service aspects, CacheInterceptor, MemoryCacheStore, and RedisCacheStore via @bunest/cache.",
        keywords: [
          "@bunest/cache",
          "CacheModule",
          "CacheService",
          "CacheInterceptor",
          "@Cacheable",
          "@CacheEvict",
          "@CachePut",
          "MemoryCacheStore",
          "RedisCacheStore",
        ],
      },
      {
        slug: "techniques/task-scheduling",
        title: "Task scheduling",
        file: "techniques/task-scheduling.md",
        description:
          "Pure-TS 5/6-field DST-aware cron jobs, @Cron, CronExpression, @Interval, @Timeout, and SchedulerRegistry via @bunest/jobs/scheduler.",
        keywords: [
          "@bunest/jobs/scheduler",
          "ScheduleModule",
          "@Cron",
          "CronExpression",
          "@Interval",
          "@Timeout",
          "SchedulerRegistry",
        ],
      },
      {
        slug: "techniques/events",
        title: "Events",
        file: "techniques/events.md",
        description:
          "In-process event dispatching with EventEmitterModule, @OnEvent, @EmitEvent, @EventPayload, and wildcard matching via @bunest/messaging/events.",
        keywords: [
          "@bunest/messaging/events",
          "EventEmitterModule",
          "EventEmitter2",
          "@OnEvent",
          "@EmitEvent",
          "@EventPayload",
        ],
      },
      {
        slug: "techniques/queues",
        title: "Queues",
        file: "techniques/queues.md",
        description:
          "Background job queues with @bunest/jobs/queues (QueueModule & BullModule/BullMQModule) using MemoryQueueDriver and atomic Lua RedisQueueDriver.",
        keywords: [
          "@bunest/jobs/queues",
          "QueueModule",
          "BullModule",
          "BullMQModule",
          "@Processor",
          "@Process",
          "WorkerHost",
          "FlowProducer",
        ],
      },
      {
        slug: "techniques/http-client",
        title: "HTTP client",
        file: "techniques/http-client.md",
        description:
          "Zero-dependency native fetch() HTTP client with named clients, retries, timeouts, interceptors, and typed errors via @bunest/core/client.",
        keywords: [
          "@bunest/core/client",
          "HttpClientModule",
          "HttpClient",
        ],
      },
      {
        slug: "techniques/i18n",
        title: "Internationalization (i18n)",
        file: "techniques/i18n.md",
        description:
          "Per-request AsyncLocalStorage locale resolution, typed translations, Intl formatting, and localized validation via @bunest/core/i18n.",
        keywords: [
          "@bunest/core/i18n",
          "I18nModule",
          "I18nService",
          "@CurrentLocale",
          "I18nContext",
        ],
      },
      {
        slug: "techniques/mail",
        title: "Mail",
        file: "techniques/mail.md",
        description:
          "Typed mail classes, HTML templates, and native SMTP, Resend, Postmark, SendGrid & SES transports via @bunest/mail.",
        keywords: [
          "@bunest/mail",
          "MailModule",
          "MailService",
          "ResendTransport",
          "SmtpTransport",
          "InMemoryMailTransport",
        ],
      },
      {
        slug: "techniques/storage",
        title: "Storage & Static files",
        file: "techniques/storage.md",
        description:
          "Multi-disk local/memory/S3/R2/MinIO object storage with WebCrypto SigV4 (@bunest/storage) and static serving via @bunest/core/http (ServeStaticModule).",
        keywords: [
          "@bunest/storage",
          "@bunest/core/http",
          "StorageModule",
          "LocalDisk",
          "S3Disk",
          "ServeStaticModule",
        ],
      },
      {
        slug: "techniques/mapped-types",
        title: "Mapped types",
        file: "techniques/mapped-types.md",
        description:
          "Derive DTO classes while preserving validation and OpenAPI metadata using PartialType, PickType, OmitType, and IntersectionType from @bunest/validation / @bunest/core.",
        keywords: [
          "@bunest/validation",
          "@bunest/core",
          "PartialType",
          "PickType",
          "OmitType",
          "IntersectionType",
          "CompositionType",
        ],
      },
      {
        slug: "techniques/service-aop",
        title: "Service-Layer AOP",
        file: "techniques/service-aop.md",
        badge: "ADR-014",
        description:
          "Zero-overhead DIContainer MethodAspectWeaver, createMethodAspectDecorator, @UseMiddleware, and declarative service decorators.",
        keywords: [
          "ADR-014",
          "ADR-018",
          "MethodAspectWeaver",
          "createMethodAspectDecorator",
          "AspectPhase",
          "defineAspectPipeline",
          "createTypedAspect",
          "AopModule",
          "PointcutRule",
          "registerGlobalPointcuts",
          "@UseMiddleware",
          "@InheritMethodEnhancers",
          "@WithCls",
          "AOP",
        ],
      },
    ],
  },
  {
    id: "data",
    title: "DATA & PERSISTENCE",
    defaultOpen: false,
    pages: [
      {
        slug: "data/orm-adapters",
        title: "Bunest ORM (@bunest/orm)",
        file: "data/orm-adapters.md",
        badge: "Native",
        description:
          "Circular-safe, zero-dep Bun-native ORM covering 12 database dialects over bun:sqlite, Bun.SQL, fetch(), and Bun.connect(), with @Repository, CrudRepository, @Transactional, OrmMigrationRunner, and SQL Store Kit subpaths.",
        keywords: [
          "@bunest/orm",
          "OrmModule",
          "DataSource",
          "Repository",
          "CrudRepository",
          "@Repository",
          "registerQueryOperator",
          "@RepositoryScope",
          "@SoftDelete",
          "@TenantScoped",
          "@IgnoreScope",
          "@Projection",
          "Page",
          "Pageable",
          "CursorPage",
          "CursorPageable",
          "composeRepository",
          "withSoftDelete",
          "withCursorPagination",
          "MongoRepository",
          "OrmMigrationRunner",
          "@Transactional",
          "Entity",
          "Embedded",
          "Relation",
        ],
      },
      {
        slug: "data/sqlite",
        title: "SQLite (bun:sqlite)",
        file: "data/sqlite.md",
        badge: "Native",
        description:
          "Bun-native bun:sqlite via @bunest/orm (SqliteOrmDriver) with @Transactional, Spring Data-style @Repository/CrudRepository derived finders, @Query, and OrmMigrationRunner.",
        keywords: [
          "@bunest/orm",
          "OrmModule",
          "DataSource",
          "SqliteOrmDriver",
          "@Repository",
          "CrudRepository",
          "@Transactional",
          "@Query",
          "@Modifying",
          "@SqlParam",
          "OrmMigrationRunner",
        ],
      },
      {
        slug: "data/sql",
        title: "SQL (Bun.SQL)",
        file: "data/sql.md",
        badge: "Native",
        description:
          "Multi-dialect Bun.SQL (Postgres/MySQL/MariaDB/SQLite) and edge HTTP drivers via @bunest/orm with BunSqlOrmDriver, @Transactional, and dialect-aware @Repository/CrudRepository.",
        keywords: [
          "@bunest/orm",
          "OrmModule",
          "DataSource",
          "BunSqlOrmDriver",
          "LibSqlOrmDriver",
          "D1OrmDriver",
          "ReplicatedOrmDriver",
          "@Repository",
          "CrudRepository",
          "@Query",
          "@Transactional",
        ],
      },
      {
        slug: "data/elasticsearch",
        title: "Elasticsearch",
        file: "data/elasticsearch.md",
        description:
          "@nestjs/elasticsearch v12 parity with a full Bun-native fetch() REST client.",
        keywords: [
          "@bunest/elasticsearch",
          "ElasticsearchModule",
          "ElasticsearchService",
        ],
      },
      {
        slug: "data/store-kit",
        title: "Store kit (@bunest/orm/store)",
        file: "data/store-kit.md",
        description:
          "Foundational Bun.SQL store kit built into @bunest/orm (./store, ./postgres, ./mysql, ./testing) with versioned migrations, CLI, and contract testing.",
        keywords: [
          "@bunest/orm/store",
          "@bunest/orm/postgres",
          "@bunest/orm/mysql",
          "@bunest/orm/testing",
          "runStoreCli",
          "postgres",
          "mysql",
          "migrations",
        ],
      },
    ],
  },
  {
    id: "security",
    title: "SECURITY & IDENTITY",
    defaultOpen: false,
    pages: [
      {
        slug: "security/security-module",
        title: "Security, JWT & Throttler",
        file: "security/security-module.md",
        description:
          "SecurityModule.forRoot, @Auth, @Protected, WebCrypto JWT/JWKS, PassportModule/AuthGuard, Argon2id passwords, RBAC, CSRF, and ThrottlerModule via @bunest/security.",
        keywords: [
          "@bunest/security",
          "SecurityModule",
          "JwtModule",
          "PassportModule",
          "ThrottlerModule",
          "@Auth",
          "PasswordService",
        ],
      },
      {
        slug: "security/authentication",
        title: "Authentication",
        file: "security/authentication.md",
        description:
          "Full identity suite: sessions, JWT/JWKS, refresh-token families, TOTP MFA, magic links, OIDC/OAuth2, and API keys via @bunest/security/auth.",
        keywords: [
          "@bunest/security/auth",
          "AuthenticationModule",
          "AuthenticationGuard",
          "@Authenticate",
          "ApiKeyProvider",
        ],
      },
      {
        slug: "security/authorization",
        title: "Authorization",
        file: "security/authorization.md",
        description:
          "Policy-based authorization with @Policy classes, @Can/@Can.Anyone, AuthorizationService, and audit events via @bunest/security/authz.",
        keywords: [
          "@bunest/security/authz",
          "AuthorizationModule",
          "AuthorizationService",
          "@Policy",
          "@Can",
        ],
      },
    ],
  },
  {
    id: "apis",
    title: "API, GRAPHQL & REALTIME",
    defaultOpen: false,
    pages: [
      {
        slug: "apis/openapi",
        title: "OpenAPI (Swagger)",
        file: "apis/openapi.md",
        description:
          "OpenAPI 3.1 document generation, DocumentBuilder, @Api* decorators, and Interactive Try-It-Out UI via @bunest/swagger.",
        keywords: [
          "@bunest/swagger",
          "SwaggerModule",
          "DocumentBuilder",
          "@ApiTags",
          "@ApiProperty",
          "OpenAPI",
        ],
      },
      {
        slug: "apis/graphql",
        title: "GraphQL & Apollo",
        file: "apis/graphql.md",
        description:
          "Code-first & schema-first GraphQL, Federation v2 Subgraph/Gateway, BunestDataLoader, and subscriptions via @bunest/graphql & @bunest/graphql/apollo.",
        keywords: [
          "@bunest/graphql",
          "@bunest/graphql/apollo",
          "GraphQLModule",
          "ApolloDriver",
          "ApolloFederationDriver",
          "ApolloGatewayDriver",
          "BunestDataLoader",
        ],
      },
      {
        slug: "apis/websockets",
        title: "WebSockets",
        file: "apis/websockets.md",
        description:
          "Native Bun.serve({ websocket }) gateways with @WebSocketGateway, @SubscribeMessage, @Ack, rooms, and enhancers via @bunest/core/ws.",
        keywords: [
          "@bunest/core/ws",
          "@WebSocketGateway",
          "@SubscribeMessage",
          "@Ack",
          "BunWebSocketAdapter",
        ],
      },
    ],
  },
  {
    id: "distributed",
    title: "DISTRIBUTED & RELIABILITY",
    defaultOpen: false,
    pages: [
      {
        slug: "distributed/microservices",
        title: "Microservices",
        file: "distributed/microservices.md",
        description:
          "@MessagePattern, @EventPattern, @GrpcMethod, ClientProxy, hybrid apps, and TCP/InMemory/gRPC/Kafka/MQTT/Redis/NATS/RabbitMQ transports.",
        keywords: [
          "@bunest/microservices",
          "@MessagePattern",
          "@EventPattern",
          "@GrpcMethod",
          "ClientProxy",
          "Transport",
        ],
      },
      {
        slug: "distributed/cqrs",
        title: "CQRS",
        file: "distributed/cqrs.md",
        description:
          "Zero-RxJS CommandBus, QueryBus, EventBus, AggregateRoot, EventPublisher, and @Saga via @bunest/messaging/cqrs.",
        keywords: [
          "@bunest/messaging/cqrs",
          "CqrsModule",
          "CommandBus",
          "QueryBus",
          "EventBus",
          "AggregateRoot",
          "@Saga",
        ],
      },
      {
        slug: "distributed/resilience",
        title: "Resilience",
        file: "distributed/resilience.md",
        description:
          "Retry, Timeout, CircuitBreaker, Bulkhead, RateLimit, and Fallback policies for both controllers and @Injectable() services.",
        keywords: [
          "@bunest/resilience",
          "ResilienceModule",
          "@Retry",
          "@Timeout",
          "@CircuitBreaker",
          "@Bulkhead",
          "@Fallback",
        ],
      },
      {
        slug: "distributed/locks-idempotency",
        title: "Locks & Idempotency",
        file: "distributed/locks-idempotency.md",
        description:
          "Distributed leased locks with fencing tokens (@WithLock, LeaderElection) and @Idempotent request deduplication.",
        keywords: [
          "@bunest/resilience/locks",
          "@bunest/resilience/idempotency",
          "LocksModule",
          "@WithLock",
          "LeaderElection",
          "IdempotencyModule",
          "@Idempotent",
        ],
      },
      {
        slug: "distributed/outbox-webhooks",
        title: "Outbox & Webhooks",
        file: "distributed/outbox-webhooks.md",
        description:
          "Transactional outbox/inbox relay (@bunest/messaging/outbox) and HMAC-signed, SSRF-protected webhooks (@bunest/messaging/webhooks).",
        keywords: [
          "@bunest/messaging/outbox",
          "@bunest/messaging/webhooks",
          "OutboxModule",
          "@OnOutboxMessage",
          "WebhooksModule",
          "@VerifyWebhook",
        ],
      },
      {
        slug: "distributed/workflows",
        title: "Durable workflows",
        file: "distributed/workflows.md",
        description:
          "Plain-async durable workflows with deterministic replay, signals, timers, sagas, schedules, and SQL stores via @bunest/workflows.",
        keywords: [
          "@bunest/workflows",
          "WorkflowsModule",
          "InMemoryWorkflowStore",
          "AesGcmPayloadCodec",
        ],
      },
    ],
  },
  {
    id: "ai",
    title: "AI & AGENTS",
    defaultOpen: false,
    pages: [
      {
        slug: "ai/ai-sdk",
        title: "AI SDK",
        file: "ai/ai-sdk.md",
        description:
          "Native OpenAI/Anthropic/Gemini SSE clients, generateText, generateObject, streamText, embeddings, @AgentFunction, and durable agent workflows.",
        keywords: [
          "@bunest/ai",
          "AiModule",
          "AiService",
          "@AgentFunction",
          "generateText",
          "generateObject",
        ],
      },
      {
        slug: "ai/mcp",
        title: "Model Context Protocol (MCP)",
        file: "ai/mcp.md",
        description:
          "Expose @Tool, @Resource, @ResourceTemplate, and @Prompt over Streamable HTTP, SSE, and stdio JSON-RPC 2.0 via @bunest/ai/mcp.",
        keywords: ["@bunest/ai/mcp", "McpModule", "@Tool", "@Resource", "@Prompt"],
      },
    ],
  },
  {
    id: "observability",
    title: "OBSERVABILITY & DX",
    defaultOpen: false,
    pages: [
      {
        slug: "observability/observability",
        title: "Observability, Health & Devtools",
        file: "observability/observability.md",
        description:
          "ObservabilityModule, @Span/@Timed/@Counted, W3C tracing, Prometheus metrics, TerminusModule/HealthModule health checks, and DevtoolsModule via @bunest/observability.",
        keywords: [
          "@bunest/observability",
          "ObservabilityModule",
          "@Span",
          "@Timed",
          "@Counted",
          "TerminusModule",
          "HealthCheckService",
          "DevtoolsModule",
        ],
      },
      {
        slug: "observability/cli",
        title: "CLI",
        file: "observability/cli.md",
        description:
          "Project scaffolding, schematics, bunest.config.ts, unified createBunestPlugin(), custom Class Macros, extensible typegen plugins, and custom architecture rules via @bunest/cli.",
        keywords: [
          "@bunest/cli",
          "bunest new",
          "bunest generate",
          "bunest build",
          "bunest typegen",
          "bunest check",
          "bunest delombok",
          "bunest.config.ts",
          "defineBunestConfig",
          "createBunestPlugin",
          "defineClassMacro",
          "defineMacroPreset",
          "setGlobalMacroDefaults",
          "defineTypegenPlugin",
          "defineDiagnosticRule",
          "BUNEST_ARCH001",
          "BUNEST_ARCH002",
          "bunestMetadataPlugin",
          "ADR-018",
        ],
      },
    ],
  },
  {
    id: "architecture",
    title: "ARCHITECTURE & ADRs",
    defaultOpen: false,
    pages: [
      {
        slug: "architecture/execution-pipeline",
        title: "11-Stage Execution Pipeline",
        file: "architecture/execution-pipeline.md",
        badge: "ADR-008",
        description:
          "Normative 11-stage HTTP request lifecycle, precedence matrix, and exception filter boundary.",
        keywords: [
          "pipeline",
          "ADR-008",
          "order",
          "precedence",
          "onion",
          "DefaultExceptionFilter",
        ],
      },
      {
        slug: "architecture/hybrid-router",
        title: "Hybrid Bun.serve Router",
        file: "architecture/hybrid-router.md",
        badge: "ADR-011",
        description:
          "How Bunest compiles controllers into native Bun.serve({ routes }) Zig closures plus a controlled fallback radix router.",
        keywords: [
          "Bun.serve",
          "routes",
          "fallback",
          "radix",
          "405",
          "Allow",
          "DuplicateRouteException",
          "ADR-011",
        ],
      },
      {
        slug: "architecture/response-serialization",
        title: "Response Serialization",
        file: "architecture/response-serialization.md",
        badge: "ADR-010",
        description:
          "Return value priority matrix, RFC 9110 empty-body enforcement, default status codes, and header merge precedence.",
        keywords: [
          "Response",
          "ResponseContext",
          "status codes",
          "201",
          "204",
          "RFC 9110",
          "ADR-010",
        ],
      },
      {
        slug: "architecture/adrs",
        title: "ADR & RFC Index",
        file: "architecture/adrs.md",
        description:
          "Complete index of Bunest Architecture Decision Records (ADR-001 through ADR-018) and RFC-001.",
        keywords: [
          "ADR-001",
          "ADR-002",
          "ADR-003",
          "ADR-004",
          "ADR-005",
          "ADR-006",
          "ADR-007",
          "ADR-008",
          "ADR-009",
          "ADR-010",
          "ADR-011",
          "ADR-012",
          "ADR-013",
          "ADR-014",
          "ADR-015",
          "ADR-016",
          "ADR-017",
          "ADR-018",
          "RFC-001",
        ],
      },
      {
        slug: "architecture/migration-from-nestjs",
        title: "Migration from NestJS",
        file: "architecture/migration-from-nestjs.md",
        description:
          "Key differences, drop-in similarities, and migration checklist for teams coming from NestJS on Node.js.",
        keywords: [
          "migration",
          "nestjs",
          "express",
          "fastify",
          "rxjs",
          "differences",
          "comparison",
        ],
      },
    ],
  },
  {
    id: "recipes",
    title: "RECIPES",
    defaultOpen: false,
    pages: [
      {
        slug: "recipes/deployment",
        title: "Deployment & Production",
        file: "recipes/deployment.md",
        description:
          "Multi-stage Dockerfiles, bun build --compile binaries, graceful shutdown, health probes, and a production checklist.",
        keywords: [
          "deployment",
          "docker",
          "bun build --compile",
          "graceful shutdown",
          "health check",
          "production",
          "checklist",
        ],
      },
      {
        slug: "recipes/repl",
        title: "REPL",
        file: "recipes/repl.md",
        description:
          "Inspect modules, resolve DI providers, and invoke service methods interactively with repl() and bunest repl.",
        keywords: ["repl", "bunest repl", "createReplContext", "debug", "methods"],
      },
      {
        slug: "recipes/class-macros",
        title: "Class & Method Macros",
        file: "recipes/class-macros.md",
        badge: "27",
        description:
          "Eliminate boilerplate with 27 Lombok-inspired zero-dependency macros: @Data, @Value, @Builder, @With, @Memoize, @Synchronized.",
        keywords: [
          "@Data",
          "@Value",
          "@Builder",
          "@SuperBuilder",
          "@Getter",
          "@Setter",
          "@With",
          "@Memoize",
          "@LogExecution",
          "@Synchronized",
          "@Secret",
          "macros",
          "lombok",
        ],
      },
      {
        slug: "recipes/versioning",
        title: "API Versioning",
        file: "recipes/versioning.md",
        description:
          "Configure URI, Header, Media Type, and Custom API versioning with @Version() and VERSION_NEUTRAL.",
        keywords: [
          "versioning",
          "VersioningType",
          "@Version",
          "VERSION_NEUTRAL",
          "enableVersioning",
        ],
      },
      {
        slug: "recipes/vscode-extension",
        title: "VS Code Extension",
        file: "recipes/vscode-extension.md",
        description:
          "Zero-save typegen, declarative repository SQL preview, Delombok hover, diagnostics, DI graph, and inline HTTP runner.",
        keywords: [
          "vscode",
          "extension",
          "delombok",
          "typegen",
          "sql preview",
          "di graph",
          "http runner",
        ],
      },
    ],
  },
  {
    id: "faq",
    title: "FAQ & ERRORS",
    defaultOpen: false,
    pages: [
      {
        slug: "faq/common-errors",
        title: "Error Catalog (BUNEST_E*)",
        file: "faq/common-errors.md",
        description:
          "Complete troubleshooting reference for BUNEST_E001–BUNEST_E103 bootstrap, DI, scope-leak, and routing errors.",
        keywords: [
          "BUNEST_E001",
          "BUNEST_E002",
          "BUNEST_E003",
          "BUNEST_E004",
          "BUNEST_E101",
          "errors",
          "troubleshooting",
          "ScopeLeakException",
          "UnknownDependencyException",
        ],
      },
      {
        slug: "faq/faq",
        title: "Frequently Asked Questions",
        file: "faq/faq.md",
        description:
          "Answers to common questions: raw body, global prefix, hybrid apps, request lifecycle, multiple databases, and no-RxJS interceptors.",
        keywords: [
          "faq",
          "@RawBody",
          "setGlobalPrefix",
          "hybrid app",
          "multiple databases",
          "rxjs",
          "import type",
        ],
      },
    ],
  },
  {
    id: "ecosystem",
    title: "ECOSYSTEM",
    defaultOpen: false,
    pages: [
      {
        slug: "ecosystem/packages",
        title: "Packages & Monorepo",
        file: "ecosystem/packages.md",
        description:
          "Explore @bunest/core, @bunest/core, @bunest/core/http, @bunest/validation, @bunest/testing, and the monorepo layout.",
        keywords: [
          "@bunest/core",
          "@bunest/core",
          "@bunest/core/http",
          "@bunest/validation",
          "@bunest/testing",
          "monorepo",
          "workspaces",
        ],
      },
      {
        slug: "ecosystem/roadmap",
        title: "Implementation Roadmap",
        file: "ecosystem/roadmap.md",
        description:
          "8-phase Bunest roadmap, milestones from v0.1 to v1.0, quality gates, and benchmark methodology.",
        keywords: ["roadmap", "phases", "milestones", "v1.0", "benchmarks"],
      },
    ],
  },
];

export function normalizeBasePath(raw?: string): string {
  if (!raw) return "";
  const trimmed = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `/${trimmed}` : "";
}

export function getConfiguredBasePath(): string {
  return normalizeBasePath(
    process.env.DOCS_BASE_PATH ?? process.env.BASE_PATH ?? "",
  );
}

export function withBasePath(path: string, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  if (!base) return path;
  if (
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    path.startsWith("mailto:") ||
    path.startsWith("#")
  ) {
    return path;
  }
  if (path === "/" || path === "") {
    return `${base}/`;
  }
  if (
    path === base ||
    path.startsWith(`${base}/`) ||
    path.startsWith(`${base}#`)
  ) {
    return path;
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}

export function slugToHref(slug: string, basePath = ""): string {
  const raw = slug === "" ? "/" : `/${slug}`;
  return withBasePath(raw, basePath);
}

export function normalizePathname(pathname: string, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  let stripped = pathname;
  if (base && (stripped === base || stripped.startsWith(`${base}/`))) {
    stripped = stripped.slice(base.length);
  }
  const cleaned = stripped.replace(/\/+$/, "").replace(/^\/+/, "");
  if (
    cleaned === "" ||
    cleaned === "index.html" ||
    cleaned === "introduction"
  ) {
    return "";
  }
  return cleaned.replace(/\.html$/, "");
}

export function getFlattenedPages(): FlattenedPage[] {
  const rawList: Array<
    NavPage & { categoryId: string; categoryTitle: string }
  > = [
    {
      ...INTRO_PAGE,
      categoryId: "introduction",
      categoryTitle: "INTRODUCTION",
    },
  ];

  for (const category of NAV_CATEGORIES) {
    for (const page of category.pages) {
      rawList.push({
        ...page,
        categoryId: category.id,
        categoryTitle: category.title,
      });
    }
  }

  return rawList.map((item, idx) => {
    const prevItem = idx > 0 ? rawList[idx - 1] : undefined;
    const nextItem = idx < rawList.length - 1 ? rawList[idx + 1] : undefined;

    return {
      ...item,
      href: slugToHref(item.slug),
      prev: prevItem
        ? {
            title: prevItem.title,
            href: slugToHref(prevItem.slug),
            categoryTitle: prevItem.categoryTitle,
          }
        : undefined,
      next: nextItem
        ? {
            title: nextItem.title,
            href: slugToHref(nextItem.slug),
            categoryTitle: nextItem.categoryTitle,
          }
        : undefined,
    };
  });
}

export const ALL_PAGES: readonly FlattenedPage[] = getFlattenedPages();

const PAGE_MAP = new Map<string, FlattenedPage>(
  ALL_PAGES.map((p) => [p.slug, p]),
);

export function findPageBySlug(slug: string): FlattenedPage | undefined {
  return PAGE_MAP.get(normalizePathname(slug));
}
