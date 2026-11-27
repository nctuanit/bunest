import {
  ClsService,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  Reflector,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";
import { getCurrentRequestContext } from "@bunest/core/http";
import { AuthenticationContext } from "../auth-next/context/authentication.context";
import { getAuthState } from "../auth-next/utils/auth-state.util";
import { IS_PUBLIC_KEY, getRequestUser } from "./auth.decorators";

export const REQUIRE_TENANT_KEY = Symbol.for("bunest:security:require_tenant");
export const TENANT_ROLES_KEY = Symbol.for("bunest:security:tenant_roles");
export const TENANT_GUARD_OPTIONS = Symbol.for(
  "bunest:security:tenant_guard_options",
);

export type TenantSource = "user" | "header" | "param" | "subdomain";

export const DEFAULT_TENANT_SOURCES: readonly TenantSource[] = [
  "user",
  "header",
  "param",
  "subdomain",
];

const DEFAULT_TENANT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const requestTenantStore = new WeakMap<object, string>();
const ambientCls = new ClsService();

export function setRequestTenant(req: object, tenantId: string): void {
  requestTenantStore.set(req, tenantId);
}

export function getRequestTenant(req: object): string | undefined {
  return requestTenantStore.get(req);
}

export interface RequireTenantOptions {
  /**
   * Ordered priority list of sources used to resolve the tenant ID.
   * @default ["user", "header", "param", "subdomain"]
   */
  sources?: readonly TenantSource[];
  /** HTTP header name for the `"header"` source. Default `"x-tenant-id"`. */
  headerName?: string;
  /** Route param name for the `"param"` source. Default `"tenantId"`. */
  paramName?: string;
  /** Base domain suffix for `"subdomain"` extraction (e.g. `"example.com"`). */
  baseDomain?: string;
  /** Subdomains ignored when extracting from host without `baseDomain`. Default `["www"]`. */
  ignoredSubdomains?: readonly string[];
  /** CLS key under which resolved `tenantId` is stored. Default `"tenantId"`. */
  clsKey?: string;
  /**
   * Require an authenticated user to access this tenant-scoped route.
   * Always `true` when `@TenantRoles(...)` is present.
   * @default true
   */
  requireAuthenticated?: boolean;
  /**
   * Require explicit membership proof for authenticated users when the tenant is
   * resolved from untrusted sources (`header`/`param`/`subdomain`) — even when the
   * user carries no tenant claims and no `validateMembership` callback is configured.
   * Set to `false` to explicitly opt out of membership verification for unbound users.
   * @default true
   */
  requireMembership?: boolean;
  /**
   * Require all declared `@TenantRoles(...)` instead of any single matching role.
   * @default false
   */
  requireAllRoles?: boolean;
  /**
   * Reject requests where multiple configured request sources (e.g. header and route param)
   * supply conflicting tenant IDs.
   * @default true
   */
  enforceConsistentSources?: boolean;
  /**
   * Validation pattern for tenant IDs to block header/log/key injection.
   * @default /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
   */
  tenantIdPattern?: RegExp;
}

export interface TenantGuardOptions extends RequireTenantOptions {
  /**
   * Enforce tenant resolution on every route (except `@Public()` routes without `@RequireTenant()`)
   * even when `@RequireTenant()` is not explicitly applied.
   * @default false
   */
  requireByDefault?: boolean;
  /**
   * Optional custom tenant resolver executed before built-in `sources`.
   */
  resolveTenant?: (
    context: ExecutionContext,
    req: Request,
    user: unknown,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * Optional custom membership validator. Returning `false` throws `ForbiddenException`.
   */
  validateMembership?: (
    user: unknown,
    tenantId: string,
    context: ExecutionContext,
  ) => boolean | Promise<boolean>;
  /**
   * Optional custom extractor returning the list of tenant IDs the user belongs to.
   */
  getUserTenants?: (
    user: unknown,
    context: ExecutionContext,
  ) => readonly string[] | undefined | Promise<readonly string[] | undefined>;
  /**
   * Optional custom resolver returning roles the user holds within `tenantId`.
   */
  getTenantRoles?: (
    user: unknown,
    tenantId: string,
    context: ExecutionContext,
  ) => readonly string[] | undefined | Promise<readonly string[] | undefined>;
  /**
   * Allow falling back to flat `user.roles` / `user.role` when `user.tenantRoles` is absent
   * and the user's primary `tenantId` matches the resolved tenant.
   * @default false
   */
  fallbackToUserRoles?: boolean;
}

/**
 * Marks a controller or route handler as tenant-scoped for `TenantGuard`.
 */
export const RequireTenant = (options: RequireTenantOptions = {}) =>
  SetMetadata(REQUIRE_TENANT_KEY, options);

/**
 * Declares required tenant-scoped roles checked by `TenantGuard` against
 * `user.tenantRoles?.[tenantId]` (or `TenantGuardOptions.getTenantRoles`).
 */
export const TenantRoles = (...roles: string[]) =>
  SetMetadata(TENANT_ROLES_KEY, roles);

/**
 * Parameter decorator extracting the active `tenantId` resolved by `TenantGuard`
 * (from the request attachment, `RequestContext`, or `ClsService`).
 */
export const CurrentTenant = createParamDecorator(
  (clsKey: string | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<Request>();
    const fromReq = req ? getRequestTenant(req) : undefined;
    if (fromReq !== undefined) {
      return fromReq;
    }
    const key = clsKey ?? "tenantId";
    if (ambientCls.isActive()) {
      const fromCls = ambientCls.get<string>(key);
      if (typeof fromCls === "string" && fromCls.length > 0) {
        return fromCls;
      }
    }
    const reqCtx = getCurrentRequestContext() as
      | Record<string, unknown>
      | undefined;
    const fromCtx = reqCtx?.[key];
    return typeof fromCtx === "string" ? fromCtx : undefined;
  },
);

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readHeader(
  req: Record<string, unknown> | undefined,
  headerName: string,
): string | undefined {
  if (!req || typeof req !== "object") {
    return undefined;
  }
  const headers = req.headers;
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  if (
    "get" in headers &&
    typeof (headers as { get?: unknown }).get === "function"
  ) {
    return readNonEmptyString(
      (headers as { get: (n: string) => string | null }).get(headerName),
    );
  }
  const map = headers as Record<string, unknown>;
  const raw = map[headerName] ?? map[headerName.toLowerCase()];
  if (typeof raw === "string") {
    return readNonEmptyString(raw);
  }
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    return readNonEmptyString(raw[0]);
  }
  return undefined;
}

function extractUserPrimaryTenant(
  user: Record<string, unknown> | undefined,
  session: Record<string, unknown> | undefined,
): string | undefined {
  if (user) {
    const direct =
      readNonEmptyString(user.tenantId) ??
      readNonEmptyString(user.orgId) ??
      readNonEmptyString(user.organizationId) ??
      readNonEmptyString(user.tenant_id) ??
      readNonEmptyString(user.org_id);
    if (direct) {
      return direct;
    }
  }
  if (session) {
    const fromSession =
      readNonEmptyString(session.tenantId) ??
      readNonEmptyString(session.orgId) ??
      readNonEmptyString(session.organizationId);
    if (fromSession) {
      return fromSession;
    }
    const meta = session.metadata;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const m = meta as Record<string, unknown>;
      return (
        readNonEmptyString(m.tenantId) ??
        readNonEmptyString(m.orgId) ??
        readNonEmptyString(m.organizationId)
      );
    }
  }
  return undefined;
}

