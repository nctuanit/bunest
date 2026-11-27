# Decorators Reference

Use this reference to find decorators by package and import path.

> info **Legacy Decorators & `verbatimModuleSyntax`** Bunest uses TypeScript legacy decorators (`experimentalDecorators: true` + `emitDecoratorMetadata: true`). Always **value-import** DI classes, DTOs, and entities (never `import type`) so constructor metadata is emitted at runtime.

## Summary by Package

| Package | Decorators | Primary Domain | Guide |
| --- | ---: | --- | --- |
| [`@bunest/core`](#bunestcore) | — | DI, modules, HTTP/WebDAV, params, enhancers, config, WS, i18n | [Controllers](/overview/controllers) · [Service AOP](/techniques/service-aop) |
| [`@bunest/validation`](#bunestvalidation-119-decorators) | 119 | DTO validation (`validator`) & transformation (`transformer`) | [Validation](/techniques/validation) · [Serialization](/techniques/serialization) |
| [`@bunest/swagger`](#bunestswagger-79-decorators) | 79 | OpenAPI 3.1 operations, schemas, security & 50 status response shorthands | [OpenAPI](/apis/openapi) |
| [`@bunest/orm`](#bunestorm) | — | Entities, columns, relations, hooks, declarative repositories, transactions | [ORM & Adapters](/data/orm-adapters) |
| [`@bunest/graphql`](#bunestgraphql-23-decorators) | 23 | Code-first schema types, resolvers, arguments, Federation v2 & Apollo plugins | [GraphQL](/apis/graphql) |
| [`@bunest/security`](#bunestsecurity-14-decorators) | 14 | Auth, RBAC, ABAC policies, sessions & rate limiting | [Security](/security/security-module) · [Authorization](/security/authorization) |
| [`@bunest/messaging`](#bunestmessaging-12-decorators) | 12 | Domain events, CQRS handlers/sagas, transactional outbox & webhooks | [Events](/techniques/events) · [CQRS](/distributed/cqrs) · [Outbox & Webhooks](/distributed/outbox-webhooks) |
| [`@bunest/resilience`](#bunestresilience-12-decorators) | 12 | Retry, timeout, circuit breaker, bulkhead, fallback, locks & idempotency | [Resilience](/distributed/resilience) · [Locks & Idempotency](/distributed/locks-idempotency) |
| [`@bunest/jobs`](#bunestjobs-10-decorators) | 10 | Cron/interval/timeout scheduling & Redis/in-memory job queues | [Task Scheduling](/techniques/task-scheduling) · [Queues](/techniques/queues) |
| [`@bunest/microservices`](#bunestmicroservices-9-decorators) | 9 | RPC message/event patterns, payload/context binding & gRPC services | [Microservices](/distributed/microservices) |
| [`@bunest/ai`](#bunestai-7-decorators) | 7 | AI agent functions, model injection & MCP tools/resources/prompts | [AI SDK](/ai/ai-sdk) · [MCP](/ai/mcp) |
| [`@bunest/cache`](#bunestcache-6-decorators) | 6 | Method-level & HTTP response caching, eviction, key & TTL control | [Caching](/techniques/caching) |
| [`@bunest/observability`](#bunestobservability-5-decorators) | 5 | Tracing spans, latency timers, counters & health checks | [Observability](/observability/observability) |
| [`@bunest/workflows`](#bunestworkflows-3-decorators) | 3 | Durable workflow entrypoints & CQRS start/signal bindings | [Workflows](/distributed/workflows) |
| [`@bunest/storage`](#buneststorage-1-decorator) | 1 | Storage disk injection (local, memory, S3/R2/MinIO) | [Storage](/techniques/storage) |


---

## `@bunest/core`

### 1. DI and modules

Import from `@bunest/core`.

| Decorator | Target | Purpose |
| --- | --- | --- |
| `@Module(metadata)` | Class | Declares a module with `imports`, `controllers`, `providers`, `exports`. |
| `@AutoModule(options?)` | Class | Auto-discovers providers/controllers in the module directory. |
| `@Global()` | Class | Makes a module's exported providers available application-wide. |
| `@Injectable(options?)` | Class | Marks a class as a DI provider (`Scope.DEFAULT`, `REQUEST`, `TRANSIENT`, `durable`). |
| `@Inject(token)` | Param / Prop | Injects a provider by explicit token (string, symbol, or class). |
| `@Optional()` | Param / Prop | Marks a dependency as optional (`undefined` if unregistered). |
| `@Dependencies(...deps)` | Class | Declares constructor dependencies explicitly (useful in plain JS). |

### 2. HTTP & WebDAV Routing (25)

Import from `@bunest/core`.

| Decorator | Target | Purpose |
| --- | --- | --- |
| `@Controller(prefix \| options)` | Class | Registers an HTTP controller with optional route prefix, `host`, and `version`. |
| `@RequestMapping(metadata)` | Method | Low-level route decorator accepting `{ path, method }`. |
| `@Get(path?)`, `@Post(path?)`, `@Put(path?)`, `@Patch(path?)`, `@Delete(path?)`, `@Options(path?)`, `@Head(path?)`, `@All(path?)` | Method | Standard HTTP verb route handlers (8 decorators). |
| `@QueryMethod(path?)` | Method | HTTP `QUERY` verb route handler (safe, idempotent query with request body). |
| `@Propfind(path?)`, `@Proppatch(path?)`, `@Mkcol(path?)`, `@Copy(path?)`, `@Move(path?)`, `@Lock(path?)`, `@Unlock(path?)`, `@Search(path?)` | Method | WebDAV HTTP verb route handlers (8 decorators). |
| `@Sse(path?)` | Method | Declares a Server-Sent Events streaming endpoint. |
| `@Version(version)` | Method / Class | Pins a route or controller to one or more API versions (`"1"`, `VERSION_NEUTRAL`). |
| `@HttpCode(status)` | Method | Overrides the default HTTP response status code. |
| `@Header(name, value)` | Method | Sets a static response header on every response from the handler. |
| `@Redirect(url?, statusCode?)` | Method | Redirects the client (`302` by default; return `{ url, statusCode }` to override dynamically). |
| `@Render(template)` | Method | Renders a view template using the configured template engine. |

### 3. HTTP Parameter Extraction (19)

Import from `@bunest/core`.

| Decorator | Target | Purpose |
| --- | --- | --- |
| `@Param(key?, ...pipes)` | Param | Extracts route path parameters (`:id`). |
| `@Body(key?, ...pipes)` | Param | Extracts parsed request body (JSON, form, or text). |
| `@RawBody()` | Param | Extracts the unparsed raw `Uint8Array` / `Buffer` body (for webhook HMAC verification). |
| `@Query(key?, ...pipes)` | Param | Extracts URL query string parameters. |
| `@Headers(name?)` | Param | Extracts request headers (case-insensitive). |
| `@Cookies(name?)` | Param | Extracts parsed request cookies. |
| `@SignedCookies(name?)` | Param | Extracts HMAC-verified signed cookies. |
| `@Session()` | Param | Extracts the active request session object. |
| `@Ip()` | Param | Extracts the client IP address. |
| `@HostParam(key?)` | Param | Extracts dynamic host parameters when `@Controller({ host })` is used. |
| `@Req()` / `@Request()` | Param | Injects the underlying Bunest request wrapper. |
| `@Res(options?)` / `@Response(options?)` | Param | Injects the response object (`{ passthrough: true }` keeps auto-serialization). |
| `@Next()` | Param | Injects the middleware continuation function. |
| `@UploadedFile(...pipes)` | Param | Extracts a single multipart uploaded file. |
| `@UploadedFiles(...pipes)` | Param | Extracts multiple multipart uploaded files. |
| `@SseSignal()` | Param | Injects the `AbortSignal` that aborts when an SSE client disconnects. |
| `@Bind(...decorators)` | Method | Applies parameter decorators on a method (plain JS alternative to param decorators). |

@@filename(articles.controller.ts)

```ts
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Ip,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Sse,
  SseSignal,
  Version,
} from "@bunest/core";

@Controller("articles")
export class ArticlesController {
  @Get(":id")
  @Version("1")
  @Header("Cache-Control", "public, max-age=60")
  findOne(
    @Param("id", ParseIntPipe) id: number,
    @Query("expand") expand?: string,
    @Headers("accept-language") lang?: string,
    @Ip() ip?: string,
  ) {
    return { id, expand, lang, ip };
  }

  @Post()
  @HttpCode(201)
  create(@Body() dto: { title: string }) {
    return { created: dto.title };
  }

  @Sse("stream")
  async *stream(@SseSignal() signal: AbortSignal) {
    while (!signal.aborted) {
      yield { data: { ts: Date.now() } };
      await Bun.sleep(1000);
    }
  }
}
```

### 4. Enhancers, Metadata & Context (11)

Import from `@bunest/core`.

| Decorator | Target | Purpose |
| --- | --- | --- |
| `@UseGuards(...guards)` | Class / Method | Attaches authorization/authentication guards (`CanActivate`). |
| `@UseInterceptors(...interceptors)` | Class / Method | Attaches Promise-based interceptors (`BunestInterceptor`). |
| `@UsePipes(...pipes)` | Class / Method | Attaches transformation/validation pipes (`PipeTransform`). |
| `@UseFilters(...filters)` | Class / Method | Attaches exception filters (`ExceptionFilter`). |
| `@UseMiddleware(...middlewares)` | Class / Method | Declares route-scoped middleware directly on a controller or method. |
| `@Catch(...exceptions)` | Class | Declares which exception classes an `ExceptionFilter` handles. |
| `@SetMetadata(key, value)` | Class / Method | Attaches custom reflection metadata read via `Reflector`. |
| `@InheritMethodEnhancers(enabled?)` | Class | Controls whether subclass handlers inherit parent method enhancers (`true` by default). |
| `@WithCls(options?)` | Class / Method | Wraps service method execution in an `AsyncLocalStorage` CLS context. |
| `@SerializeOptions(options)` | Class / Method | Configures `ClassSerializerInterceptor` groups/exclusion per route (also in `@bunest/validation`). |
| `@UseStandardSchema(schema)` | Method / Param | Validates input using any Standard Schema v1 library (Zod, Valibot, ArkType; also in `@bunest/validation`). |

For older code using Lombok-style decorators, see [Migrating from class macros](/recipes/class-macros).

### 5. Config, HTTP Client, I18n & WebSockets (10)

| Subpath | Decorators | Purpose |
| --- | --- | --- |
| `@bunest/core/config` | `@ConfigValue(key, options?)`, `@InjectConfig(namespace?)` | Injects a typed config key or namespaced config object. |
| `@bunest/core/client` | `@InjectHttpClient(name?)` | Injects a named `HttpClient` instance. |
| `@bunest/core/i18n` | `@CurrentLocale()` | Extracts the resolved request locale (from ALS / `Accept-Language`). |
| `@bunest/core/ws` | `@WebSocketGateway(port \| options?)`, `@WebSocketServer()`, `@SubscribeMessage(event)`, `@MessageBody(key?)`, `@ConnectedSocket()`, `@Ack()` | Declares native `Bun.serve` WebSocket gateways, event handlers, payload/socket binding, and ack callbacks. |

@@filename(chat.gateway.ts)

```ts
import {
  Ack,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type BunWsClient,
  type BunWsServer,
} from "@bunest/core/ws";

@WebSocketGateway({ namespace: "/chat" })
export class ChatGateway {
  @WebSocketServer()
  server: BunWsServer;

  @SubscribeMessage("message")
  handleMessage(
    @MessageBody() payload: { room: string; text: string },
    @ConnectedSocket() client: BunWsClient,
    @Ack() ack?: (res: unknown) => void,
  ) {
    ack?.({ ok: true, from: client.id });
    return { event: "message", data: payload };
  }
}
```

---

## `@bunest/validation` (119 decorators)

> info `@SerializeOptions` and `@UseStandardSchema` are also exported from `@bunest/validation` (counted under `@bunest/core` above).

### 1. Validators (`@bunest/validation/validator` — 112 decorators)

Compiled once per DTO class into fast native checks (no `class-validator` dependency).

| Category | Decorators |
| --- | --- |
| **Common & Control** (12) | `@IsDefined`, `@IsOptional`, `@Allow`, `@Equals`, `@NotEquals`, `@IsEmpty`, `@IsNotEmpty`, `@IsIn`, `@IsNotIn`, `@ValidateIf`, `@ValidateNested`, `@ValidatePromise` |
| **Custom Validation** (3) | `@Validate`, `@ValidateBy`, `@ValidatorConstraint` |
| **Types** (10) | `@IsBoolean`, `@IsDate`, `@IsString`, `@IsNumber`, `@IsInt`, `@IsArray`, `@IsEnum`, `@IsObject`, `@IsNotEmptyObject`, `@IsInstance` |
| **Numbers** (7) | `@IsDivisibleBy`, `@IsPositive`, `@IsNegative`, `@Min`, `@Max`, `@MinDate`, `@MaxDate` |
| **Arrays** (6) | `@ArrayContains`, `@ArrayNotContains`, `@ArrayNotEmpty`, `@ArrayMinSize`, `@ArrayMaxSize`, `@ArrayUnique` |
| **Strings (Core & Length)** (17) | `@Contains`, `@NotContains`, `@IsAlpha`, `@IsAlphanumeric`, `@IsAscii`, `@IsByteLength`, `@Length`, `@MinLength`, `@MaxLength`, `@Matches`, `@IsLowercase`, `@IsUppercase`, `@IsMultibyte`, `@IsVariableWidth`, `@IsFullWidth`, `@IsHalfWidth`, `@IsSurrogatePair` |
| **Strings (Formats & Web)** (34) | `@IsEmail`, `@IsUrl`, `@IsUUID`, `@IsJSON`, `@IsJWT`, `@IsIP`, `@IsPort`, `@IsFQDN`, `@IsMACAddress`, `@IsMagnetURI`, `@IsDataURI`, `@IsMimeType`, `@IsBase32`, `@IsBase58`, `@IsBase64`, `@IsHexadecimal`, `@IsHexColor`, `@IsHSL`, `@IsRgbColor`, `@IsOctal`, `@IsDecimal`, `@IsNumberString`, `@IsBooleanString`, `@IsDateString`, `@IsISO8601`, `@IsRFC3339`, `@IsMilitaryTime`, `@IsSemVer`, `@IsHash`, `@IsStrongPassword`, `@IsTimeZone`, `@IsLocale`, `@IsMongoId`, `@IsFirebasePushId` |
| **Finance, Geo & IDs** (23) | `@IsCreditCard`, `@IsCurrency`, `@IsIBAN`, `@IsBIC`, `@IsBtcAddress`, `@IsEthereumAddress`, `@IsISO4217CurrencyCode`, `@IsEAN`, `@IsISBN`, `@IsISIN`, `@IsISRC`, `@IsISSN`, `@IsISO31661Alpha2`, `@IsISO31661Alpha3`, `@IsIdentityCard`, `@IsPassportNumber`, `@IsTaxId`, `@IsPhoneNumber`, `@IsMobilePhone`, `@IsPostalCode`, `@IsLatitude`, `@IsLongitude`, `@IsLatLong` |

### 2. Transformers (`@bunest/validation/transformer` — 7 decorators)

| Decorator | Target | Purpose |
| --- | --- | --- |
| `@Expose(options?)` | Class / Prop | Marks a property to be included during serialization/transformation (supports `name`, `groups`). |
| `@Exclude(options?)` | Class / Prop | Strips a property (e.g., `passwordHash`) when transforming to plain JSON. |
| `@Type(typeFn)` | Prop | Specifies the nested class constructor for recursive transformation & validation. |
| `@Transform(transformFn, options?)` | Prop | Runs a custom value transform during `plainToInstance` or `instanceToPlain`. |
| `@TransformPlainToInstance(cls, options?)` | Method | Transforms a method's return value from plain object to class instance. |
| `@TransformInstanceToPlain(options?)` | Method | Transforms a method's return value from class instance to plain object. |
| `@TransformInstanceToInstance(options?)` | Method | Clones/re-transforms a returned class instance with serialization rules. |

@@filename(create-user.dto.ts)

```ts
import {
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from "@bunest/validation/validator";
import { Exclude, Expose, Transform, Type } from "@bunest/validation/transformer";

export class AddressDto {
  @IsString()
  city: string;
}

export class CreateUserDto {
  @IsEmail()
  @Transform(({ value }) => String(value).trim().toLowerCase())
  email: string;

  @IsString()
  @MinLength(8)
  @Exclude({ toPlainOnly: true })
  password: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  @Expose()
  address?: AddressDto;
}
```

---

## `@bunest/swagger` (79 decorators)

Import from `@bunest/swagger`.

### Core OpenAPI Decorators (29)

| Group | Decorators |
| --- | --- |
| **Controllers & Operations** (7) | `@ApiTags`, `@ApiOperation`, `@ApiExcludeController`, `@ApiExcludeEndpoint`, `@ApiIncludeEndpoint`, `@ApiCallbacks`, `@ApiWebhook` |
| **Inputs & Media Types** (7) | `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiHeader`, `@ApiHeaders`, `@ApiConsumes`, `@ApiProduces` |
| **Schemas & Properties** (6) | `@ApiProperty`, `@ApiPropertyOptional`, `@ApiHideProperty`, `@ApiResponseProperty`, `@ApiSchema`, `@ApiExtraModels` |
| **Security** (6) | `@ApiBearerAuth`, `@ApiBasicAuth`, `@ApiOAuth2`, `@ApiCookieAuth`, `@ApiApiKey`, `@ApiSecurity` |
| **Extensions & Links** (3) | `@ApiExtension`, `@ApiLink`, `@ApiDefaultGetter` |

### Response Decorators (50)

- Base: `@ApiResponse(options)`, `@ApiDefaultResponse(options)`
- 48 HTTP status shorthands covering 1xx–5xx: `@ApiContinueResponse`, `@ApiSwitchingProtocolsResponse`, `@ApiProcessingResponse`, `@ApiEarlyhintsResponse`, `@ApiOkResponse`, `@ApiCreatedResponse`, `@ApiAcceptedResponse`, `@ApiNonAuthoritativeInformationResponse`, `@ApiNoContentResponse`, `@ApiResetContentResponse`, `@ApiPartialContentResponse`, `@ApiAmbiguousResponse`, `@ApiMovedPermanentlyResponse`, `@ApiFoundResponse`, `@ApiSeeOtherResponse`, `@ApiNotModifiedResponse`, `@ApiTemporaryRedirectResponse`, `@ApiPermanentRedirectResponse`, `@ApiBadRequestResponse`, `@ApiUnauthorizedResponse`, `@ApiPaymentRequiredResponse`, `@ApiForbiddenResponse`, `@ApiNotFoundResponse`, `@ApiMethodNotAllowedResponse`, `@ApiNotAcceptableResponse`, `@ApiProxyAuthenticationRequiredResponse`, `@ApiRequestTimeoutResponse`, `@ApiConflictResponse`, `@ApiGoneResponse`, `@ApiLengthRequiredResponse`, `@ApiPreconditionFailedResponse`, `@ApiPayloadTooLargeResponse`, `@ApiUriTooLongResponse`, `@ApiUnsupportedMediaTypeResponse`, `@ApiRequestedRangeNotSatisfiableResponse`, `@ApiExpectationFailedResponse`, `@ApiIAmATeapotResponse`, `@ApiMisdirectedResponse`, `@ApiUnprocessableEntityResponse`, `@ApiFailedDependencyResponse`, `@ApiPreconditionRequiredResponse`, `@ApiTooManyRequestsResponse`, `@ApiInternalServerErrorResponse`, `@ApiNotImplementedResponse`, `@ApiBadGatewayResponse`, `@ApiServiceUnavailableResponse`, `@ApiGatewayTimeoutResponse`, `@ApiHttpVersionNotSupportedResponse`.

@@filename(users-openapi.controller.ts)

```ts
import { Controller, Get, Param } from "@bunest/core";
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiTags,
} from "@bunest/swagger";

class UserResponseDto {
  @ApiProperty({ example: "usr_123" })
  id: string;
}

@ApiTags("users")
@ApiBearerAuth()
@Controller("users")
export class UsersOpenApiController {
  @Get(":id")
  @ApiOperation({ summary: "Fetch user by ID" })
  @ApiParam({ name: "id", description: "Unique user identifier" })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ description: "User does not exist" })
  findOne(@Param("id") id: string) {
    return { id };
  }
}
```

---

## `@bunest/orm`

Import from `@bunest/orm`.

| Category | Decorators | Purpose |
| --- | --- | --- |
| **Entities & Columns** (12) | `@Entity`, `@Column`, `@PrimaryColumn`, `@PrimaryGeneratedColumn`, `@ObjectIdColumn`, `@CreateDateColumn`, `@UpdateDateColumn`, `@DeleteDateColumn`, `@VersionColumn`, `@Index`, `@Unique`, `@SoftDelete` | Maps TypeScript classes to SQL/MongoDB tables, primary keys, timestamps, indexes, optimistic locking, and soft deletes. |
| **Embeddables** | `@Embeddable`, `@Embedded` | Embed a value object. |
| **Relations** | `@OneToOne`, `@OneToMany`, `@ManyToOne`, `@ManyToMany`, `@JoinColumn`, `@JoinTable` | Map entity relations. |
| **Lifecycle Hooks** (7) | `@BeforeInsert`, `@AfterInsert`, `@BeforeUpdate`, `@AfterUpdate`, `@BeforeRemove`, `@AfterRemove`, `@AfterLoad` | Runs entity hooks around persistence events. |
| **Declarative Repositories** | `@Repository`, `@RepositoryScope` | Declare repositories and query scopes. |
| **Multi-Tenancy & Scopes** | `@TenantScoped` | Scope repository operations by tenant. |
| **Transactions & DI** (5) | `@Transactional`, `@InjectRepository`, `@InjectDataSource`, `@InjectEntityManager`, `@InjectOrmMigrations` | Declarative ALS transaction/savepoint boundaries and ORM DI injection. |

@@filename(order.entity.ts)

```ts
import { Injectable } from "@bunest/core";
import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  CrudRepository,
  Entity,
  InjectRepository,
  ManyToOne,
  Repository,
  PrimaryGeneratedColumn,
  Transactional,
} from "@bunest/orm";

@Entity("orders")
export class Order {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  status: string;

  @CreateDateColumn()
  createdAt: Date;

  @BeforeInsert()
  normalizeStatus() {
    this.status = this.status.toLowerCase();
  }
}

@Repository(Order)
export abstract class OrderRepository extends CrudRepository<Order, string> {
  abstract findByStatusOrderByCreatedAtDesc(status: string): Promise<Order[]>;
}

@Injectable()
export class OrderService {
  constructor(
    private readonly repo: OrderRepository,
  ) {}

  @Transactional()
  async createPending() {
    return this.repo.save({ status: "PENDING" });
  }
}
```

---

## `@bunest/graphql` (23 decorators)

Import from `@bunest/graphql` (`@Plugin` from `@bunest/graphql/apollo`).

| Group | Decorators | Purpose |
| --- | --- | --- |
| **Schema Types** (7) | `@ObjectType`, `@InputType`, `@ArgsType`, `@InterfaceType`, `@Field`, `@HideField`, `@Scalar` | Code-first GraphQL schema type and field definitions. |
| **Resolvers & Operations** (6) | `@Resolver`, `@Query`, `@Mutation`, `@Subscription`, `@ResolveField`, `@ResolveProperty` | Binds resolver classes and root/field operations. |
| **Parameters** (5) | `@Args`, `@Parent`, `@Root`, `@Context`, `@Info` | Extracts GraphQL arguments, parent object, request context, and AST `GraphQLResolveInfo`. |
| **Federation, Directives & Plugins** (5) | `@ResolveReference`, `@Directive`, `@Extensions`, `@UseFieldMiddleware`, `@Plugin` | Apollo Federation v2 entity resolution, schema directives, field middleware, and Apollo Server plugins. |

@@filename(books.resolver.ts)

```ts
import { Args, Field, Int, ObjectType, Query, Resolver } from "@bunest/graphql";

@ObjectType()
export class Book {
  @Field(() => Int)
  id: number;

  @Field()
  title: string;
}

@Resolver(() => Book)
export class BooksResolver {
  @Query(() => [Book])
  books(@Args("limit", { type: () => Int, defaultValue: 10 }) limit: number) {
    return [{ id: 1, title: `Top ${limit} Bunest Patterns` }];
  }
}
```

---

## `@bunest/security` (14 decorators)

| Subpath | Decorators | Purpose |
| --- | --- | --- |
| `@bunest/security` (10) | `@Auth(...roles)`, `@Protected(options?)`, `@Public()`, `@Roles(...roles)`, `@CheckPolicies(...handlers)`, `@CurrentUser(prop?)`, `@Throttle(options)`, `@SkipThrottle(skip?)`, `@InjectThrottlerOptions()`, `@InjectThrottlerStorage()` | High-level route auth/RBAC/policy guards, current user extraction, and rate limiting. |
| `@bunest/security/auth` (2) | `@Authenticate(strategy?)`, `@CurrentSession()` | Next-gen session/JWT/MFA authentication guard and session parameter decorator. |
| `@bunest/security/authz` (2) | `@Policy()`, `@Can(PolicyClass, ability)` (plus `@Can.Anyone()`) | Policy-based authorization definitions and handler checks. |

@@filename(billing.controller.ts)

```ts
import { Controller, Get } from "@bunest/core";
import { Auth, CurrentUser, Public, Throttle } from "@bunest/security";
import { Can, Policy } from "@bunest/security/authz";
@Policy()
class InvoicePolicy {
  read(user: { roles: string[] } | null): boolean {
    return user?.roles.includes("admin") === true;
  }
}

@Controller("billing")
export class BillingController {
  @Public()
  @Get("plans")
  getPlans() {
    return ["free", "pro"];
  }

  @Auth("admin")
  @Can(InvoicePolicy, "read")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("invoices")
  listInvoices(@CurrentUser("id") userId: string) {
    return { userId, invoices: [] };
  }
}
```

---

## `@bunest/messaging` (12 decorators)

| Subpath | Decorators | Purpose |
| --- | --- | --- |
| `@bunest/messaging` (8) | `@OnEvent(event, options?)`, `@EmitEvent(event, options?)`, `@EventPayload()`, `@Publishable()`, `@CommandHandler(cmd)`, `@QueryHandler(query)`, `@EventsHandler(...events)`, `@Saga()` | EventEmitter listeners, AOP event emission, and CQRS command/query/event/saga handlers. |
| `@bunest/messaging/outbox` (1) | `@OnOutboxMessage(topic)` | Handles relayed transactional outbox messages. |
| `@bunest/messaging/webhooks` (3) | `@IncomingWebhook(provider)`, `@VerifyWebhook(options)`, `@WebhookPayload()` | Verifies HMAC signatures (Standard Webhooks, Stripe, GitHub, custom) and injects verified payloads. |

@@filename(order-events.handler.ts)

```ts
import { Injectable } from "@bunest/core";
import { EmitEvent, OnEvent } from "@bunest/messaging";

@Injectable()
export class OrderNotifications {
  @EmitEvent("order.shipped", { async: true })
  async markShipped(orderId: string) {
    return { orderId, shippedAt: new Date().toISOString() };
  }

  @OnEvent("order.shipped")
  handleShipped(payload: { orderId: string }) {
    console.log("Notifying customer for", payload.orderId);
  }
}
```

---

## `@bunest/resilience` (12 decorators)

All resilience and lock decorators run via Bunest's Service-Layer AOP weaver on any `@Injectable()` service or controller method.

| Subpath | Decorators | Purpose |
| --- | --- | --- |
| `@bunest/resilience` (7) | `@Retry(options)`, `@Timeout(ms \| options)`, `@CircuitBreaker(options)`, `@Bulkhead(options)`, `@Fallback(fn \| options)`, `@Signal()`, `@Resilience(policy)` | Fault tolerance policies, abort signal injection, and named policy composition. |
| `@bunest/resilience/locks` (4) | `@WithLock(key, options?)`, `@OnOneInstance(key, options?)`, `@WithoutOverlapping(key, options?)`, `@LeaderElection(options)` | Distributed leased locks, single-instance execution, non-overlapping jobs, and leader election. |
| `@bunest/resilience/idempotency` (1) | `@Idempotent(options?)` | Deduplicates repeated HTTP/service calls using an idempotency key store. |

@@filename(payment.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { CircuitBreaker, Fallback, Retry, Timeout } from "@bunest/resilience";
import { WithLock } from "@bunest/resilience/locks";
import { Idempotent } from "@bunest/resilience/idempotency";

@Injectable()
export class PaymentService {
  @WithLock((orderId: string) => `pay:${orderId}`, { ttl: 10_000 })
  @Idempotent({ ttl: 60_000 })
  @Retry({ attempts: 3, backoff: { delay: 200 } })
  @Timeout(5_000)
  @CircuitBreaker({ failureRateThreshold: 50 })
  @Fallback(() => ({ status: "queued_for_retry" }))
  async charge(orderId: string) {
    return { orderId, status: "paid" };
  }
}
```

---

## `@bunest/jobs` (10 decorators)

Import from `@bunest/jobs` (or `@bunest/jobs/scheduler` / `@bunest/jobs/queues`).

| Group | Decorators | Purpose |
| --- | --- | --- |
| **Scheduler** (3) | `@Cron(expression, options?)`, `@Interval(name?, ms)`, `@Timeout(name?, ms)` | Schedules recurring cron jobs, fixed intervals, and one-shot delayed tasks. |
| **Queues** (7) | `@Processor(queueName, options?)`, `@Process(jobName?)`, `@InjectQueue(name)`, `@InjectFlowProducer(name)`, `@QueueEventsListener(name)`, `@OnWorkerEvent(event)`, `@OnQueueEvent(event)` | BullMQ-compatible background workers, queue/flow injection, and worker/queue lifecycle listeners. |

@@filename(email.processor.ts)

```ts
import { Cron, CronExpression, OnWorkerEvent, Process, Processor } from "@bunest/jobs";

@Processor("emails")
export class EmailProcessor {
  @Process("welcome")
  async sendWelcome(job: { data: { to: string } }) {
    return { sentTo: job.data.to };
  }

  @OnWorkerEvent("failed")
  onFailed(job: { id: string }, err: Error) {
    console.error(`Job ${job.id} failed:`, err.message);
  }

  @Cron(CronExpression.EVERY_HOUR)
  cleanupBounced() {
    // Runs every hour
  }
}
```

---

## `@bunest/microservices` (9 decorators)

Import from `@bunest/microservices`.

| Decorator | Target | Purpose |
| --- | --- | --- |
| `@MessagePattern(pattern, transport?)` | Method | Handles request-response RPC messages across TCP, Redis, NATS, RabbitMQ, Kafka, MQTT, or InMemory. |
| `@EventPattern(pattern, transport?)` | Method | Handles fire-and-forget event messages. |
| `@Payload(key?, ...pipes)` | Param | Extracts the message payload (with optional validation pipes). |
| `@Ctx()` | Param | Injects the transport-specific execution context (`TcpContext`, `NatsContext`, etc.). |
| `@Client(options)` | Prop | Attaches a `ClientProxy` configured with transport options. |
| `@GrpcService(name?)`, `@GrpcMethod(service?, method?)`, `@GrpcStreamMethod(service?, method?)`, `@GrpcStreamCall(service?, method?)` | Class / Method | Declares unary and streaming gRPC service handlers. |

---

## `@bunest/ai` (7 decorators)

| Subpath | Decorators | Purpose |
| --- | --- | --- |
| `@bunest/ai` (3) | `@AgentFunction(options)`, `@InjectModel(name?)`, `@InjectEmbeddingModel(name?)` | Exposes typed service methods as LLM tool calls and injects chat/embedding models. |
| `@bunest/ai/mcp` (4) | `@Tool(options)`, `@Resource(options)`, `@ResourceTemplate(options)`, `@Prompt(options)` | Declares Model Context Protocol (MCP) server tools, resources, URI templates, and prompts. |

@@filename(weather.mcp.ts)

```ts
import { Injectable } from "@bunest/core";
import { Tool } from "@bunest/ai/mcp";

@Injectable()
export class WeatherMcpTools {
  @Tool({
    name: "get_weather",
    description: "Returns the current weather for a city",
  })
  async getWeather(input: { city: string }) {
    return { city: input.city, tempC: 29 };
  }
}
```

---

## `@bunest/cache` (6 decorators)

Import from `@bunest/cache`.

| Decorator | Target | Purpose |
| --- | --- | --- |
| `@Cacheable(options?)` | Class / Method | AOP read-through cache with single-flight stampede protection. |
| `@CacheEvict(options?)` | Method | Evicts specific keys, tags, or prefixes after method execution. |
| `@CachePut(options?)` | Method | Always executes the method and updates the cache with the new result. |
| `@CacheKey(key)` | Class / Method | Sets a custom HTTP cache key for `CacheInterceptor`. |
| `@CacheTTL(ttlMs)` | Class / Method | Overrides HTTP cache TTL for `CacheInterceptor`. |
| `@NoCache()` | Class / Method | Opts a route out of global `CacheInterceptor`. |

---

## `@bunest/observability` (5 decorators)

Import from `@bunest/observability` (or subpaths `/tracing`, `/metrics`, `/health`).

| Decorator | Target | Purpose |
| --- | --- | --- |
| `@Span(name?, options?)` | Class / Method | Wraps execution in a W3C/OpenTelemetry tracing span. |
| `@Trace(name?, options?)` | Class / Method | Alias/ergonomic wrapper for distributed tracing spans. |
| `@Timed(metricName?, labels?)` | Class / Method | Records method execution latency histogram in Prometheus metrics. |
| `@Counted(metricName?, labels?)` | Class / Method | Increments a Prometheus invocation counter on every call. |
| `@HealthCheck()` | Method | Marks a controller route as a Terminus-style health check endpoint. |

---

## `@bunest/workflows` (3 decorators) & `@bunest/storage` (1 decorator)

| Package / Subpath | Decorators | Purpose |
| --- | --- | --- |
| `@bunest/workflows` | `@Workflow(name \| options)` | Registers a durable workflow class with deterministic replay. |
| `@bunest/workflows/cqrs` | `@StartOn(commandOrEvent)`, `@SignalOn(commandOrEvent)` | Starts or signals a durable workflow automatically from a CQRS command/event. |
| `@bunest/storage` | `@InjectDisk(name?)` | Injects a configured `StorageDisk` (local filesystem, memory, or S3/R2/MinIO). |

---

## Creating Your Own Decorators

Need domain-specific decorators? Bunest provides three official composition primitives:

- `createParamDecorator()` — custom controller parameter extractors ([Custom decorators](/overview/custom-decorators)).
- `Reflector.createDecorator<T>()` & `applyDecorators()` — strongly-typed metadata & composed decorators ([Custom decorators](/overview/custom-decorators)).
- `createMethodAspectDecorator()` & `defineAspectPipeline()` — zero-overhead service-layer AOP aspects with `AspectPhase` ordering ([Service-Layer AOP](/techniques/service-aop)).
