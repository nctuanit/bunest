/**
 * AI-actionable error catalog.
 *
 * Every bootstrap/routing exception thrown by `@bunest/core` carries a stable
 * `BUNEST_E*` code that maps to an entry here. Coding agents (and humans) can
 * rely on the code instead of parsing free-form messages, and use `fixes` as an
 * ordered list of remediation strategies.
 *
 * This module is pure data + helpers and MUST NOT import any exception class
 * (keeps the import graph acyclic). `docs/errors.md` is generated from it.
 */

export interface BunestErrorCatalogEntry {
  readonly code: string;
  /** Exception class name. */
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  /** Ordered remediation strategies, most likely fix first. */
  readonly fixes: readonly string[];
  /** Minimal canonical code sample showing the most common fix. */
  readonly example?: string;
}

export const BUNEST_ERROR_DOCS_BASE_URL =
  "https://github.com/bunest/bunest/blob/main/docs/errors.md";

export const BUNEST_ERROR_CATALOG = {
  BUNEST_E001: {
    code: "BUNEST_E001",
    name: "UnknownDependencyException",
    title: "Unknown dependency",
    summary:
      "The DI container cannot resolve a constructor parameter or property of a provider/controller in the given module.",
    fixes: [
      "Add the missing class to the `providers` array of the module that declares the requester.",
      "If the provider lives in another module, add it to that module's `exports` and add that module to `imports`.",
      "If the parameter type is an interface, union, or generic (erased at runtime), inject with `@Inject(TOKEN)` and register `{ provide: TOKEN, useClass | useValue | useFactory }`.",
      "Value-import the dependency class (never `import type`) so `design:paramtypes` keeps the runtime reference.",
      "If the dependency is genuinely optional, decorate the parameter with `@Optional()`.",
    ],
    example: `@Module({
  imports: [UsersModule],          // UsersModule must export UsersService
  providers: [OrdersService],
})
export class OrdersModule {}`,
  },
  BUNEST_E002: {
    code: "BUNEST_E002",
    name: "CircularDependencyException",
    title: "Circular dependency",
    summary:
      "Two or more providers (or modules) depend on each other, so neither can be constructed first.",
    fixes: [
      "Extract the shared logic into a third provider that both depend on (preferred).",
      "For providers: use `@Inject(forwardRef(() => OtherService))` on one side.",
      "For modules: use `forwardRef(() => OtherModule)` in one module's `imports`.",
    ],
    example: `constructor(
  @Inject(forwardRef(() => UsersService))
  private readonly users: UsersService,
) {}`,
  },
  BUNEST_E003: {
    code: "BUNEST_E003",
    name: "ScopeLeakException",
    title: "Scope leak",
    summary:
      "A longer-lived provider (e.g. SINGLETON) depends on a REQUEST-scoped provider, which would leak request state across requests.",
    fixes: [
      "Mark every provider in the chain with `{ scope: Scope.REQUEST }`.",
      "Read request data through the ambient `RequestContext`/`ClsService` inside methods instead of injecting a request-scoped provider.",
    ],
    example: `@Injectable({ scope: Scope.REQUEST })
export class ReportService {}`,
  },
  BUNEST_E004: {
    code: "BUNEST_E004",
    name: "AmbiguousProviderException",
    title: "Ambiguous provider",
    summary:
      "The same injection token is exported by more than one imported (or global) module, so resolution is ambiguous.",
    fixes: [
      "Use distinct injection tokens (e.g. `Symbol(\"PRIMARY_DB\")`, `Symbol(\"REPORTING_DB\")`).",
      "Override the token locally in the consuming module's `providers`.",
      "Remove the duplicate export from one of the modules.",
    ],
  },
  BUNEST_E005: {
    code: "BUNEST_E005",
    name: "InvalidModuleException",
    title: "Invalid module",
    summary:
      "A value listed in `imports` (or the root module) is not a class decorated with `@Module()` nor a valid dynamic module.",
    fixes: [
      "Decorate the class with `@Module({...})`.",
      "For dynamic modules return `{ module: ThisModule, providers, exports }` from `forRoot()`/`register()`.",
      "Check for `undefined` entries caused by circular file imports; use `forwardRef(() => Module)`.",
    ],
  },
  BUNEST_E006: {
    code: "BUNEST_E006",
    name: "DuplicateProviderException",
    title: "Duplicate provider",
    summary: "The same provider token is declared more than once in a single module.",
    fixes: [
      "Remove the duplicated entry from the module's `providers` array.",
      "If two implementations are intended, give them distinct tokens.",
    ],
  },
  BUNEST_E007: {
    code: "BUNEST_E007",
    name: "InvalidExportException",
    title: "Invalid export",
    summary:
      "A module exports a token that it neither provides nor imports from another module.",
    fixes: [
      "Add the token to the module's `providers` before exporting it.",
      "Or import the module that provides it and re-export that module.",
    ],
  },
  BUNEST_E101: {
    code: "BUNEST_E101",
    name: "DuplicateRouteException",
    title: "Duplicate route",
    summary:
      "Two controller handlers resolve to the same HTTP method + canonical path (+ host/version).",
    fixes: [
      "Change the path of one handler or its controller prefix.",
      "Use `@Version()` / `@Controller({ version })` or `host` to disambiguate intentionally.",
      "If shadowing is intended, configure `routeConflictPolicy` on the application.",
    ],
  },
  BUNEST_E102: {
    code: "BUNEST_E102",
    name: "InvalidControllerException",
    title: "Invalid controller",
    summary:
      "A class registered in a module's `controllers` array is missing `@Controller()`.",
    fixes: [
      "Decorate the class with `@Controller(\"prefix\")`.",
      "If it is a service, move it from `controllers` to `providers`.",
    ],
  },
  BUNEST_E103: {
    code: "BUNEST_E103",
    name: "InvalidRouteException",
    title: "Invalid route",
    summary:
      "Route metadata or parameter bindings are invalid (e.g. malformed path, conflicting parameter decorators).",
    fixes: [
      "Read the message for the offending handler and fix its path or parameter decorators.",
      "Ensure each handler parameter has exactly one binding decorator (`@Body`, `@Param`, `@Query`, ...).",
    ],
  },
} as const satisfies Record<string, BunestErrorCatalogEntry>;