function extractUserMembershipTenants(
  user: Record<string, unknown> | undefined,
): string[] | undefined {
  if (!user) {
    return undefined;
  }

  let hasExplicitList = false;
  const collected = new Set<string>();

  const collectArray = (value: unknown) => {
    if (!Array.isArray(value)) {
      return;
    }
    hasExplicitList = true;
    for (const item of value) {
      if (typeof item === "string" && item.trim().length > 0) {
        collected.add(item.trim());
      } else if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const id =
          readNonEmptyString(rec.tenantId) ??
          readNonEmptyString(rec.orgId) ??
          readNonEmptyString(rec.id);
        if (id) {
          collected.add(id);
        }
      }
    }
  };

  collectArray(user.tenants);
  collectArray(user.tenantIds);
  collectArray(user.orgIds);
  collectArray(user.organizations);

  const collectRoleMap = (value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      hasExplicitList = true;
      for (const key of Object.keys(value as Record<string, unknown>)) {
        const trimmed = key.trim();
        if (trimmed.length > 0) {
          collected.add(trimmed);
        }
      }
    }
  };

  collectRoleMap(user.tenantRoles);
  collectRoleMap(user.orgRoles);

  return hasExplicitList ? [...collected] : undefined;
}

function extractSubdomainTenant(
  req: Record<string, unknown> | undefined,
  reqCtx: ReturnType<typeof getCurrentRequestContext>,
  paramName: string,
  baseDomain: string | undefined,
  ignoredSubdomains: readonly string[],
): string | undefined {
  const fromHostParams =
    readNonEmptyString(reqCtx?.hostParams?.[paramName]) ??
    readNonEmptyString(reqCtx?.hostParams?.tenant);
  if (fromHostParams) {
    return fromHostParams;
  }

  let rawHost = readHeader(req, "host");
  if (!rawHost && typeof req?.url === "string") {
    try {
      rawHost = new URL(req.url).host;
    } catch {
      rawHost = undefined;
    }
  }
  if (!rawHost) {
    return undefined;
  }

  // Strip port and trailing dot, reject IPv6 brackets and raw IPv4
  const lower = rawHost.trim().toLowerCase();
  if (lower.startsWith("[")) {
    return undefined;
  }
  const colonIdx = lower.indexOf(":");
  const hostname = (colonIdx === -1 ? lower : lower.slice(0, colonIdx)).replace(
    /\.+$/,
    "",
  );
  if (!hostname || IPV4_PATTERN.test(hostname)) {
    return undefined;
  }

  const ignored = new Set(ignoredSubdomains.map((s) => s.toLowerCase()));

  if (baseDomain) {
    const normalizedBase = baseDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    const suffix = `.${normalizedBase}`;
    if (!hostname.endsWith(suffix) || hostname.length <= suffix.length) {
      return undefined;
    }
    const sub = hostname.slice(0, hostname.length - suffix.length);
    // Only accept a single DNS label directly below baseDomain
    if (!sub || sub.includes(".") || ignored.has(sub)) {
      return undefined;
    }
    return sub;
  }

  const labels = hostname.split(".").filter(Boolean);
  if (labels.length === 2 && labels[1] === "localhost") {
    const sub = labels[0]!;
    return ignored.has(sub) ? undefined : sub;
  }
  if (labels.length >= 3) {
    const sub = labels[0]!;
    return ignored.has(sub) ? undefined : sub;
  }

  return undefined;
}

