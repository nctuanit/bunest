import type { RouteHttpMethod } from "../../common/index";

/**
 * Thrown at bootstrap when two controller routes resolve to the same
 * `(httpMethod, canonicalPath, host)` tuple (RFC-001 & ADR-011).
 */
export class DuplicateRouteException extends Error {
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
}

/**
 * Thrown at bootstrap when a class registered in controllers lacks `@Controller()`.
 */
export class InvalidControllerException extends Error {
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
}

/**
 * Thrown at bootstrap when route metadata or parameter bindings are invalid.
 */
export class InvalidRouteException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRouteException";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
