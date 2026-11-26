import type { DocsLang } from "./i18n";
import { withBasePath } from "./navigation";

/**
 * Interactive visual diagrams & feature components embedded inside docs pages
 * via `@@component(name)` directives.
 */

export interface PipelineStageInfo {
  num: string;
  name: string;
  phase:
    "routing" | "security" | "enhancer" | "onion" | "serialization" | "error";
  order: string;
  summary: string;
  detail: string;
  hook: string;
}

const PIPELINE_STAGES: readonly PipelineStageInfo[] = [
  {
    num: "01",
    name: "Route Match",
    phase: "routing",
    order: "Bun.serve native Zig router -> Fallback Radix Router",
    summary:
      "O(1)/radix route matching with static > :param > * > fetch precedence.",
    detail:
      "95%+ of REST routes run directly in Bun.serve({ routes }) with precomputed per-path dispatchers. Unmatched HTTP verbs return 405 + Allow immediately without re-matching.",
    hook: "ADR-011 • ControllerScanner & RouteCompiler",
  },
  {
    num: "02",
    name: "RequestContext Init",
    phase: "routing",
    order: "Per-request context (+ AsyncLocalStorage only if Scope.REQUEST)",
    summary:
      "Allocates lightweight RequestContext holding params, lazy body cache, and ResponseContext.",
    detail:
      "Pure-singleton routes skip RequestContainer creation entirely (zero DI lookups per request). Routes marked Scope.REQUEST enter AsyncLocalStorage.run() with an isolated RequestContainer.",
    hook: "ADR-012 • RequestContext & RequestContainer",
  },
  {
    num: "03",
    name: "Security & CORS",
    phase: "security",
    order: "Preflight short-circuit -> Body size limit -> Trust-proxy IP",
    summary:
      "Handles OPTIONS preflight (204), enforces bodyLimit (413), and guarantees CORS headers on errors.",
    detail:
      "Runs inside the Exception Filter boundary so even 400/401/403/413/500 responses preserve configured Access-Control-* headers.",
    hook: "CorsOptions • PayloadTooLargeException (413)",
  },
  {
    num: "04",
    name: "Middleware",
    phase: "enhancer",
    order: "Global (app.use) -> Module (MiddlewareConsumer topological order)",
    summary:
      "Pre-bound at bootstrap into each route closure — zero per-request path regex matching.",
    detail:
      "Supports class-based BunestMiddleware (with DI) and plain functions. Returning a Web Response short-circuits downstream stages while retaining CORS headers.",
    hook: "BunestMiddleware • MiddlewareConsumer.apply().forRoutes()",
  },
  {
    num: "05",
    name: "Guards",
    phase: "enhancer",
    order:
      "Global (APP_GUARD) -> Controller (@UseGuards) -> Method (@UseGuards)",
    summary: "Authorization gate running BEFORE body parsing and validation.",
    detail:
      "Returning false throws ForbiddenException (403); throwing UnauthorizedException (401) propagates directly. Unauthorized requests never pay JSON parsing or DTO validation costs.",
    hook: "CanActivate • Reflector.getAllAndOverride()",
  },
  {
    num: "06",
    name: "Interceptors [Before]",
    phase: "onion",
    order: "Global -> Controller -> Method (outer wraps inner)",
    summary:
      "Native Promise-based onion model — zero mandatory RxJS dependency.",
    detail:
      "Interceptors can inspect ExecutionContext, start timers, or short-circuit early (e.g. cache hits) by returning a value without invoking next.handle().",
    hook: "BunestInterceptor • CallHandler.handle(): Promise<T>",
  },
  {
    num: "07",
    name: "Parameter Extraction",
    phase: "onion",
    order: "Ascending ParameterMetadata.index (cached single-read body)",
    summary:
      "Extracts @Param, @Query, @Body, @Headers, @Cookies, @Req, @Res, @Ip, and custom decorators.",
    detail:
      "Request body stream is read at most once and cached in RequestContext. Malformed JSON throws BadRequestException (400) here before pipes execute.",
    hook: "ADR-004 • ParameterMetadata (zero Reflect.getMetadata at runtime)",
  },
  {
    num: "08",
    name: "Pipes & Validation",
    phase: "onion",
    order: "Global -> Controller -> Method -> Parameter",
    summary:
      "Transforms primitives (ParseIntPipe) and validates DTOs (ValidationPipe / SchemaValidationPipe).",
    detail:
      "Runs sequentially per parameter. Prototype pollution keys (__proto__, constructor, prototype) are rejected; invalid payloads throw ADR-009 normalized 400 JSON and never call the handler.",
    hook: "ADR-005 / ADR-009 • ValidationPipe & Built-in Parse Pipes",
  },
  {
    num: "09",
    name: "Controller Handler",
    phase: "onion",
    order: "await controllerInstance[handlerKey](...resolvedArgs)",
    summary: "Executes your route method with typed, validated arguments.",
    detail:
      "May return plain objects, primitives, Promises, Bun.file(), ReadableStream, AsyncIterable (@Sse), or a raw native Web Response.",
    hook: "ADR-003 • Stateless Singleton Controller",
  },
  {
    num: "10",
    name: "Interceptors [After]",
    phase: "onion",
    order: "Method -> Controller -> Global (inner unwinds to outer)",
    summary:
      "Post-processes handler output (e.g., ClassSerializerInterceptor, response wrapping, timing logs).",
    detail:
      "Awaits next.handle(), transforms or inspects the resolved return value, or catches and remaps errors thrown by stages 7–9.",
    hook: "ClassSerializerInterceptor • @SerializeOptions()",
  },
  {
    num: "11",
    name: "Response Serialization",
    phase: "serialization",
    order:
      "Response passthrough -> @Redirect -> @Sse -> Stream/Blob -> Text/JSON",
    summary:
      "Converts final value into a native Web Response with RFC 9110 empty-body enforcement.",
    detail:
      "Applies POST -> 201 Created default, merges @Header and ResponseContext headers/cookies (always appending Set-Cookie), and enforces empty bodies on 204/304/HEAD.",
    hook: "ADR-010 • ResponseSerializer & ResponseContext",
  },
  {
    num: "EX",
    name: "Exception Filters",
    phase: "error",
    order:
      "Method -> Controller -> Global -> DefaultExceptionFilter (most specific first)",
    summary:
      "Catches throws from stages 3–11 plus 404/405 with zero stack-trace leaks in production.",
    detail:
      "Matches @Catch(...ExceptionTypes) via instanceof. DefaultExceptionFilter emits the uniform { statusCode, error, message, details?, timestamp, path } JSON envelope while preserving CORS headers.",
    hook: "ADR-008 • @Catch() & DefaultExceptionFilter",
  },
];

