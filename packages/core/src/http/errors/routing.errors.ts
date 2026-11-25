import type { RouteHttpMethod } from "../../common/index";
import {
  toBunestErrorReport,
  type BunestErrorCode,
  type BunestErrorReport,
} from "../../errors/error-catalog";

function routingErrorToJSON(
  error: Error,
): BunestErrorReport | { name: string; message: string } {
  return toBunestErrorReport(error) ?? { name: error.name, message: error.message };
}

/**
 * Thrown at bootstrap when two controller routes resolve to the same
 * `(httpMethod, canonicalPath, host)` tuple (RFC-001 & ADR-011).
 */
export class DuplicateRouteException extends Error {
  /** Stable AI-actionable error code (see `docs/errors.md`). */
  public readonly code: BunestErrorCode = "BUNEST_E101";
  public readonly method: RouteHttpMethod;
  public readonly path: string;
  public readonly canonicalPath: string;
  public readonly host?: string;
  public readonly version?: string;
  public readonly existingController: string;
  public readonly attemptedController: string;

  constructor(details: {
    method: RouteHttpMethod;
    path: string;
    canonicalPath: string;
    host?: string;
    version?: string;
    existingPath: string;
    existingController: string;
    attemptedController: string;
  }) {
    const hostSuffix = details.host ? ` [host=${details.host}]` : "";
    const versionSuffix = details.version
      ? ` [version=${details.version}]`
      : "";
    super(
      `Duplicate route detected: ${details.method} "${details.path}" (canonical: "${details.canonicalPath}"${hostSuffix}${versionSuffix}) in ${details.attemptedController} collides with "${details.existingPath}" in ${details.existingController}.`,
    );
    this.name = "DuplicateRouteException";
    this.method = details.method;
    this.path = details.path;
    this.canonicalPath = details.canonicalPath;
    this.host = details.host;
    this.version = details.version;
    this.existingController = details.existingController;
    this.attemptedController = details.attemptedController;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): BunestErrorReport | { name: string; message: string } {
    return routingErrorToJSON(this);
  }
}

/**
 * Thrown at bootstrap when a class registered in controllers lacks `@Controller()`.
 */
export class InvalidControllerException extends Error {
  /** Stable AI-actionable error code (see `docs/errors.md`). */
  public readonly code: BunestErrorCode = "BUNEST_E102";
  public readonly controllerName: string;

  constructor(controllerName: string, reason?: string) {
    super(
      reason ??
        `Class "${controllerName}" is registered as a controller but is missing the @Controller() decorator.`,
    );
    this.name = "InvalidControllerException";
    this.controllerName = controllerName;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): BunestErrorReport | { name: string; message: string } {
    return routingErrorToJSON(this);
  }
}

/**
 * Thrown at bootstrap when route metadata or parameter bindings are invalid.
 */
export class InvalidRouteException extends Error {
  /** Stable AI-actionable error code (see `docs/errors.md`). */
  public readonly code: BunestErrorCode = "BUNEST_E103";
  constructor(message: string) {
    super(message);
    this.name = "InvalidRouteException";
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): BunestErrorReport | { name: string; message: string } {
    return routingErrorToJSON(this);
  }
}
