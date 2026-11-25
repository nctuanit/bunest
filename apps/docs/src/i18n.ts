import { normalizeBasePath, withBasePath } from "./navigation";

export type DocsLang = "en" | "vi";

export const SUPPORTED_LANGS: readonly DocsLang[] = ["en", "vi"] as const;
export const DEFAULT_LANG: DocsLang = "en";

export function langPrefix(lang: DocsLang): string {
  return lang === "vi" ? "/vi" : "";
}

export function withLangBase(basePath: string, lang: DocsLang): string {
  const base = normalizeBasePath(basePath);
  const prefix = langPrefix(lang);
  return normalizeBasePath(`${base}${prefix}`);
}

export function detectLangFromPathname(
  pathname: string,
  basePath = "",
): { lang: DocsLang; strippedPath: string } {
  const base = normalizeBasePath(basePath);
  let p = pathname;
  if (base && (p === base || p.startsWith(`${base}/`))) {
    p = p.slice(base.length) || "/";
  }
  if (p === "/vi" || p.startsWith("/vi/")) {
    return { lang: "vi", strippedPath: p.slice(3) || "/" };
  }
  return { lang: "en", strippedPath: p || "/" };
}

export function pageHrefForLang(
  slug: string,
  lang: DocsLang,
  basePath = "",
): string {
  const langBase = withLangBase(basePath, lang);
  const raw = slug === "" ? "/" : `/${slug}`;
  return withBasePath(raw, langBase);
}

export interface UiStrings {
  readonly siteTitle: string;
  readonly pageTitleSuffix: string;
  readonly searchTriggerLabel: string;
  readonly searchPlaceholder: string;
  readonly searchModalLabel: string;
  readonly searchModalPlaceholder: string;
  readonly searchNav: string;
  readonly searchOpen: string;
  readonly searchClose: string;
  readonly onThisPage: string;
  readonly noSubsections: string;
  readonly backToTop: string;
  readonly previous: string;
  readonly next: string;
  readonly minRead: string;
  readonly runtimeLabel: string;
  readonly decoratorsLabel: string;
  readonly footerTagline: string;
  readonly footerAdrs: string;
  readonly footerMigration: string;
  readonly footerRoadmap: string;
  readonly toggleMenu: string;
  readonly toggleTheme: string;
  readonly packagesLabel: string;
  readonly notFoundTitle: string;
  readonly notFoundBodyPrefix: string;
  readonly notFoundReturn: string;
  readonly navAriaLabel: string;
  readonly paginationAriaLabel: string;
}

export const UI_STRINGS: Record<DocsLang, UiStrings> = {
  en: {
    siteTitle:
      "Documentation | Bunest — A progressive Bun-native TypeScript framework",
    pageTitleSuffix: "Bunest Documentation",
    searchTriggerLabel: "Search documentation",
    searchPlaceholder: "Search documentation...",
    searchModalLabel: "Search Bunest documentation",
    searchModalPlaceholder:
      "Search decorators, pipes, ADRs, Bun.serve, Scope.REQUEST...",
    searchNav: "Navigate",
    searchOpen: "Open",
    searchClose: "Close",
    onThisPage: "ON THIS PAGE",
    noSubsections: "No subsections on this page.",
    backToTop: "Back to top",
    previous: "Previous",
    next: "Next",
    minRead: "min read",
    runtimeLabel: "Runtime",
    decoratorsLabel: "Decorators",
    footerTagline: "NestJS-style backend architecture built natively on Bun.",
    footerAdrs: "ADRs",
    footerMigration: "Migration",
    footerRoadmap: "Roadmap",
    toggleMenu: "Toggle navigation menu",
    toggleTheme: "Toggle light/dark mode",
    packagesLabel: "Packages & Monorepo",
    notFoundTitle: "404 — Page Not Found | Bunest Documentation",
    notFoundBodyPrefix: "No documentation page matches",
    notFoundReturn: "Return to Introduction",
    navAriaLabel: "Documentation navigation",
    paginationAriaLabel: "Page pagination",
  },
  vi: {
    siteTitle:
      "Tài liệu | Bunest — Framework TypeScript thuần Bun theo kiến trúc NestJS",
    pageTitleSuffix: "Tài liệu Bunest",
    searchTriggerLabel: "Tìm kiếm tài liệu",
    searchPlaceholder: "Tìm kiếm tài liệu...",
    searchModalLabel: "Tìm kiếm tài liệu Bunest",
    searchModalPlaceholder:
      "Tìm decorator, pipe, ADR, Bun.serve, Scope.REQUEST...",
    searchNav: "Di chuyển",
    searchOpen: "Mở",
    searchClose: "Đóng",
    onThisPage: "MỤC LỤC",
    noSubsections: "Trang này không có mục con.",
    backToTop: "Lên đầu trang",
    previous: "Trang trước",
    next: "Trang tiếp",
    minRead: "phút đọc",
    runtimeLabel: "Runtime",
    decoratorsLabel: "Decorators",
    footerTagline: "Kiến trúc backend kiểu NestJS xây dựng thuần trên Bun.",
    footerAdrs: "ADRs",
    footerMigration: "Chuyển từ NestJS",
    footerRoadmap: "Lộ trình",
    toggleMenu: "Bật/tắt menu điều hướng",
    toggleTheme: "Chuyển chế độ sáng/tối",
    packagesLabel: "Gói & Monorepo",
    notFoundTitle: "404 — Không tìm thấy trang | Tài liệu Bunest",
    notFoundBodyPrefix: "Không tìm thấy trang tài liệu nào khớp với",
    notFoundReturn: "Quay về Giới thiệu",
    navAriaLabel: "Điều hướng tài liệu",
    paginationAriaLabel: "Phân trang tài liệu",
  },
};

