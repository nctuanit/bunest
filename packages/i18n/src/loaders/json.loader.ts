import { Logger } from "@bunest/common";
import { type Dirent, watch as fsWatch } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
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
    const root = await realpath(this.options.path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") {
        throw err;
      }
      throw new Error(
        `JsonI18nLoader: the catalog directory ${this.options.path} doesn't exist (ENOENT). ` +
          'When it is in the build output, make sure the catalog files are copied alongside the bundle.',
      );
    });

    for (const entry of await readdir(this.options.path, {
      withFileTypes: true,
    })) {
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
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry.name);
    const kind = await kindOf(entry, full);
    if (kind === "directory") {
      merge(
        tree,
        entry.name,
        await readTree(full, [...ancestors, real]),
        full,
      );
    } else if (kind === "file" && extname(entry.name) === ".json") {
      let content: unknown;
      try {
        content = JSON.parse(await readFile(full, "utf8"));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${full}: ${message}`);
      }
      merge(tree, basename(entry.name, ".json"), content, full);
    }
  }
  return tree;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    return target.isDirectory()
      ? "directory"
      : target.isFile()
        ? "file"
        : undefined;
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
