import {
  basename,
  extname,
  isObject,
  isStandaloneExecutable,
  join,
  listEmbeddedFiles,
  Logger,
  readDirEntries,
  realpathOf as realpath,
  statPath as stat,
  ternary,
  watchPath as fsWatch,
  type FsDirent as Dirent,
} from "../../common/index";
import type {
  I18nCatalog,
  I18nCatalogs,
} from "../interfaces/i18n-catalog.interface";
import type { JsonI18nLoaderOptions } from "../interfaces/json-loader-options.interface";
import { I18nLoader } from "./i18n.loader";

/** Quiet period after a file change before the catalogs are re-read. */
const WATCH_DEBOUNCE = 100;

/**
 * Loads `<path>/<locale>/**\/*.json`. Each file becomes a namespace named
 * after the file (`en/users.json` -> `users.*`); sub-directories nest further.
 * A file and a directory of one name merge (`en/users.json` and
 * `en/users/admin.json`), and loading fails on a key that both define.
 * Symbolic links are followed. Hidden entries (names starting with `.`) are
 * skipped: editor lock files, macOS metadata, Kubernetes ConfigMap internals.
 */
export class JsonI18nLoader extends I18nLoader {
  readonly options: Readonly<JsonI18nLoaderOptions>;
  private readonly logger: Logger;

  constructor(options: Readonly<JsonI18nLoaderOptions>) {
    super();
    this.options = options;
    this.logger = new Logger("JsonI18nLoader");
  }

