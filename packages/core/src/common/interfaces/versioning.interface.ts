import type { VERSION_NEUTRAL, VersioningType } from "../enums/versioning.enum";

export type VersionValue =
  string | typeof VERSION_NEUTRAL | Array<string | typeof VERSION_NEUTRAL>;

export interface VersioningCommonOptions {
  /**
   * Default API version applied to routes/controllers that do not declare `@Version()`.
   */
  defaultVersion?: VersionValue;
}

export interface UriVersioningOptions extends VersioningCommonOptions {
  type: VersioningType.URI;
  /**
   * Prefix prepended to the URI version segment (defaults to `"v"`, e.g. `/v1/users`).
   * Set to `false` to omit any prefix (e.g. `/1/users`).
   */
  prefix?: string | false;
}

export interface HeaderVersioningOptions extends VersioningCommonOptions {
  type: VersioningType.HEADER;
  /**
   * Request header name containing the desired API version (e.g. `"X-API-Version"`).
   */
  header: string;
}

export interface MediaTypeVersioningOptions extends VersioningCommonOptions {
  type: VersioningType.MEDIA_TYPE;
  /**
   * Key inside the `Accept` header media type parameters (e.g. `"v="` -> `Accept: application/json;v=1`).
   */
  key: string;
}

export interface CustomVersioningOptions extends VersioningCommonOptions {
  type: VersioningType.CUSTOM;
  /**
   * Custom version extractor invoked per request.
   */
  extractor: (request: Request) => string | string[];
}

export type VersioningOptions =
  | UriVersioningOptions
  | HeaderVersioningOptions
  | MediaTypeVersioningOptions
  | CustomVersioningOptions;