function escapeHtml(input: string): string {
  return Bun.escapeHTML(input);
}

function renderHeroCards(basePath = "", lang: DocsLang = "en"): string {
  const href = (p: string) => withBasePath(p, basePath);
  if (lang === "vi") {
    return `<div class="bn-hero-banner">
  <div class="bn-hero-badge">
    <span class="bn-pulse-dot" aria-hidden="true"></span>
    <span>Bun 1.4.5+ &bull; 19 gói không phụ thuộc ngoài &bull; Zero Reflection mỗi Request</span>
  </div>
  <p class="bn-hero-lead">
    Xây dựng REST API TypeScript mô-đun với <strong>controller, DI và validation kiểu NestJS</strong> — biên dịch một lần lúc khởi động thành route closure gốc của <code>Bun.serve()</code>.
  </p>
  <div class="bn-hero-actions">
    <a class="bn-btn bn-btn-primary" href="${href("/overview/first-steps")}" data-spa-link>
      <span>Chạy API đầu tiên</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
    </a>
    <a class="bn-btn bn-btn-secondary" href="${href("/architecture/migration-from-nestjs")}" data-spa-link>
      <span>Đến từ NestJS</span>
    </a>
    <a class="bn-btn bn-btn-ghost" href="${href("/architecture/execution-pipeline")}" data-spa-link>
      <span>Pipeline 11 bước</span>
    </a>
  </div>
</div>
<div class="bn-feature-grid">
  <a class="bn-feature-card" href="${href("/overview/controllers")}" data-spa-link>
    <div class="bn-feature-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    </div>
    <h3>Định tuyến biên dịch lúc khởi động</h3>
    <p><code>@Controller</code> &amp; HTTP decorators biên dịch một lần thành closure gốc của <code>Bun.serve({ routes })</code>.</p>
  </a>
  <a class="bn-feature-card" href="${href("/overview/modules")}" data-spa-link>
    <div class="bn-feature-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
    </div>
    <h3>DI mô-đun chặt chẽ</h3>
    <p>Đóng gói module private mặc định, chẩn đoán vòng phụ thuộc và chặn sớm <code>ScopeLeakException</code>.</p>
  </a>
  <a class="bn-feature-card" href="${href("/techniques/validation")}" data-spa-link>
    <div class="bn-feature-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
    </div>
    <h3>Validation an toàn mặc định</h3>
    <p><code>ValidationPipe</code> bật sẵn <code>whitelist</code>, chống prototype pollution và hỗ trợ Standard Schema.</p>
  </a>
  <a class="bn-feature-card" href="${href("/overview/interceptors")}" data-spa-link>
    <div class="bn-feature-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
    </div>
    <h3>Onion Pipeline không RxJS</h3>
    <p>Interceptor thuần <code>Promise</code> async/await, Web <code>Request</code>/<code>Response</code> gốc và SSE stream.</p>
  </a>
</div>`;
  }
  return `<div class="bn-hero-banner">
  <div class="bn-hero-badge">
    <span class="bn-pulse-dot" aria-hidden="true"></span>
    <span>Bun 1.4.5+ &bull; 19 Zero-Dep Packages &bull; Zero Per-Request Reflection</span>
  </div>
  <p class="bn-hero-lead">
    Build modular TypeScript REST APIs with <strong>NestJS-style controllers, DI, and validation</strong> — compiled once at bootstrap into native <code>Bun.serve()</code> route closures.
  </p>
  <div class="bn-hero-actions">
    <a class="bn-btn bn-btn-primary" href="${href("/overview/first-steps")}" data-spa-link>
      <span>Run your first API</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
    </a>
    <a class="bn-btn bn-btn-secondary" href="${href("/architecture/migration-from-nestjs")}" data-spa-link>
      <span>Coming from NestJS</span>
    </a>
    <a class="bn-btn bn-btn-ghost" href="${href("/architecture/execution-pipeline")}" data-spa-link>
      <span>11-Stage Pipeline</span>
    </a>
  </div>
</div>
<div class="bn-feature-grid">
  <a class="bn-feature-card" href="${href("/overview/controllers")}" data-spa-link>
    <div class="bn-feature-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    </div>
    <h3>Compile-at-Bootstrap Routing</h3>
    <p><code>@Controller</code> &amp; HTTP decorators compile once into native <code>Bun.serve({ routes })</code> closures.</p>
  </a>
  <a class="bn-feature-card" href="${href("/overview/modules")}" data-spa-link>
    <div class="bn-feature-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
    </div>
    <h3>Strict Modular DI</h3>
    <p>Private-by-default encapsulation, cycle diagnostics, and fail-fast <code>ScopeLeakException</code> checks.</p>
  </a>
  <a class="bn-feature-card" href="${href("/techniques/validation")}" data-spa-link>
    <div class="bn-feature-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
    </div>
    <h3>Secure-by-Default Validation</h3>
    <p><code>ValidationPipe</code> ships with <code>whitelist</code>, prototype-pollution guards, and Standard Schema support.</p>
  </a>
  <a class="bn-feature-card" href="${href("/overview/interceptors")}" data-spa-link>
    <div class="bn-feature-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
    </div>
    <h3>Zero-RxJS Onion Pipeline</h3>
    <p>Async/await native <code>Promise</code> interceptors, Web <code>Request</code>/<code>Response</code> passthrough, and SSE streams.</p>
  </a>
</div>`;
}