export const VI_CATEGORY_TITLES: Record<string, string> = {
  introduction: "GIỚI THIỆU",
  overview: "TỔNG QUAN",
  fundamentals: "NỀN TẢNG",
  techniques: "KỸ THUẬT",
  data: "DỮ LIỆU & LƯU TRỮ",
  security: "BẢO MẬT & ĐỊNH DANH",
  apis: "API, GRAPHQL & REALTIME",
  distributed: "PHÂN TÁN & ĐỘ TIN CẬY",
  ai: "AI & AGENTS",
  observability: "GIÁM SÁT & DX",
  architecture: "KIẾN TRÚC & ADRs",
  ecosystem: "HỆ SINH THÁI",
};

export const VI_PAGE_META: Record<
  string,
  { readonly title: string; readonly description: string }
> = {
  "": {
    title: "Giới thiệu",
    description:
      "Bunest là framework backend TypeScript kiểu NestJS được xây dựng thuần trên Bun.",
  },
  "overview/first-steps": {
    title: "Bước đầu tiên",
    description:
      "Cài đặt Bunest, cấu hình tsconfig.json cho legacy decorators và khởi chạy ứng dụng đầu tiên.",
  },
  "overview/controllers": {
    title: "Controllers",
    description:
      "Xử lý HTTP request với @Controller, method decorators, ràng buộc tham số và mã trạng thái.",
  },
  "overview/providers": {
    title: "Providers",
    description:
      "Services, repositories, dependency injection qua kiểu constructor và metadata @Injectable().",
  },
  "overview/modules": {
    title: "Modules",
    description:
      "Tổ chức cấu trúc ứng dụng với @Module(), đóng gói provider, re-export, @Global() và DynamicModule.",
  },
  "overview/middleware": {
    title: "Middleware",
    description:
      "Chặn và xử lý request trước guards và route handlers với BunestMiddleware và MiddlewareConsumer.",
  },
  "overview/exception-filters": {
    title: "Bộ lọc ngoại lệ (Exception filters)",
    description:
      "Xử lý lỗi tập trung với HttpException, 16 lớp ngoại lệ HTTP sẵn có và custom @Catch() filters.",
  },
  "overview/pipes": {
    title: "Pipes",
    description:
      "Chuyển đổi và kiểm tra dữ liệu đầu vào ở Stage 8 với 7 pipe có sẵn và custom PipeTransform.",
  },
  "overview/guards": {
    title: "Guards",
    description:
      "Kiểm soát quyền truy cập ở Stage 5 với CanActivate, Reflector và @UseGuards().",
  },
  "overview/interceptors": {
    title: "Interceptors",
    description:
      "Can thiệp trước/sau handler bằng Promise onion model (không dùng RxJS) với NestInterceptor.",
  },
  "overview/custom-decorators": {
    title: "Custom decorators",
    description:
      "Tạo parameter decorators với createParamDecorator và gộp nhiều decorators với applyDecorators.",
  },
  "fundamentals/custom-providers": {
    title: "Custom providers",
    description:
      "Đăng ký provider linh hoạt với useValue, useClass, useFactory, useExisting và injection tokens.",
  },
  "fundamentals/injection-scopes": {
    title: "Phạm vi DI (Injection scopes)",
    description:
      "Quản lý vòng đời DEFAULT, REQUEST và TRANSIENT cùng cơ chế phát hiện rò rỉ scope lúc khởi động.",
  },
  "fundamentals/circular-dependency": {
    title: "Phụ thuộc vòng (Circular dependency)",
    description:
      "Giải quyết phụ thuộc vòng giữa các provider và module với forwardRef() và kiểm tra vòng lúc bootstrap.",
  },
  "fundamentals/module-reference": {
    title: "Tham chiếu Module (ModuleRef)",
    description:
      "Truy xuất provider động lúc runtime với ModuleRef, LazyModuleLoader và DiscoveryService.",
  },
  "fundamentals/lifecycle-events": {
    title: "Sự kiện vòng đời (Lifecycle events)",
    description:
      "Các hook OnModuleInit, OnApplicationBootstrap, OnModuleDestroy và tắt ứng dụng an toàn.",
  },
  "fundamentals/execution-context": {
    title: "Ngữ cảnh thực thi (Execution context)",
    description:
      "Truy cập HTTP/WS/RPC/GraphQL context thống nhất với ArgumentsHost, ExecutionContext và Reflector.",
  },
  "fundamentals/testing": {
    title: "Kiểm thử (Testing)",
    description:
      "Viết unit test và E2E test tốc độ cao với Test.createTestingModule(), overrideProvider và bun:test.",
  },
  "techniques/validation": {
    title: "Kiểm tra dữ liệu (Validation)",
    description:
      "Validate DTO an toàn theo mặc định với ValidationPipe, @bunest/validation và Standard Schema.",
  },
  "techniques/serialization": {
    title: "Tuần tự hóa (Serialization)",
    description:
      "Biến đổi và ẩn trường nhạy cảm trên response với ClassSerializerInterceptor, @Exclude và @Expose.",
  },
  "techniques/cookies-cors": {
    title: "Cookies & CORS",
    description:
      "Ký/xác thực cookie chuẩn RFC 6265 và cấu hình CORS linh hoạt ngay trong BunHttpAdapter.",
  },
  "techniques/streaming-uploads": {
    title: "Streaming & Tải tệp",
    description:
      "Trả về StreamableFile zero-copy và xử lý multipart upload dạng stream an toàn lên ổ đĩa.",
  },
  "techniques/sse": {
    title: "Server-Sent Events (SSE)",
    description:
      "Đẩy luồng sự kiện thời gian thực qua HTTP với @Sse(), AsyncGenerator và @SseSignal().",
  },
  "techniques/logger": {
    title: "Ghi log (Logger)",
    description:
      "Logger có cấu trúc hỗ trợ nhiều mức log, JSON output và tự động che dữ liệu bí mật (redaction).",
  },
  "techniques/configuration": {
    title: "Cấu hình (Configuration)",
    description:
      "Quản lý biến môi trường .env, namespace registerAs(), validation schema và ConfigService.",
  },
  "techniques/caching": {
    title: "Bộ nhớ đệm (Caching)",
    description:
      "Tăng tốc API với CacheModule, @CacheKey, @CacheTTL, CacheInterceptor và driver InMemory/Redis.",
  },
  "techniques/task-scheduling": {
    title: "Lập lịch tác vụ (Task scheduling)",
    description:
      "Chạy cron job, interval và timeout thuần Bun với @Cron(), @Interval(), @Timeout() và SchedulerRegistry.",
  },
  "techniques/events": {
    title: "Sự kiện (Events)",
    description:
      "Phát và lắng nghe sự kiện nội bộ kiểu EventEmitter2 với @OnEvent(), wildcard và async listeners.",
  },
  "techniques/queues": {
    title: "Hàng đợi (Queues)",
    description:
      "Xử lý tác vụ nền, retry, delay và worker concurrency với @bunest/queues (SQLite & Redis).",
  },
  "techniques/http-client": {
    title: "HTTP client",
    description:
      "Gọi API ngoài với HttpModule/HttpService thuần fetch, hỗ trợ timeout, retry và interceptors.",
  },
  "techniques/i18n": {
    title: "Đa ngôn ngữ (i18n)",
    description:
      "Dịch thông điệp đa ngôn ngữ, pluralization và resolver theo header/query/cookie với @bunest/core/i18n.",
  },
  "techniques/mail": {
    title: "Gửi email (Mail)",
    description:
      "Gửi email qua SMTP/Resend/Postmark thuần Bun với template engine tích hợp trong @bunest/mail.",
  },
  "techniques/storage": {
    title: "Lưu trữ & Tệp tĩnh",
    description:
      "Lưu trữ file đa driver (LocalDisk, S3Disk SigV4, InMemoryDisk) và phục vụ tệp tĩnh zero-copy.",
  },
  "techniques/mapped-types": {
    title: "Mapped types",
    description:
      "Tái sử dụng DTO với PartialType, PickType, OmitType và IntersectionType giữ nguyên metadata.",
  },
  "techniques/service-aop": {
    title: "Service-Layer AOP",
    description:
      "Áp dụng @Transactional, @Retryable, @Cacheable và custom method aspects ở tầng service.",
  },
  "data/orm-adapters": {
    title: "Bunest ORM (@bunest/orm)",
    description:
      "ORM thuần Bun hỗ trợ @Entity, CrudRepository, quan hệ, migrations và tương thích Drizzle/Prisma.",
  },
  "data/sqlite": {
    title: "SQLite (bun:sqlite)",
    description:
      "Kết nối SQLite siêu nhanh với WAL mode, transaction và repository tích hợp trên bun:sqlite.",
  },
  "data/sql": {
    title: "SQL (Bun.SQL)",
    description:
      "Kết nối PostgreSQL/MySQL/SQLite qua Bun.SQL gốc với connection pool, tagged templates và transactions.",
  },
  "data/elasticsearch": {
    title: "Elasticsearch",
    description:
      "Tìm kiếm toàn văn và lập chỉ mục với @bunest/elasticsearch thuần fetch không phụ thuộc ngoài.",
  },
  "data/store-kit": {
    title: "Store kit (@bunest/orm/store)",
    description:
      "Bộ công cụ chuẩn hóa key-value, session và state store dùng chung trên SQLite, SQL và Redis.",
  },
  "security/security-module": {
    title: "Bảo mật, JWT & Rate Limiting",
    description:
      "Cấu hình HTTP security headers, ký/xác thực JWT bằng WebCrypto và giới hạn tốc độ @Throttle().",
  },
  "security/authentication": {
    title: "Xác thực (Authentication)",
    description:
      "Xây dựng đăng nhập mật khẩu (Argon2/bcrypt), session, MFA TOTP và OAuth/OIDC với @bunest/security.",
  },
  "security/authorization": {
    title: "Phân quyền (Authorization)",
    description:
      "Phân quyền RBAC, ABAC và policy guards linh hoạt với @Roles(), @Permissions() và PolicyGuard.",
  },
  "apis/openapi": {
    title: "OpenAPI (Swagger)",
    description:
      "Tự động sinh tài liệu OpenAPI 3.0/3.1 và giao diện Swagger UI từ decorators và DTO.",
  },
  "apis/graphql": {
    title: "GraphQL & Apollo",
    description:
      "Xây dựng GraphQL code-first và schema-first, Subscriptions qua WebSocket và DataLoader thuần Bun.",
  },
  "apis/websockets": {
    title: "WebSockets",
    description:
      "Xây dựng gateway realtime với @WebSocketGateway, @SubscribeMessage, rooms và Bun native WebSocket.",
  },
  "distributed/microservices": {
    title: "Microservices",
    description:
      "Giao tiếp microservice qua TCP, Redis, NATS, MQTT và hybrid apps với @MessagePattern & @EventPattern.",
  },
  "distributed/cqrs": {
    title: "CQRS",
    description:
      "Tách biệt lệnh và truy vấn với CommandBus, QueryBus, EventBus và Sagas trong @bunest/cqrs.",
  },
  "distributed/resilience": {
    title: "Chống lỗi (Resilience)",
    description:
      "Bảo vệ dịch vụ với Circuit Breaker, Retry, Timeout, Bulkhead và Hedging trong @bunest/resilience.",
  },
  "distributed/locks-idempotency": {
    title: "Khóa phân tán & Idempotency",
    description:
      "Đảm bảo xử lý đúng một lần với Distributed Locks, fencing tokens và IdempotencyStore.",
  },
  "distributed/outbox-webhooks": {
    title: "Outbox & Webhooks",
    description:
      "Transactional Outbox đảm bảo gửi sự kiện tin cậy và ký/retry Webhook chuẩn HMAC.",
  },
  "distributed/workflows": {
    title: "Durable workflows",
    description:
      "Điều phối quy trình chạy dài có lưu trạng thái, checkpoint và phục hồi sau sự cố với @bunest/workflows.",
  },
  "ai/ai-sdk": {
    title: "AI SDK",
    description:
      "Tích hợp LLM (OpenAI, Anthropic, Gemini), streaming, structured output và tool calling với @bunest/ai.",
  },
  "ai/mcp": {
    title: "Model Context Protocol (MCP)",
    description:
      "Xây dựng MCP server (tools, resources, prompts) bằng decorators @McpTool, @McpResource trong @bunest/ai.",
  },
  "observability/observability": {
    title: "Giám sát, Health & Devtools",
    description:
      "Health checks (/health), OpenTelemetry traces/metrics OTLP và đồ thị DI Devtools.",
  },
  "observability/cli": {
    title: "CLI",
    description:
      "Khởi tạo dự án, sinh code schematics, build, dev watch và bunest verify với @bunest/cli.",
  },
  "architecture/execution-pipeline": {
    title: "Pipeline thực thi 11 bước",
    description:
      "Hành trình chi tiết của một HTTP request qua 11 giai đoạn từ middleware đến serialization.",
  },
  "architecture/hybrid-router": {
    title: "Hybrid Bun.serve Router",
    description:
      "Biên dịch route tĩnh sang Bun.serve({ routes }) gốc kết hợp Radix fallback router.",
  },
  "architecture/response-serialization": {
    title: "Tuần tự hóa Response",
    description:
      "Cách Bunest chuyển đổi kết quả trả về từ controller (JSON, string, Response, StreamableFile).",
  },
  "architecture/adrs": {
    title: "Danh mục ADR & RFC",
    description:
      "Các quyết định kiến trúc cốt lõi (ADR-001..ADR-018) định hình thiết kế của Bunest.",
  },
  "architecture/migration-from-nestjs": {
    title: "Chuyển đổi từ NestJS",
    description:
      "Bảng ánh xạ import, khác biệt chính (không RxJS, thuần Bun) và lộ trình chuyển đổi từ NestJS.",
  },
  "ecosystem/packages": {
    title: "Gói & Monorepo",
    description:
      "Tổng quan 19 gói @bunest/* không phụ thuộc runtime ngoài và đồ thị phụ thuộc DAG.",
  },
  "ecosystem/roadmap": {
    title: "Lộ trình phát triển",
    description:
      "Tiến độ triển khai các tính năng cốt lõi, độ tương thích NestJS và kế hoạch sắp tới.",
  },
};

export function getCategoryTitle(
  categoryId: string,
  enTitle: string,
  lang: DocsLang,
): string {
  if (lang === "vi") {
    return VI_CATEGORY_TITLES[categoryId] ?? enTitle;
  }
  return enTitle;
}

export function getPageMeta(
  slug: string,
  enTitle: string,
  enDescription: string,
  lang: DocsLang,
): { title: string; description: string } {
  if (lang === "vi") {
    const localized = VI_PAGE_META[slug];
    if (localized) {
      return { title: localized.title, description: localized.description };
    }
  }
  return { title: enTitle, description: enDescription };
}
