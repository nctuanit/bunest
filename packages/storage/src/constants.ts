/** The resolved disks (internal). */
export const STORAGE_DISKS: unique symbol = Symbol("STORAGE_DISKS");

/** The options of `forRoot()` (without the top-level disks) or what the `forRootAsync()` factory returned. */
export const STORAGE_MODULE_OPTIONS: unique symbol = Symbol(
  "STORAGE_MODULE_OPTIONS",
);