function renderPipelineDiagram(): string {
  const buttons = PIPELINE_STAGES.map((stage, idx) => {
    const active = idx === 0 ? " is-active" : "";
    return `<button type="button" class="bn-pipe-node phase-${stage.phase}${active}" data-pipe-idx="${idx}" aria-pressed="${idx === 0 ? "true" : "false"}">
      <span class="bn-pipe-num">${stage.num}</span>
      <span class="bn-pipe-label">${escapeHtml(stage.name)}</span>
    </button>`;
  }).join("");

  const first = PIPELINE_STAGES[0]!;
  const jsonPayload = escapeHtml(JSON.stringify(PIPELINE_STAGES));

  return `<div class="bn-widget bn-pipeline-widget" data-pipeline-stages="${jsonPayload}">
  <div class="bn-widget-header">
    <div>
      <span class="bn-widget-eyebrow">INTERACTIVE EXPLORER &bull; ADR-008</span>
      <h4 class="bn-widget-title">11-Stage HTTP Execution Pipeline</h4>
    </div>
    <span class="bn-widget-hint">Click any stage to inspect execution contract</span>
  </div>
  <div class="bn-pipe-grid">${buttons}</div>
  <div class="bn-pipe-inspector" aria-live="polite">
    <div class="bn-pipe-inspector-top">
      <span class="bn-pipe-inspector-badge" data-pipe-badge>STAGE ${first.num}</span>
      <strong class="bn-pipe-inspector-name" data-pipe-name>${escapeHtml(first.name)}</strong>
      <code class="bn-pipe-inspector-hook" data-pipe-hook>${escapeHtml(first.hook)}</code>
    </div>
    <div class="bn-pipe-inspector-order"><strong>Precedence / Order:</strong> <span data-pipe-order>${escapeHtml(first.order)}</span></div>
    <p class="bn-pipe-inspector-summary" data-pipe-summary>${escapeHtml(first.summary)}</p>
    <p class="bn-pipe-inspector-detail" data-pipe-detail>${escapeHtml(first.detail)}</p>
  </div>
</div>`;
}

