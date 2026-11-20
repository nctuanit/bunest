/**
 * Supported HTTP API versioning strategies.
 */
export enum VersioningType {
  URI = "uri",
  HEADER = "header",
  MEDIA_TYPE = "media_type",
  CUSTOM = "custom",
}

/**
 * Sentinel marking a controller or route as version-neutral (accessible
 * regardless of the requested API version).
 */
export const VERSION_NEUTRAL = Symbol.for("bunest:version_neutral");