  override async load(): Promise<I18nCatalogs> {
    const catalogs: I18nCatalogs = {};
    let root: string | undefined;
    try {
      root = await realpath(this.options.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
      const embedded =
        this.options.embeddedFiles ??
        (isStandaloneExecutable() ? listEmbeddedFiles() : undefined);
      if (embedded && embedded.length > 0) {
        const result = await loadCatalogsFromEmbedded(
          this.options.path,
          embedded,
        );
        if (result.matchedCount > 0) {
          return result.catalogs;
        }
      }
      throw new Error(
        `JsonI18nLoader: the catalog directory ${this.options.path} doesn't exist (ENOENT). ` +
          "When it is in the build output, make sure the catalog files are copied alongside the bundle.",
      );
    }

    for (const entry of await readDirEntries(this.options.path)) {
      const full = join(this.options.path, entry.name);
      if (
        !entry.name.startsWith(".") &&
        (await kindOf(entry, full)) === "directory"
      ) {
        define(catalogs, entry.name, await readTree(full, [root]));
      }
    }

    return catalogs;
  }

  override watch(onChange: (catalogs: I18nCatalogs) => void): () => void {
    if (!this.options.watch) {
      return () => {};
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    // Serializes reloads: a change during a reload schedules one more pass.
    let running = false;
    let pending = false;

    const reload = async (): Promise<void> => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        const next = await this.load();
        if (!closed) {
          onChange(next);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Keeping the previous translations; reload failed: ${message}`,
        );
      } finally {
        running = false;
      }
      if (pending && !closed) {
        pending = false;
        await reload();
      }
    };

    const watcher = fsWatch(
      this.options.path,
      { recursive: true, persistent: false },
      () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        // Like the watcher, a pending reload doesn't keep the process alive.
        timer = setTimeout(() => void reload(), WATCH_DEBOUNCE);
        timer.unref?.();
      },
    );
    watcher.on("error", (err: Error) =>
      this.logger.error(`Watcher error: ${err.message}`),
    );

    return () => {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      watcher.close();
    };
  }
}

/**
 * Reads a namespace directory. `ancestors` are the real paths of the
 * directories above it, to stop a symbolic link that points back up.
 */
async function readTree(
  dir: string,
  ancestors: readonly string[],
): Promise<I18nCatalog> {
  const real = await realpath(dir);
  if (ancestors.includes(real)) {
    throw new Error(`${dir}: symbolic link cycle`);
  }

  const tree: I18nCatalog = {};
  for (const entry of await readDirEntries(dir)) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry.name);
    const kind = await kindOf(entry, full);
    if (kind === "directory") {
      merge(tree, entry.name, await readTree(full, [...ancestors, real]), full);
    } else if (kind === "file") {
      const ext = extname(entry.name).toLowerCase();
      if (
        ext === ".json" ||
        ext === ".jsonc" ||
        ext === ".json5" ||
        ext === ".yaml" ||
        ext === ".yml" ||
        ext === ".toml"
      ) {
        let content: unknown;
        try {
          const raw = await Bun.file(full).text();
          content = parseCatalogContent(raw, ext);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`${full}: ${message}`);
        }
        merge(tree, basename(entry.name, ext), content, full);
      }
    }
  }
  return tree;
}

function parseCatalogContent(raw: string, ext: string): unknown {
  if (ext === ".json") {
    return JSON.parse(raw);
  }
  if (ext === ".jsonc") {
    return Bun.JSONC.parse(raw);
  }
  if (ext === ".json5") {
    return (
      Bun as unknown as { JSON5: { parse(input: string): unknown } }
    ).JSON5.parse(raw);
  }
  if (ext === ".toml") {
    return Bun.TOML.parse(raw);
  }
  return Bun.YAML.parse(raw);
}

async function loadCatalogsFromEmbedded(
  basePath: string,
  embeddedFiles: readonly Blob[],
): Promise<{ readonly catalogs: I18nCatalogs; readonly matchedCount: number }> {
  const catalogs: I18nCatalogs = {};
  const normalizedBase = basePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0 && s !== ".")
    .join("/");
  const fullPrefix = normalizedBase ? `${normalizedBase}/` : "";
  const baseLeaf = normalizedBase ? basename(normalizedBase) : "";
  const leafPrefix = baseLeaf ? `${baseLeaf}/` : "";

  interface EmbeddedCandidate {
    readonly blob: Blob;
    readonly rawName: string;
    readonly rel: string;
  }

  const fullMatches: EmbeddedCandidate[] = [];
  const leafMatches: EmbeddedCandidate[] = [];

  for (const blob of embeddedFiles) {
    const rawName = (blob as Blob & { name?: string }).name;
    if (typeof rawName !== "string" || rawName.length === 0) continue;
    const rawSegments = rawName.replace(/\\/g, "/").split("/");
    if (rawSegments.includes("..")) continue;
    const normalized = rawSegments
      .filter((s) => s.length > 0 && s !== ".")
      .join("/");
    if (!normalized) continue;

    if (!fullPrefix) {
      fullMatches.push({ blob, rawName, rel: normalized });
    } else if (normalized.startsWith(fullPrefix)) {
      fullMatches.push({
        blob,
        rawName,
        rel: normalized.slice(fullPrefix.length),
      });
    } else if (normalized.includes(`/${fullPrefix}`)) {
      const idx = normalized.indexOf(`/${fullPrefix}`);
      fullMatches.push({
        blob,
        rawName,
        rel: normalized.slice(idx + fullPrefix.length + 1),
      });
    } else if (leafPrefix && normalized.startsWith(leafPrefix)) {
      leafMatches.push({
        blob,
        rawName,
        rel: normalized.slice(leafPrefix.length),
      });
    } else if (leafPrefix && normalized.includes(`/${leafPrefix}`)) {
      const idx = normalized.indexOf(`/${leafPrefix}`);
      leafMatches.push({
        blob,
        rawName,
        rel: normalized.slice(idx + leafPrefix.length + 1),
      });
    }
  }

  const candidates = fullMatches.length > 0 ? fullMatches : leafMatches;
  let matchedCount = 0;

  for (const { blob, rawName, rel } of candidates) {
    const parts = rel.split("/").filter(Boolean);
    if (parts.length < 2) continue;
    if (parts.some((p) => p.startsWith("."))) continue;
    const fileName = parts[parts.length - 1]!;
    const ext = extname(fileName).toLowerCase();
    if (
      ext !== ".json" &&
      ext !== ".jsonc" &&
      ext !== ".json5" &&
      ext !== ".yaml" &&
      ext !== ".yml" &&
      ext !== ".toml"
    ) {
      continue;
    }
    matchedCount++;
    const locale = parts[0]!;
    let content: unknown;
    try {
      const raw = await blob.text();
      content = parseCatalogContent(raw, ext);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${rawName}: ${message}`);
    }
    let current = catalogs[locale] as Record<string, unknown> | undefined;
    if (!current) {
      current = {};
      define(catalogs, locale, current);
    }
    for (let i = 1; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      if (!Object.hasOwn(current, seg)) {
        define(current, seg, {});
      } else if (!isObject(current[seg])) {
        const conflictPath = parts.slice(1, i + 1).join(".");
        throw new Error(
          `${rawName}: ${JSON.stringify(conflictPath)} is defined twice`,
        );
      }
      current = current[seg] as Record<string, unknown>;
    }
    merge(current, basename(fileName, ext), content, rawName);
  }

  return { catalogs, matchedCount };
}

/**
 * Adds a file's or a directory's content to `tree`. Entries come in no fixed
 * order, so neither side may replace the other: objects merge, anything else
 * under one name is an error. `path` is the dotted key, for that error.
 */
function merge(
  tree: Record<string, unknown>,
  key: string,
  value: unknown,
  source: string,
  path = key,
): void {
  if (!Object.hasOwn(tree, key)) {
    define(tree, key, value);
    return;
  }
  const current = tree[key];
  if (!isObject(current) || !isObject(value)) {
    throw new Error(`${source}: ${JSON.stringify(path)} is defined twice`);
  }
  for (const [name, child] of Object.entries(value)) {
    merge(current, name, child, source, `${path}.${name}`);
  }
}

/** What an entry is, following symbolic links. A dangling link is neither. */
async function kindOf(
  entry: Dirent,
  full: string,
): Promise<"directory" | "file" | undefined> {
  if (entry.isDirectory()) {
    return "directory";
  }
  if (entry.isFile()) {
    return "file";
  }
  if (!entry.isSymbolicLink()) {
    return undefined;
  }
  try {
    const target = await stat(full);
    return ternary(target.isDirectory(), "directory" as const)
      .elseIf(target.isFile(), "file" as const)
      .elseEval(undefined);
  } catch {
    return undefined;
  }
}

/** Sets a key even when it's named like an `Object.prototype` accessor (`__proto__`). */
function define(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
