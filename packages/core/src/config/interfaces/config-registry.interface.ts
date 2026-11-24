/**
 * config-registry.interface.ts
 *
 * Module Augmentation target for `@bunest/core/config`.
 * Automatically populated by `bunest dev` / `bunest typegen` from `registerAs(...)`
 * factories and `.env` / `.env.example` files.
 *
 * @example
 * ```ts
 * // Auto-generated in `.bunest/types/bunest.d.ts`:
 * declare module "@bunest/core/config" {
 *   interface BunestConfigRegistry {
 *     PORT: string;
 *     database: ConfigType<typeof databaseConfig>;
 *   }
 * }
 * ```
 */

import type { Path, PathValue } from "../types/path.types";

/**
 * Global configuration schema registry.
 * Augment via `declare module "@bunest/core/config"` (or run `bunest dev` / `bunest typegen`).
 */
export interface BunestConfigRegistry {}

/**
 * Evaluates to `BunestConfigRegistry` once augmented, or falls back to
 * `Record<string, unknown>` when unaugmented for 100% backward compatibility.
 */
export type DefaultConfigSchema = [keyof BunestConfigRegistry] extends [never]
  ? Record<string, unknown>
  : BunestConfigRegistry;

/**
 * Evaluates to `true` when `K` is a concrete schema (not empty and not an open index signature).
 */
export type HasConcreteConfigSchema<K> = keyof K extends never
  ? false
  : string extends keyof K
    ? false
    : true;

/** Union of all registered config dot-paths (or `never` when unaugmented). */
export type RegisteredConfigPath = [keyof BunestConfigRegistry] extends [never]
  ? never
  : Path<BunestConfigRegistry> & string;

/** Autocomplete-friendly config key/path input. */
export type ConfigPathInput = [RegisteredConfigPath] extends [never]
  ? string
  : RegisteredConfigPath | (string & {});

/** Resolve the value type at a registered config path `P`. */
export type RegisteredConfigValue<P extends Path<BunestConfigRegistry>> =
  PathValue<BunestConfigRegistry, P>;