function extractRoleStrings(raw: unknown): string[] {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return [raw.trim()];
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
      .map((r) => r.trim());
  }
  return [];
}

/**
 * Multi-tenant authentication & authorization guard enforcing tenant resolution,
 * cross-tenant spoofing prevention, membership validation, tenant-scoped RBAC
 * (`@TenantRoles(...)`), and automatic propagation of `tenantId` into `ClsService`
 * and `RequestContext`.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    @Optional()
    private readonly reflector: Reflector = new Reflector(),
    @Optional()
    @Inject(TENANT_GUARD_OPTIONS)
    private readonly options?: TenantGuardOptions,
    @Optional()
    private readonly cls?: ClsService,
    @Optional()
    private readonly authContext?: AuthenticationContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const classRef = context.getClass();

    const routeOpts =
      this.reflector.getAllAndOverride<RequireTenantOptions | undefined>(
        REQUIRE_TENANT_KEY,
        [handler, classRef],
      );
    const requiredRoles = this.reflector.getAllAndOverride<
      string[] | undefined
    >(TENANT_ROLES_KEY, [handler, classRef]);

    const hasRoles = Boolean(requiredRoles && requiredRoles.length > 0);
    const explicitlyRequired = routeOpts !== undefined || hasRoles;

    if (!explicitlyRequired) {
      if (!this.options?.requireByDefault) {
        return true;
      }
      const isPublic = this.reflector.getAllAndOverride<boolean>(
        IS_PUBLIC_KEY,
        [handler, classRef],
      );
      if (isPublic) {
        return true;
      }
    }

    const req = context.switchToHttp().getRequest<Request>();
    const reqRec = req as unknown as Record<string, unknown> | undefined;
    const reqCtx = getCurrentRequestContext();

    // Resolve user & session from both auth-next (ALS / guard state) and legacy JwtAuthGuard / Passport
    const authState = getAuthState(context);
    const rawUser =
      this.authContext?.user ??
      authState?.user ??
      (req ? getRequestUser(req) : undefined) ??
      reqRec?.user;
    const user =
      rawUser && typeof rawUser === "object"
        ? (rawUser as Record<string, unknown>)
        : undefined;

    const rawSession =
      this.authContext?.session ?? authState?.session ?? reqRec?.session;
    const session =
      rawSession && typeof rawSession === "object"
        ? (rawSession as Record<string, unknown>)
        : undefined;

    const sources =
      routeOpts?.sources ?? this.options?.sources ?? DEFAULT_TENANT_SOURCES;
    const headerName = (
      routeOpts?.headerName ??
      this.options?.headerName ??
      "x-tenant-id"
    ).toLowerCase();
    const paramName =
      routeOpts?.paramName ?? this.options?.paramName ?? "tenantId";
    const baseDomain = routeOpts?.baseDomain ?? this.options?.baseDomain;
    const ignoredSubdomains = routeOpts?.ignoredSubdomains ??
      this.options?.ignoredSubdomains ?? ["www"];
    const clsKey = routeOpts?.clsKey ?? this.options?.clsKey ?? "tenantId";
    const requireAuthenticated = hasRoles
      ? true
      : (routeOpts?.requireAuthenticated ??
        this.options?.requireAuthenticated ??
        true);
    const requireMembership =
      routeOpts?.requireMembership ?? this.options?.requireMembership ?? true;
    const requireAllRoles =
      routeOpts?.requireAllRoles ?? this.options?.requireAllRoles ?? false;
    const enforceConsistentSources =
      routeOpts?.enforceConsistentSources ??
      this.options?.enforceConsistentSources ??
      true;
    const tenantIdPattern =
      routeOpts?.tenantIdPattern ??
      this.options?.tenantIdPattern ??
      DEFAULT_TENANT_ID_PATTERN;

    if (requireAuthenticated && !user) {
      throw new UnauthorizedException(
        "Authentication is required for tenant-scoped access",
      );
    }

    const validateFormat = (tenantId: string, sourceLabel: string): string => {
      if (!tenantIdPattern.test(tenantId)) {
        throw new ForbiddenException(
          `Invalid tenant identifier from ${sourceLabel}`,
        );
      }
      return tenantId;
    };

    const userPrimaryTenant = extractUserPrimaryTenant(user, session);

    const extractedBySource = new Map<TenantSource, string>();
    for (const source of sources) {
      let candidate: string | undefined;
      switch (source) {
        case "user":
          candidate = userPrimaryTenant;
          break;
        case "header":
          candidate = readHeader(reqRec, headerName);
          break;
        case "param": {
          const fromCtxParam = readNonEmptyString(reqCtx?.params?.[paramName]);
          const reqParams =
            reqRec?.params && typeof reqRec.params === "object"
              ? (reqRec.params as Record<string, unknown>)
              : undefined;
          candidate =
            fromCtxParam ?? readNonEmptyString(reqParams?.[paramName]);
          break;
        }
        case "subdomain":
          candidate = extractSubdomainTenant(
            reqRec,
            reqCtx,
            paramName,
            baseDomain,
            ignoredSubdomains,
          );
          break;
      }
      if (candidate !== undefined) {
        extractedBySource.set(source, validateFormat(candidate, source));
      }
    }

    // Prevent header/param/subdomain smuggling when multiple untrusted sources disagree
    if (enforceConsistentSources) {
      const requestValues = new Set<string>();
      for (const untrusted of ["header", "param", "subdomain"] as const) {
        const val = extractedBySource.get(untrusted);
        if (val !== undefined) {
          requestValues.add(val);
        }
      }
      if (requestValues.size > 1) {
        throw new ForbiddenException(
          "Conflicting tenant identifiers supplied in request",
        );
      }
    }

    // Resolve active tenant in priority order (custom resolver first when configured)
    let resolvedTenantId: string | undefined;
    if (this.options?.resolveTenant) {
      const custom = readNonEmptyString(
        await this.options.resolveTenant(context, req, user),
      );
      if (custom !== undefined) {
        resolvedTenantId = validateFormat(custom, "custom resolver");
      }
    }
    if (resolvedTenantId === undefined) {
      for (const source of sources) {
        const val = extractedBySource.get(source);
        if (val !== undefined) {
          resolvedTenantId = val;
          break;
        }
      }
    }

    if (!resolvedTenantId) {
      if (!user) {
        throw new UnauthorizedException("Missing tenant context");
      }
      throw new ForbiddenException("Missing tenant context");
    }

    // Enforce cross-tenant spoofing & membership checks when a user is authenticated
    if (user) {
      const customAllowedTenants = this.options?.getUserTenants
        ? await this.options.getUserTenants(user, context)
        : undefined;
      const claimAllowedTenants =
        customAllowedTenants !== undefined
          ? [...customAllowedTenants]
          : extractUserMembershipTenants(user);

      // Build unified allowed tenant set when the user carries explicit bindings
      const hasBoundTenants =
        userPrimaryTenant !== undefined || claimAllowedTenants !== undefined;
      const allowedSet = hasBoundTenants ? new Set<string>() : undefined;
      if (allowedSet) {
        if (userPrimaryTenant !== undefined) {
          allowedSet.add(userPrimaryTenant);
        }
        if (claimAllowedTenants !== undefined) {
          for (const t of claimAllowedTenants) {
            allowedSet.add(t);
          }
        }
      }

      // Check every untrusted request source against the resolved tenant to stop silent spoofing
      for (const untrusted of ["header", "param", "subdomain"] as const) {
        const supplied = extractedBySource.get(untrusted);
        if (supplied !== undefined && supplied !== resolvedTenantId) {
          throw new ForbiddenException(
            `Cross-tenant access denied: ${untrusted} tenant "${supplied}" does not match active tenant "${resolvedTenantId}"`,
          );
        }
      }

      if (this.options?.validateMembership) {
        const isMember = await this.options.validateMembership(
          user,
          resolvedTenantId,
          context,
        );
        if (!isMember) {
          throw new ForbiddenException(
            `Access denied for tenant "${resolvedTenantId}"`,
          );
        }
      } else if (allowedSet !== undefined) {
        if (!allowedSet.has(resolvedTenantId)) {
          throw new ForbiddenException(
            `Cross-tenant access denied: user does not belong to tenant "${resolvedTenantId}"`,
          );
        }
      } else if (requireMembership) {
        throw new ForbiddenException(
          `Tenant membership could not be verified for tenant "${resolvedTenantId}"`,
        );
      }

      // Enforce @TenantRoles(...) strictly scoped to resolvedTenantId
      if (hasRoles && requiredRoles) {
        let tenantRoles: readonly string[];
        if (this.options?.getTenantRoles) {
          tenantRoles =
            (await this.options.getTenantRoles(
              user,
              resolvedTenantId,
              context,
            )) ?? [];
        } else if (
          user.tenantRoles &&
          typeof user.tenantRoles === "object" &&
          !Array.isArray(user.tenantRoles)
        ) {
          const roleMap = user.tenantRoles as Record<string, unknown>;
          tenantRoles = Object.hasOwn(roleMap, resolvedTenantId)
            ? extractRoleStrings(roleMap[resolvedTenantId])
            : [];
        } else if (
          user.orgRoles &&
          typeof user.orgRoles === "object" &&
          !Array.isArray(user.orgRoles)
        ) {
          const roleMap = user.orgRoles as Record<string, unknown>;
          tenantRoles = Object.hasOwn(roleMap, resolvedTenantId)
            ? extractRoleStrings(roleMap[resolvedTenantId])
            : [];
        } else if (
          this.options?.fallbackToUserRoles &&
          userPrimaryTenant === resolvedTenantId
        ) {
          tenantRoles = extractRoleStrings(user.roles ?? user.role);
        } else {
          tenantRoles = [];
        }

        const allowed = requireAllRoles
          ? requiredRoles.every((role) => tenantRoles.includes(role))
          : requiredRoles.some((role) => tenantRoles.includes(role));

        if (!allowed) {
          throw new ForbiddenException(
            `Insufficient tenant role permissions for tenant "${resolvedTenantId}"`,
          );
        }
      }
    }

    // Propagate validated tenantId to request WeakMap, ClsService, and RequestContext
    if (req) {
      setRequestTenant(req, resolvedTenantId);
    }
    if (this.cls?.isActive()) {
      this.cls.set(clsKey, resolvedTenantId);
    } else if (ambientCls.isActive()) {
      ambientCls.set(clsKey, resolvedTenantId);
    }
    if (reqCtx) {
      (reqCtx as unknown as Record<string, unknown>)[clsKey] = resolvedTenantId;
    }

    return true;
  }
}