export type BunestErrorCode = keyof typeof BUNEST_ERROR_CATALOG;

export function isBunestErrorCode(value: unknown): value is BunestErrorCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(BUNEST_ERROR_CATALOG, value)
  );
}

export function getErrorCatalogEntry(
  code: string,
): BunestErrorCatalogEntry | undefined {
  return isBunestErrorCode(code) ? BUNEST_ERROR_CATALOG[code] : undefined;
}

export function getErrorDocsUrl(code: string): string {
  return `${BUNEST_ERROR_DOCS_BASE_URL}#${code.toLowerCase()}`;
}

/** Machine-readable, JSON-safe description of a Bunest error. */
export interface BunestErrorReport {
  readonly code: string;
  readonly name: string;
  readonly title: string;
  readonly message: string;
  readonly fixes: readonly string[];
  readonly docs: string;
  readonly details: Readonly<Record<string, unknown>>;
}

const OMITTED_DETAIL_KEYS = new Set(["stack", "message", "name", "code"]);

function toJsonSafe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "symbol":
      return value.toString();
    case "function":
      return (value as { name?: string }).name || "<anonymous>";
    default:
      break;
  }
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = toJsonSafe(v, depth + 1);
  }
  return out;
}

/**
 * Builds a structured report for any error carrying a known `BUNEST_E*` code.
 * Returns `undefined` for foreign errors.
 */
export function toBunestErrorReport(
  error: unknown,
): BunestErrorReport | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  const entry = typeof code === "string" ? getErrorCatalogEntry(code) : undefined;
  if (!entry) return undefined;

  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (OMITTED_DETAIL_KEYS.has(key)) continue;
    if (key === "details" && value && typeof value === "object") {
      Object.assign(details, toJsonSafe(value) as Record<string, unknown>);
      continue;
    }
    details[key] = toJsonSafe(value);
  }

  return {
    code: entry.code,
    name: entry.name,
    title: entry.title,
    message: String((error as { message?: unknown }).message ?? ""),
    fixes: entry.fixes,
    docs: getErrorDocsUrl(entry.code),
    details,
  };
}

/**
 * Compact, token-efficient rendering for coding agents and CI logs.
 * Falls back to `name: message` for errors without a Bunest code.
 */
export function formatBunestErrorForAgent(error: unknown): string {
  const report = toBunestErrorReport(error);
  if (!report) {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
  }
  const firstLine = report.message.split("\n")[0] ?? report.message;
  const lines = [
    `[${report.code}] ${report.title}: ${firstLine}`,
    ...report.fixes.map((fix, i) => `  fix ${i + 1}: ${fix}`),
    `  docs: ${report.docs}`,
  ];
  return lines.join("\n");
}