function renderScopeMatrix(): string {
  return `<div class="bn-widget bn-scope-widget">
  <div class="bn-widget-header">
    <div>
      <span class="bn-widget-eyebrow">BOOTSTRAP GATE &bull; ADR-012</span>
      <h4 class="bn-widget-title">Strict Scope-Leak Detection Matrix</h4>
    </div>
    <span class="bn-widget-hint">Validated before Bun.serve() binds a port</span>
  </div>
  <div class="bn-scope-table-wrap">
    <table class="bn-scope-table">
      <thead>
        <tr>
          <th>Consumer Scope</th>
          <th>Injects <code>SINGLETON</code></th>
          <th>Injects <code>TRANSIENT</code></th>
          <th>Injects <code>REQUEST</code></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong><code>Scope.SINGLETON</code></strong> <span class="bn-tag-muted">default</span></td>
          <td><span class="bn-status-ok">Allowed</span> Shared instance</td>
          <td><span class="bn-status-ok">Allowed</span> Dedicated instance at bootstrap</td>
          <td><span class="bn-status-err">FAIL FAST</span> Throws <code>ScopeLeakException</code></td>
        </tr>
        <tr>
          <td><strong><code>Scope.TRANSIENT</code></strong></td>
          <td><span class="bn-status-ok">Allowed</span> Shared instance</td>
          <td><span class="bn-status-ok">Allowed</span> New instance per resolve</td>
          <td><span class="bn-status-warn">Conditional</span> Only if all owners are <code>REQUEST</code></td>
        </tr>
        <tr>
          <td><strong><code>Scope.REQUEST</code></strong></td>
          <td><span class="bn-status-ok">Allowed</span> Shared instance</td>
          <td><span class="bn-status-ok">Allowed</span> New instance per request</td>
          <td><span class="bn-status-ok">Allowed</span> Shared within same request</td>
        </tr>
      </tbody>
    </table>
  </div>
</div>`;
}

function renderRouterArchitecture(): string {
  return `<div class="bn-widget bn-router-widget">
  <div class="bn-widget-header">
    <div>
      <span class="bn-widget-eyebrow">COMPILE-AT-BOOTSTRAP &bull; ADR-011</span>
      <h4 class="bn-widget-title">Hybrid Native Zig Router + Fallback Radix Dispatcher</h4>
    </div>
  </div>
  <div class="bn-router-flow">
    <div class="bn-router-box bn-router-entry">
      <div class="bn-router-box-tag">INCOMING HTTP</div>
      <strong>Bun.serve({ routes, fetch, websocket })</strong>
      <span>Zero Express / Node HTTP layer</span>
    </div>
    <div class="bn-router-arrow">&darr;</div>
    <div class="bn-router-split">
      <div class="bn-router-branch bn-router-fast">
        <div class="bn-router-box-tag">FAST PATH (~95% ROUTES)</div>
        <strong>Native <code>routes[path]</code> Zig Router</strong>
        <ul>
          <li>Static paths, <code>:param</code>, trailing <code>/*</code></li>
          <li>Per-path compiled O(1) method dispatcher</li>
          <li>Instant <code>405 + Allow</code> &amp; CORS preflight</li>
          <li>Pre-bound middleware &amp; zero <code>Reflect</code> calls</li>
        </ul>
      </div>
      <div class="bn-router-branch bn-router-fallback">
        <div class="bn-router-box-tag">CONTROLLED FALLBACK</div>
        <strong><code>fetch(req, server)</code> Radix Router</strong>
        <ul>
          <li>WebSocket upgrade dispatch (<code>server.upgrade</code>)</li>
          <li>Opt-in <code>ignoreTrailingSlash</code></li>
          <li><code>@Controller({ host })</code>, mid-path <code>/*</code>, optional/regex params</li>
          <li>Unified <code>404 NotFoundException</code> &rarr; Exception Filters</li>
        </ul>
      </div>
    </div>
    <div class="bn-router-arrow">&darr;</div>
    <div class="bn-router-box bn-router-plan">
      <div class="bn-router-box-tag">UNIFIED EXECUTION</div>
      <strong>Identical <code>CompiledExecutionPlan</code> Closure (ADR-008)</strong>
      <span>CORS &rarr; Middleware &rarr; Guards &rarr; Interceptors &rarr; Params/Pipes &rarr; Handler &rarr; Serializer</span>
    </div>
  </div>
</div>`;
}

export function renderComponent(
  name: string,
  basePath = "",
  lang: DocsLang = "en",
): string {
  switch (name.trim()) {
    case "hero-cards":
      return renderHeroCards(basePath, lang);
    case "pipeline-diagram":
      return renderPipelineDiagram();
    case "scope-matrix":
      return renderScopeMatrix();
    case "router-architecture":
      return renderRouterArchitecture();
    default:
      return `<!-- unknown component: ${escapeHtml(name)} -->`;
  }
}
