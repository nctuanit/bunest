# Tra cứu Decorators (Reference)

Bunest cung cấp sẵn **447 decorators** phân bổ trên **15 packages** — bao phủ đầy đủ từ dependency injection, định tuyến HTTP/WebDAV, trích xuất tham số, enhancers, class & method macros kiểu Lombok, Service-Layer AOP, validation, OpenAPI 3.1, ORM, GraphQL, WebSockets, bảo mật, messaging, queues, resilience, AI/MCP, workflows cho đến observability.

> info **Legacy Decorators & `verbatimModuleSyntax`** Bunest sử dụng TypeScript legacy decorators (`experimentalDecorators: true` + `emitDecoratorMetadata: true`). Luôn **value-import** các DI class, DTO và entity (không dùng `import type`) để metadata constructor được sinh ra lúc runtime.

## Tổng quan số lượng theo Package

| Package | Số lượng | Phạm vi chính | Hướng dẫn chi tiết |
| --- | ---: | --- | --- |
| [`@bunest/core`](#bunestcore-102-decorators) | 102 | DI, modules, HTTP/WebDAV, params, enhancers, macros, config, WS, i18n | [Controllers](/overview/controllers) · [Service AOP](/techniques/service-aop) |
| [`@bunest/validation`](#bunestvalidation-119-decorators) | 119 | Kiểm tra DTO (`validator`) & biến đổi dữ liệu (`transformer`) | [Validation](/techniques/validation) · [Serialization](/techniques/serialization) |
| [`@bunest/swagger`](#bunestswagger-78-decorators) | 78 | OpenAPI 3.1 operations, schemas, security & 50 shorthand status response | [OpenAPI](/apis/openapi) |
| [`@bunest/orm`](#bunestorm-46-decorators) | 46 | Entities, columns, relations, hooks, declarative repositories, transactions | [ORM & Adapters](/data/orm-adapters) |
| [`@bunest/graphql`](#bunestgraphql-23-decorators) | 23 | Code-first schema types, resolvers, arguments, Federation v2 & Apollo plugins | [GraphQL](/apis/graphql) |
| [`@bunest/security`](#bunestsecurity-14-decorators) | 14 | Auth, RBAC, ABAC policies, sessions & rate limiting | [Security](/security/security-module) · [Authorization](/security/authorization) |
| [`@bunest/messaging`](#bunestmessaging-12-decorators) | 12 | Domain events, CQRS handlers/sagas, transactional outbox & webhooks | [Events](/techniques/events) · [CQRS](/distributed/cqrs) · [Outbox & Webhooks](/distributed/outbox-webhooks) |
| [`@bunest/resilience`](#bunestresilience-12-decorators) | 12 | Retry, timeout, circuit breaker, bulkhead, fallback, locks & idempotency | [Resilience](/distributed/resilience) · [Locks & Idempotency](/distributed/locks-idempotency) |
| [`@bunest/jobs`](#bunestjobs-10-decorators) | 10 | Lập lịch Cron/interval/timeout & hàng đợi job Redis/in-memory | [Task Scheduling](/techniques/task-scheduling) · [Queues](/techniques/queues) |
| [`@bunest/microservices`](#bunestmicroservices-9-decorators) | 9 | RPC message/event patterns, payload/context binding & gRPC services | [Microservices](/distributed/microservices) |
| [`@bunest/ai`](#bunestai-7-decorators) | 7 | AI agent functions, inject model & MCP tools/resources/prompts | [AI SDK](/ai/ai-sdk) · [MCP](/ai/mcp) |
| [`@bunest/cache`](#bunestcache-6-decorators) | 6 | Cache tầng service & HTTP, eviction, tùy biến key & TTL | [Caching](/techniques/caching) |
| [`@bunest/observability`](#bunestobservability-5-decorators) | 5 | Tracing spans, đo độ trễ, counters & health checks | [Observability](/observability/observability) |
| [`@bunest/workflows`](#bunestworkflows-3-decorators) | 3 | Durable workflow entrypoints & gắn kết CQRS start/signal | [Workflows](/distributed/workflows) |
| [`@bunest/storage`](#buneststorage-1-decorator) | 1 | Inject ổ đĩa lưu trữ (local, memory, S3/R2/MinIO) | [Storage](/techniques/storage) |
| **Tổng cộng** | **447** | **15 packages** | [Custom Decorators](/overview/custom-decorators) |

---

## `@bunest/core` (102 decorators)

### 1. DI, Modules & Đăng ký có điều kiện (11)

Import từ `@bunest/core`.

| Decorator | Vị trí | Công dụng |
| --- | --- | --- |
| `@Module(metadata)` | Class | Khai báo module với `imports`, `controllers`, `providers`, `exports`. |
| `@AutoModule(options?)` | Class | Tự động quét và đăng ký providers/controllers trong thư mục module. |
| `@Global()` | Class | Biến các provider được export của module thành phạm vi toàn cục. |
| `@Injectable(options?)` | Class | Đánh dấu class là DI provider (`Scope.DEFAULT`, `REQUEST`, `TRANSIENT`, `durable`). |
| `@Inject(token)` | Param / Prop | Inject provider theo token tường minh (string, symbol hoặc class). |
| `@Optional()` | Param / Prop | Đánh dấu dependency là tùy chọn (nhận `undefined` nếu chưa đăng ký). |
| `@Dependencies(...deps)` | Class | Khai báo danh sách dependency của constructor (hữu ích khi dùng JS thuần). |
| `@RegisterIf(predicate)` | Class | Chỉ đăng ký provider/module khi hàm `predicate` trả về `true`. |
| `@RegisterIfEnv(key, value?)` | Class | Chỉ đăng ký khi `Bun.env[key]` tồn tại hoặc khớp `value`. |
| `@RegisterIfMissing(token)` | Class | Đăng ký provider dự phòng nếu `token` chưa được đăng ký. |
| `@Profile(...profiles)` | Class | Chỉ đăng ký khi `BUNEST_PROFILES` / `NODE_ENV` khớp một trong các profile. |

@@filename(storage-adapter.provider.ts)

```ts
import {
  Global,
  Inject,
  Injectable,
  Module,
  Optional,
  Profile,
  RegisterIfEnv,
  RegisterIfMissing,
} from "@bunest/core";

@Injectable()
@RegisterIfEnv("REDIS_URL")
export class RedisSessionStore {}

@Injectable()
@RegisterIfMissing(RedisSessionStore)
@Profile("development", "test")
export class InMemorySessionStore {}

@Global()
@Module({
  providers: [RedisSessionStore, InMemorySessionStore],
  exports: [RedisSessionStore, InMemorySessionStore],
})
export class SessionModule {
  constructor(
    @Optional() @Inject("SESSION_PREFIX") private readonly prefix = "sess:",
  ) {}
}
```

### 2. Định tuyến HTTP & WebDAV (24)

Import từ `@bunest/core`.

| Decorator | Vị trí | Công dụng |
| --- | --- | --- |
| `@Controller(prefix \| options)` | Class | Đăng ký HTTP controller với prefix, `host`, và `version`. |
| `@RequestMapping(metadata)` | Method | Decorator cấp thấp nhận `{ path, method }`. |
| `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Options`, `@Head`, `@All` | Method | 8 decorator cho các phương thức HTTP chuẩn. |
| `@Propfind`, `@Proppatch`, `@Mkcol`, `@Copy`, `@Move`, `@Lock`, `@Unlock`, `@Search` | Method | 8 decorator cho các phương thức WebDAV. |
| `@Sse(path?)` | Method | Khai báo endpoint Server-Sent Events (streaming). |
| `@Version(version)` | Method / Class | Gắn phiên bản API cho route hoặc controller (`"1"`, `VERSION_NEUTRAL`). |
| `@HttpCode(status)` | Method | Ghi đè mã trạng thái HTTP trả về mặc định. |
| `@Header(name, value)` | Method | Thiết lập response header tĩnh cho handler. |
| `@Redirect(url?, statusCode?)` | Method | Chuyển hướng client (mặc định `302`; có thể trả `{ url, statusCode }` để đổi động). |
| `@Render(template)` | Method | Render view template bằng template engine đã cấu hình. |

### 3. Trích xuất tham số HTTP (19)

Import từ `@bunest/core`.

| Decorator | Vị trí | Công dụng |
| --- | --- | --- |
| `@Param(key?, ...pipes)` | Param | Lấy tham số đường dẫn (`:id`). |
| `@Body(key?, ...pipes)` | Param | Lấy phần thân request đã parse (JSON, form, text). |
| `@RawBody()` | Param | Lấy raw `Uint8Array` / `Buffer` chưa parse (dùng xác thực HMAC webhook). |
| `@Query(key?, ...pipes)` | Param | Lấy query string trên URL. |
| `@Headers(name?)` | Param | Lấy request headers (không phân biệt hoa thường). |
| `@Cookies(name?)` | Param | Lấy cookies đã parse. |
| `@SignedCookies(name?)` | Param | Lấy signed cookies đã xác thực chữ ký HMAC. |
| `@Session()` | Param | Lấy đối tượng session của request hiện tại. |
| `@Ip()` | Param | Lấy địa chỉ IP của client. |
| `@HostParam(key?)` | Param | Lấy tham số host động khi dùng `@Controller({ host })`. |
| `@Req()` / `@Request()` | Param | Inject đối tượng request wrapper của Bunest. |
| `@Res(options?)` / `@Response(options?)` | Param | Inject đối tượng response (`{ passthrough: true }` giữ cơ chế tự động serialize). |
| `@Next()` | Param | Inject hàm chuyển tiếp middleware. |
| `@UploadedFile(...pipes)` | Param | Lấy một tệp tải lên dạng multipart. |
| `@UploadedFiles(...pipes)` | Param | Lấy nhiều tệp tải lên dạng multipart. |
| `@SseSignal()` | Param | Inject `AbortSignal` tự hủy khi client SSE ngắt kết nối. |
| `@Bind(...decorators)` | Method | Gắn parameter decorators ở mức method (dùng thay thế trong JS thuần). |

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

Import từ `@bunest/core`.

| Decorator | Vị trí | Công dụng |
| --- | --- | --- |
| `@UseGuards(...guards)` | Class / Method | Gắn guard kiểm tra xác thực/phân quyền (`CanActivate`). |
| `@UseInterceptors(...interceptors)` | Class / Method | Gắn interceptor chạy theo mô hình Promise (`BunestInterceptor`). |
| `@UsePipes(...pipes)` | Class / Method | Gắn pipe biến đổi và kiểm tra dữ liệu (`PipeTransform`). |
| `@UseFilters(...filters)` | Class / Method | Gắn bộ lọc bắt ngoại lệ (`ExceptionFilter`). |
| `@UseMiddleware(...middlewares)` | Class / Method | Khai báo middleware trực tiếp trên controller hoặc method. |
| `@Catch(...exceptions)` | Class | Chỉ định các lớp ngoại lệ mà `ExceptionFilter` xử lý. |
| `@SetMetadata(key, value)` | Class / Method | Gắn metadata tùy chỉnh đọc qua `Reflector`. |
| `@InheritMethodEnhancers(enabled?)` | Class | Kiểm soát việc subclass có kế thừa method enhancers của lớp cha hay không (mặc định `true`). |
| `@WithCls(options?)` | Class / Method | Bọc method trong ngữ cảnh `AsyncLocalStorage` CLS. |
| `@SerializeOptions(options)` | Class / Method | Cấu hình `ClassSerializerInterceptor` theo từng route (cũng export ở `@bunest/validation`). |
| `@UseStandardSchema(schema)` | Method / Param | Validate dữ liệu với bất kỳ thư viện Standard Schema v1 nào (Zod, Valibot, ArkType; cũng export ở `@bunest/validation`). |

### 5. Class, Field & Method Macros (27)

Import từ `@bunest/core`. Lấy cảm hứng từ Lombok, bộ macro zero-dependency này giảm thiểu code lặp lại và được hỗ trợ đầy đủ type bởi VS Code extension của Bunest.

| Nhóm | Decorators | Công dụng |
| --- | --- | --- |
| **Model tổng hợp** (4) | `@Data()`, `@Value()`, `@Builder()`, `@SuperBuilder()` | Tự sinh getters, setters, `toString()`, `equals()`, value object bất biến và fluent builder. |
| **Accessors & cloning** (5) | `@Getter()`, `@Setter()`, `@Accessors()`, `@With()`, `@WithBy()` | Sinh getter/setter, fluent accessors và hàm cập nhật bất biến `withX()` / `withXBy()`. |
| **Tiện ích đối tượng** (6) | `@ToString()`, `@EqualsAndHashCode()`, `@FieldDefaults()`, `@FieldNameConstants()`, `@UtilityClass()`, `@StandardException()` | Sinh so sánh cấu trúc, định dạng chuỗi, mặc định field, hằng số tên field, utility class và `Error` chuẩn. |
| **Bổ trợ field** (5) | `@Delegate()`, `@Singular()`, `@NonNull()`, `@NonFinal()`, `@Secret()` | Ủy quyền method cho field con, thêm phần tử mảng trong builder, kiểm tra non-null, ghi đè tính bất biến hoặc ẩn dữ liệu nhạy cảm khỏi log/JSON. |
| **Serialize & method aspects** (7) | `@JsonSerializable()`, `@Memoize()`, `@LogExecution()`, `@WithLogger()`, `@Synchronized()`, `@Locked()`, `@QueryMethod()` | Tùy biến `toJSON()`, cache kết quả hàm, log thời gian chạy, inject logger, khóa tuần tự hóa cuộc gọi async song song, hoặc đánh dấu query method. |

@@filename(user-profile.model.ts)

```ts
import {
  Builder,
  Data,
  LogExecution,
  Memoize,
  Secret,
  Synchronized,
} from "@bunest/core";

@Data()
@Builder()
export class UserProfile {
  id: string;
  email: string;

  @Secret()
  passwordHash: string; // tự động che khi gọi toString() hoặc JSON
}

export class PricingService {
  @Memoize({ ttlMs: 30_000 })
  @LogExecution()
  computeTaxRate(country: string): number {
    return country === "VN" ? 0.08 : 0.1;
  }

  @Synchronized()
  async refreshCatalog(): Promise<void> {
    // Ngăn nhiều lời gọi async chạy chồng chéo cùng lúc
  }
}
```

### 6. Config, HTTP Client, I18n & WebSockets (10)

| Subpath | Decorators | Công dụng |
| --- | --- | --- |
| `@bunest/core/config` | `@ConfigValue(key, options?)`, `@InjectConfig(namespace?)` | Inject giá trị cấu hình có kiểu hoặc object config theo namespace. |
| `@bunest/core/client` | `@InjectHttpClient(name?)` | Inject instance `HttpClientService` theo tên. |
| `@bunest/core/i18n` | `@CurrentLocale()` | Trích xuất ngôn ngữ hiện tại của request (từ ALS / `Accept-Language`). |
| `@bunest/core/ws` | `@WebSocketGateway(port \| options?)`, `@WebSocketServer()`, `@SubscribeMessage(event)`, `@MessageBody(key?)`, `@ConnectedSocket()`, `@Ack()` | Khai báo WebSocket gateway thuần `Bun.serve`, handler sự kiện, payload/socket và callback ack. |

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

> info `@SerializeOptions` và `@UseStandardSchema` cũng được export từ `@bunest/validation` (đã tính trong nhóm `@bunest/core` ở trên).

### 1. Validators (`@bunest/validation/validator` — 112 decorators)

Biên dịch 1 lần cho mỗi lớp DTO thành hàm kiểm tra thuần Bun (không cần cài `class-validator`).

| Nhóm | Decorators |
| --- | --- |
| **Chung & Điều khiển** (12) | `@IsDefined`, `@IsOptional`, `@Allow`, `@Equals`, `@NotEquals`, `@IsEmpty`, `@IsNotEmpty`, `@IsIn`, `@IsNotIn`, `@ValidateIf`, `@ValidateNested`, `@ValidatePromise` |
| **Custom Validation** (3) | `@Validate`, `@ValidateBy`, `@ValidatorConstraint` |
| **Kiểu dữ liệu** (10) | `@IsBoolean`, `@IsDate`, `@IsString`, `@IsNumber`, `@IsInt`, `@IsArray`, `@IsEnum`, `@IsObject`, `@IsNotEmptyObject`, `@IsInstance` |
| **Số & Ngày** (7) | `@IsDivisibleBy`, `@IsPositive`, `@IsNegative`, `@Min`, `@Max`, `@MinDate`, `@MaxDate` |
| **Mảng** (6) | `@ArrayContains`, `@ArrayNotContains`, `@ArrayNotEmpty`, `@ArrayMinSize`, `@ArrayMaxSize`, `@ArrayUnique` |
| **Chuỗi (Cơ bản & Độ dài)** (17) | `@Contains`, `@NotContains`, `@IsAlpha`, `@IsAlphanumeric`, `@IsAscii`, `@IsByteLength`, `@Length`, `@MinLength`, `@MaxLength`, `@Matches`, `@IsLowercase`, `@IsUppercase`, `@IsMultibyte`, `@IsVariableWidth`, `@IsFullWidth`, `@IsHalfWidth`, `@IsSurrogatePair` |
| **Chuỗi (Định dạng & Web)** (34) | `@IsEmail`, `@IsUrl`, `@IsUUID`, `@IsJSON`, `@IsJWT`, `@IsIP`, `@IsPort`, `@IsFQDN`, `@IsMACAddress`, `@IsMagnetURI`, `@IsDataURI`, `@IsMimeType`, `@IsBase32`, `@IsBase58`, `@IsBase64`, `@IsHexadecimal`, `@IsHexColor`, `@IsHSL`, `@IsRgbColor`, `@IsOctal`, `@IsDecimal`, `@IsNumberString`, `@IsBooleanString`, `@IsDateString`, `@IsISO8601`, `@IsRFC3339`, `@IsMilitaryTime`, `@IsSemVer`, `@IsHash`, `@IsStrongPassword`, `@IsTimeZone`, `@IsLocale`, `@IsMongoId`, `@IsFirebasePushId` |
| **Tài chính, Địa lý & Định danh** (23) | `@IsCreditCard`, `@IsCurrency`, `@IsIBAN`, `@IsBIC`, `@IsBtcAddress`, `@IsEthereumAddress`, `@IsISO4217CurrencyCode`, `@IsEAN`, `@IsISBN`, `@IsISIN`, `@IsISRC`, `@IsISSN`, `@IsISO31661Alpha2`, `@IsISO31661Alpha3`, `@IsIdentityCard`, `@IsPassportNumber`, `@IsTaxId`, `@IsPhoneNumber`, `@IsMobilePhone`, `@IsPostalCode`, `@IsLatitude`, `@IsLongitude`, `@IsLatLong` |

### 2. Transformers (`@bunest/validation/transformer` — 7 decorators)

| Decorator | Vị trí | Công dụng |
| --- | --- | --- |
| `@Expose(options?)` | Class / Prop | Giữ lại thuộc tính khi serialize/transform (hỗ trợ `name`, `groups`). |
| `@Exclude(options?)` | Class / Prop | Loại bỏ thuộc tính (ví dụ `passwordHash`) khi chuyển sang JSON. |
| `@Type(typeFn)` | Prop | Chỉ định lớp con để biến đổi và validate đệ quy. |
| `@Transform(transformFn, options?)` | Prop | Chạy hàm biến đổi giá trị tùy chỉnh khi `plainToInstance` / `instanceToPlain`. |
| `@TransformPlainToInstance(cls, options?)` | Method | Chuyển giá trị trả về của method từ plain object sang instance của class. |
| `@TransformInstanceToPlain(options?)` | Method | Chuyển giá trị trả về từ instance sang plain object. |
| `@TransformInstanceToInstance(options?)` | Method | Nhân bản / áp dụng lại quy tắc serialize cho instance trả về. |

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

## `@bunest/swagger` (78 decorators)

Import từ `@bunest/swagger`.

### OpenAPI cốt lõi (28)

| Nhóm | Decorators |
| --- | --- |
| **Controllers & Operations** (7) | `@ApiTags`, `@ApiOperation`, `@ApiExcludeController`, `@ApiExcludeEndpoint`, `@ApiIncludeEndpoint`, `@ApiCallbacks`, `@ApiWebhook` |
| **Đầu vào & Media Types** (7) | `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiHeader`, `@ApiHeaders`, `@ApiConsumes`, `@ApiProduces` |
| **Schemas & Properties** (6) | `@ApiProperty`, `@ApiPropertyOptional`, `@ApiHideProperty`, `@ApiResponseProperty`, `@ApiSchema`, `@ApiExtraModels` |
| **Bảo mật** (6) | `@ApiBearerAuth`, `@ApiBasicAuth`, `@ApiOAuth2`, `@ApiCookieAuth`, `@ApiApiKey`, `@ApiSecurity` |
| **Extensions & Links** (2) | `@ApiExtension`, `@ApiLink` |

### Response Decorators (50)

- Cơ bản: `@ApiResponse(options)`, `@ApiDefaultResponse(options)`.
- 48 shorthand cho các mã trạng thái HTTP 1xx–5xx: `@ApiOkResponse`, `@ApiCreatedResponse`, `@ApiAcceptedResponse`, `@ApiNoContentResponse`, `@ApiBadRequestResponse`, `@ApiUnauthorizedResponse`, `@ApiForbiddenResponse`, `@ApiNotFoundResponse`, `@ApiConflictResponse`, `@ApiUnprocessableEntityResponse`, `@ApiTooManyRequestsResponse`, `@ApiInternalServerErrorResponse`, `@ApiBadGatewayResponse`, `@ApiServiceUnavailableResponse`, cùng đầy đủ các mã 1xx/2xx/3xx/4xx/5xx khác.

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
  @ApiOperation({ summary: "Lấy thông tin user theo ID" })
  @ApiParam({ name: "id", description: "Mã định danh user" })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiNotFoundResponse({ description: "Không tìm thấy user" })
  findOne(@Param("id") id: string) {
    return { id };
  }
}
```

---

## `@bunest/orm` (46 decorators)

Import từ `@bunest/orm`.

| Nhóm | Decorators | Công dụng |
| --- | --- | --- |
| **Entities & Columns** (13) | `@Entity`, `@Column`, `@PrimaryColumn`, `@PrimaryGeneratedColumn`, `@PrimaryKey`, `@ObjectIdColumn`, `@CreateDateColumn`, `@UpdateDateColumn`, `@DeleteDateColumn`, `@VersionColumn`, `@Index`, `@Unique`, `@SoftDelete` | Ánh xạ bảng SQL/MongoDB, khóa chính, timestamp, chỉ mục, optimistic lock và xóa mềm. |
| **Embeddables** (4) | `@Embeddable`, `@Embedded`, `@Embeds`, `@Nested` | Ánh xạ value object / nhóm cột lồng nhau trong entity. |
| **Quan hệ (Relations)** (10) | `@OneToOne`, `@OneToMany`, `@ManyToOne`, `@ManyToMany`, `@ManyToManyOf`, `@HasOne`, `@HasMany`, `@BelongsTo`, `@JoinColumn`, `@JoinTable` | Khai báo khóa ngoại và bảng trung gian (hỗ trợ cả cú pháp TypeORM lẫn ActiveRecord). |
| **Lifecycle Hooks** (7) | `@BeforeInsert`, `@AfterInsert`, `@BeforeUpdate`, `@AfterUpdate`, `@BeforeRemove`, `@AfterRemove`, `@AfterLoad` | Chạy logic tự động trước/sau các thao tác ghi hoặc tải bản ghi. |
| **Declarative Repositories** (5) | `@OrmRepository`, `@DeclarativeRepository`, `@Projection`, `@RepositoryScope`, `@UseRepositoryFragments` | Repository kiểu Spring Data biên dịch 1 lần, DTO projection, default scope và repository fragments. |
| **Multi-Tenancy & Scopes** (2) | `@TenantScoped`, `@IgnoreScope` | Tự động cô lập dữ liệu theo tenant hoặc bỏ qua scope mặc định ở truy vấn cụ thể. |
| **Transactions & DI** (5) | `@Transactional`, `@InjectRepository`, `@InjectDataSource`, `@InjectEntityManager`, `@InjectOrmMigrations` | Quản lý giao dịch/savepoint bằng ALS và inject các thành phần ORM. |

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
  OrmRepository,
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

@OrmRepository(Order)
export abstract class OrderRepository extends CrudRepository<Order, string> {
  abstract findByStatusOrderByCreatedAtDesc(status: string): Promise<Order[]>;
}

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order) private readonly repo: OrderRepository,
  ) {}

  @Transactional()
  async createPending() {
    return this.repo.save({ status: "PENDING" });
  }
}
```

---

## `@bunest/graphql` (23 decorators)

Import từ `@bunest/graphql` (`@Plugin` từ `@bunest/graphql/apollo`).

| Nhóm | Decorators | Công dụng |
| --- | --- | --- |
| **Schema Types** (7) | `@ObjectType`, `@InputType`, `@ArgsType`, `@InterfaceType`, `@Field`, `@HideField`, `@Scalar` | Định nghĩa kiểu dữ liệu và trường GraphQL theo hướng code-first. |
| **Resolvers & Operations** (6) | `@Resolver`, `@Query`, `@Mutation`, `@Subscription`, `@ResolveField`, `@ResolveProperty` | Khai báo resolver và các thao tác Query/Mutation/Subscription/Field. |
| **Tham số** (5) | `@Args`, `@Parent`, `@Root`, `@Context`, `@Info` | Trích xuất tham số, đối tượng cha, request context và `GraphQLResolveInfo`. |
| **Federation, Directives & Plugins** (5) | `@ResolveReference`, `@Directive`, `@Extensions`, `@UseFieldMiddleware`, `@Plugin` | Hỗ trợ Apollo Federation v2, directive, field middleware và Apollo Server plugins. |

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

| Subpath | Decorators | Công dụng |
| --- | --- | --- |
| `@bunest/security` (10) | `@Auth(...roles)`, `@Protected(options?)`, `@Public()`, `@Roles(...roles)`, `@CheckPolicies(...handlers)`, `@CurrentUser(prop?)`, `@Throttle(options)`, `@SkipThrottle(skip?)`, `@InjectThrottlerOptions()`, `@InjectThrottlerStorage()` | Bảo vệ route, phân quyền RBAC/policy, lấy thông tin user hiện tại và giới hạn tần suất (rate limit). |
| `@bunest/security/auth` (2) | `@Authenticate(strategy?)`, `@CurrentSession()` | Xác thực thế hệ mới (session/JWT/MFA) và lấy session hiện tại. |
| `@bunest/security/authz` (2) | `@Policy(resource)`, `@Can(action, resource?)` (kèm `@Can.Anyone()`) | Khai báo và kiểm tra quyền dựa trên policy (ABAC). |

@@filename(billing.controller.ts)

```ts
import { Controller, Get } from "@bunest/core";
import { Auth, CurrentUser, Public, Throttle } from "@bunest/security";
import { Can } from "@bunest/security/authz";

@Controller("billing")
export class BillingController {
  @Public()
  @Get("plans")
  getPlans() {
    return ["free", "pro"];
  }

  @Auth("admin")
  @Can("read", "invoice")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("invoices")
  listInvoices(@CurrentUser("id") userId: string) {
    return { userId, invoices: [] };
  }
}
```

---

## `@bunest/messaging` (12 decorators)

| Subpath | Decorators | Công dụng |
| --- | --- | --- |
| `@bunest/messaging` (8) | `@OnEvent(event, options?)`, `@EmitEvent(event, options?)`, `@EventPayload()`, `@Publishable()`, `@CommandHandler(cmd)`, `@QueryHandler(query)`, `@EventsHandler(...events)`, `@Saga()` | Lắng nghe & phát sự kiện qua AOP, cùng đầy đủ handler cho mô hình CQRS. |
| `@bunest/messaging/outbox` (1) | `@OnOutboxMessage(topic)` | Xử lý bản tin được relay từ Transactional Outbox. |
| `@bunest/messaging/webhooks` (3) | `@IncomingWebhook(provider)`, `@VerifyWebhook(options)`, `@WebhookPayload()` | Xác thực chữ ký HMAC webhook (Standard Webhooks, Stripe, GitHub, tùy chỉnh) và trích xuất payload. |

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
    console.log("Thông báo khách hàng cho đơn", payload.orderId);
  }
}
```

---

## `@bunest/resilience` (12 decorators)

Toàn bộ các decorator độ tin cậy và khóa phân tán đều chạy qua Service-Layer AOP trên bất kỳ method `@Injectable()` hoặc controller nào.

| Subpath | Decorators | Công dụng |
| --- | --- | --- |
| `@bunest/resilience` (7) | `@Retry(options)`, `@Timeout(ms \| options)`, `@CircuitBreaker(options)`, `@Bulkhead(options)`, `@Fallback(fn \| options)`, `@Signal()`, `@Resilience(policy)` | Chính sách chịu lỗi, inject `AbortSignal` và kết hợp policy theo tên. |
| `@bunest/resilience/locks` (4) | `@WithLock(key, options?)`, `@OnOneInstance(key, options?)`, `@WithoutOverlapping(key, options?)`, `@LeaderElection(options)` | Khóa phân tán có lease, chạy trên 1 instance duy nhất, chống chạy chồng chéo và bầu chọn leader. |
| `@bunest/resilience/idempotency` (1) | `@Idempotent(options?)` | Chống xử lý trùng lặp request/method bằng idempotency key. |

@@filename(payment.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { CircuitBreaker, Fallback, Retry, Timeout } from "@bunest/resilience";
import { WithLock } from "@bunest/resilience/locks";
import { Idempotent } from "@bunest/resilience/idempotency";

@Injectable()
export class PaymentService {
  @WithLock((orderId: string) => `pay:${orderId}`, { ttl: 10_000 })
  @Idempotent({ ttlMs: 60_000 })
  @Retry({ maxAttempts: 3, delayMs: 200 })
  @Timeout(5_000)
  @CircuitBreaker({ failureThreshold: 5 })
  @Fallback(() => ({ status: "queued_for_retry" }))
  async charge(orderId: string) {
    return { orderId, status: "paid" };
  }
}
```

---

## `@bunest/jobs` (10 decorators)

Import từ `@bunest/jobs` (hoặc `@bunest/jobs/scheduler` / `@bunest/jobs/queues`).

| Nhóm | Decorators | Công dụng |
| --- | --- | --- |
| **Scheduler** (3) | `@Cron(expression, options?)`, `@Interval(name?, ms)`, `@Timeout(name?, ms)` | Lập lịch tác vụ định kỳ theo cron, khoảng thời gian cố định hoặc chạy trễ 1 lần. |
| **Queues** (7) | `@Processor(queueName, options?)`, `@Process(jobName?)`, `@InjectQueue(name)`, `@InjectFlowProducer(name)`, `@QueueEventsListener(name)`, `@OnWorkerEvent(event)`, `@OnQueueEvent(event)` | Worker xử lý hàng đợi tương thích BullMQ, inject queue/flow và lắng nghe sự kiện vòng đời job. |

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
    console.error(`Job ${job.id} thất bại:`, err.message);
  }

  @Cron(CronExpression.EVERY_HOUR)
  cleanupBounced() {
    // Chạy mỗi giờ
  }
}
```

---

## `@bunest/microservices` (9 decorators)

Import từ `@bunest/microservices`.

| Decorator | Vị trí | Công dụng |
| --- | --- | --- |
| `@MessagePattern(pattern, transport?)` | Method | Xử lý bản tin RPC request-response qua TCP, Redis, NATS, RabbitMQ, Kafka, MQTT hoặc InMemory. |
| `@EventPattern(pattern, transport?)` | Method | Xử lý bản tin sự kiện dạng fire-and-forget. |
| `@Payload(key?, ...pipes)` | Param | Trích xuất payload của bản tin (hỗ trợ pipe kiểm tra dữ liệu). |
| `@Ctx()` | Param | Inject ngữ cảnh transport tương ứng (`TcpContext`, `NatsContext`, ...). |
| `@Client(options)` | Prop | Khởi tạo `ClientProxy` với cấu hình transport. |
| `@GrpcService(name?)`, `@GrpcMethod(service?, method?)`, `@GrpcStreamMethod(service?, method?)`, `@GrpcStreamCall(service?, method?)` | Class / Method | Khai báo các handler gRPC dạng unary và streaming. |

---

## `@bunest/ai` (7 decorators)

| Subpath | Decorators | Công dụng |
| --- | --- | --- |
| `@bunest/ai` (3) | `@AgentFunction(options)`, `@InjectModel(name?)`, `@InjectEmbeddingModel(name?)` | Biến method service thành tool cho AI agent và inject chat/embedding model. |
| `@bunest/ai/mcp` (4) | `@Tool(options)`, `@Resource(options)`, `@ResourceTemplate(options)`, `@Prompt(options)` | Khai báo tools, resources, URI templates và prompts cho Model Context Protocol (MCP) server. |

@@filename(weather.mcp.ts)

```ts
import { Injectable } from "@bunest/core";
import { Tool } from "@bunest/ai/mcp";

@Injectable()
export class WeatherMcpTools {
  @Tool({
    name: "get_weather",
    description: "Trả về thời tiết hiện tại của một thành phố",
  })
  async getWeather(input: { city: string }) {
    return { city: input.city, tempC: 29 };
  }
}
```

---

## `@bunest/cache` (6 decorators)

Import từ `@bunest/cache`.

| Decorator | Vị trí | Công dụng |
| --- | --- | --- |
| `@Cacheable(options?)` | Class / Method | Cache đọc xuyên (read-through) tầng service có chống stampede (single-flight). |
| `@CacheEvict(options?)` | Method | Xóa cache theo key, tag hoặc prefix sau khi method thực thi. |
| `@CachePut(options?)` | Method | Luôn chạy method và cập nhật lại giá trị mới vào cache. |
| `@CacheKey(key)` | Class / Method | Đặt cache key tùy chỉnh cho HTTP `CacheInterceptor`. |
| `@CacheTTL(ttlMs)` | Class / Method | Ghi đè TTL cho HTTP `CacheInterceptor`. |
| `@NoCache()` | Class / Method | Bỏ qua `CacheInterceptor` toàn cục cho route cụ thể. |

---

## `@bunest/observability` (5 decorators)

Import từ `@bunest/observability` (hoặc `/tracing`, `/metrics`, `/health`).

| Decorator | Vị trí | Công dụng |
| --- | --- | --- |
| `@Span(name?, options?)` | Class / Method | Bọc method trong một tracing span chuẩn W3C/OpenTelemetry. |
| `@Trace(name?, options?)` | Class / Method | Alias gọn nhẹ để tạo distributed tracing span. |
| `@Timed(metricName?, labels?)` | Class / Method | Ghi nhận histogram thời gian thực thi vào Prometheus metrics. |
| `@Counted(metricName?, labels?)` | Class / Method | Tăng bộ đếm số lần gọi trong Prometheus metrics. |
| `@HealthCheck()` | Method | Đánh dấu route là endpoint kiểm tra sức khỏe hệ thống kiểu Terminus. |

---

## `@bunest/workflows` (3 decorators) & `@bunest/storage` (1 decorator)

| Package / Subpath | Decorators | Công dụng |
| --- | --- | --- |
| `@bunest/workflows` | `@Workflow(name \| options)` | Đăng ký lớp durable workflow có khả năng deterministic replay. |
| `@bunest/workflows/cqrs` | `@StartOn(commandOrEvent)`, `@SignalOn(commandOrEvent)` | Tự động khởi chạy hoặc gửi signal tới workflow từ CQRS command/event. |
| `@bunest/storage` | `@InjectDisk(name?)` | Inject `StorageDisk` đã cấu hình (local filesystem, memory hoặc S3/R2/MinIO). |

---

## Tự tạo Decorator riêng

Khi cần decorator đặc thù cho domain, Bunest cung cấp 3 cơ chế chính thức:

- `createParamDecorator()` — tạo parameter decorator cho controller ([Custom decorators](/overview/custom-decorators)).
- `Reflector.createDecorator<T>()` & `applyDecorators()` — tạo metadata decorator có kiểu chặt chẽ và gộp nhiều decorator ([Custom decorators](/overview/custom-decorators)).
- `createMethodAspectDecorator()` & `defineAspectPipeline()` — tạo Service-Layer AOP aspect zero-overhead có thứ tự pha `AspectPhase` ([Service-Layer AOP](/techniques/service-aop)).
