import type {
  ResolvedStoreOptions as AnyResolvedStoreOptions,
  StoreOptions as AnyStoreOptions,
} from "../../interfaces/store-options.interface";
import type { StoreReadinessOptions as AnyStoreReadinessOptions } from "../../interfaces/store-readiness.interface";

/**
 * The options every first-party PostgreSQL store takes, which `StoreSchema.resolveOptions()` checks.
 */
export type StoreOptions<D extends "postgres" = "postgres"> =
  AnyStoreOptions<D>;

/**
 * `StoreSchema.resolveOptions()`'s result on PostgreSQL.
 */
export type ResolvedStoreOptions<D extends "postgres" = "postgres"> =
  AnyResolvedStoreOptions<D>;

/**
 * What `StoreSchema.readiness()` takes on PostgreSQL.
 */
export type StoreReadinessOptions<D extends "postgres" = "postgres"> =
  AnyStoreReadinessOptions<D>;
