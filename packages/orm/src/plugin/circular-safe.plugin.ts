import type { BunPlugin } from "bun";

export interface OrmCircularSafePluginOptions {
  /**
   * File path regex filter to apply the TDZ-safe metadata transform to.
   * Defaults to all `.ts` / `.tsx` files outside `node_modules`.
   */
  readonly filter?: RegExp;
  /**
   * Path regex to exclude (defaults to `/node_modules/`).
   */
  readonly exclude?: RegExp;
  /**
   * Custom tsconfig compilerOptions passed to `Bun.Transpiler`.
   */
  readonly tsconfig?: Record<string, unknown>;
}

const DEFAULT_FILTER = /\.tsx?$/;
const DEFAULT_EXCLUDE = /(?:^|[/\\])node_modules[/\\]/;

/**
 * Pattern emitted by Bun's legacy TypeScript decorator metadata transpiler:
 * `typeof TargetClass === "undefined" ? Object : TargetClass`
 *
 * In ESM/Bun, evaluating `typeof TargetClass` while `TargetClass` is in the
 * Temporal Dead Zone (circular ESM import or forward same-file class declaration)
 * throws `ReferenceError: Cannot access 'TargetClass' before initialization`.
 *
 * Wrapping the expression in a `try { ... } catch { return Object; }` IIFE preserves
 * exact `design:type` / `design:paramtypes` metadata for all initialized classes while
 * eliminating TDZ crashes completely for circular / forward-referenced nested classes!
 */
const TDZ_METADATA_PATTERN =
  /typeof\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*===\s*"undefined"\s*\?\s*Object\s*:\s*\1\b/g;

/**
 * Rewrites Bun-transpiled legacy decorator metadata expressions to be 100% TDZ-safe.
 */
export function transformCircularMetadataJs(jsCode: string): string {
  if (
    !jsCode.includes("__legacyMetadataTS") &&
    !jsCode.includes("design:type") &&
    !jsCode.includes("design:paramtypes") &&
    !jsCode.includes("design:returntype")
  ) {
    return jsCode;
  }

  return jsCode.replace(
    TDZ_METADATA_PATTERN,
    (match, ident: string, offset: number, full: string) => {
      // Idempotency: do not double-wrap expressions already guarded inside our TDZ IIFE.
      const before = full.slice(Math.max(0, offset - 32), offset);
      if (/try\s*\{\s*return\s+$/.test(before)) {
        return match;
      }
      return `(() => { try { return typeof ${ident} === "undefined" ? Object : ${ident}; } catch { return Object; } })()`;
    },
  );
}

/**
 * Transpiles a TypeScript source file with `experimentalDecorators` + `emitDecoratorMetadata`
 * and rewrites all emitted `design:*` metadata references to be TDZ-safe.
 */
export function transformCircularMetadataSource(
  tsSource: string,
  loader: "ts" | "tsx" = "ts",
  tsconfig?: Record<string, unknown>,
): string {
  const transpiler = new Bun.Transpiler({
    loader,
    tsconfig: JSON.stringify(
      tsconfig ?? {
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          verbatimModuleSyntax: true,
        },
      },
    ),
  });
  const js = transpiler.transformSync(tsSource);
  return transformCircularMetadataJs(js);
}

/**
 * Creates a Bun runtime / bundler plugin (`BunPlugin`) that eliminates ESM circular
 * import & same-file forward-class TDZ `ReferenceError` crashes caused by
 * `emitDecoratorMetadata` — even on plain TypeORM-style circular entity classes
 * (`import { Post } from "./post"; post!: Post;`).
 *
 * Usage in `bunfig.toml`:
 * ```toml
 * preload = ["./orm-preload.ts"]
 * ```
 * Where `orm-preload.ts` calls `registerOrmCircularSafePlugin()`.
 */
export function createOrmCircularSafePlugin(
  options: OrmCircularSafePluginOptions = {},
): BunPlugin {
  const filter = options.filter ?? DEFAULT_FILTER;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;

  const tsTranspiler = new Bun.Transpiler({
    loader: "ts",
    tsconfig: JSON.stringify(
      options.tsconfig ?? {
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          verbatimModuleSyntax: true,
        },
      },
    ),
  });

  const tsxTranspiler = new Bun.Transpiler({
    loader: "tsx",
    tsconfig: JSON.stringify(
      options.tsconfig ?? {
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          verbatimModuleSyntax: true,
        },
      },
    ),
  });

  return {
    name: "bunest-orm-circular-safe",
    setup(build) {
      const buildConfig = (
        build as unknown as {
          readonly config?: { readonly entrypoints?: readonly unknown[] };
        }
      ).config;
      const isBuildMode = Boolean(
        buildConfig?.entrypoints && buildConfig.entrypoints.length > 0,
      );
      build.onLoad({ filter }, async (args) => {
        const defaultLoader: "ts" | "tsx" = args.path.endsWith(".tsx")
          ? "tsx"
          : "ts";
        if (exclude.test(args.path)) {
          if (isBuildMode) return undefined;
          return {
            contents: await Bun.file(args.path).text(),
            loader: defaultLoader,
          };
        }
        const source = await Bun.file(args.path).text();
        // Fast skip: files without decorators have zero metadata TDZ risk
        if (!source.includes("@")) {
          if (isBuildMode) return undefined;
          return { contents: source, loader: defaultLoader };
        }
        const transpiler = args.path.endsWith(".tsx")
          ? tsxTranspiler
          : tsTranspiler;
        const js = transpiler.transformSync(source);
        const safeJs = transformCircularMetadataJs(js);
        return {
          contents: safeJs,
          loader: "js",
        };
      });
    },
  };
}

/**
 * Registers the TDZ-safe circular metadata plugin globally via `Bun.plugin(...)`.
 * Call once in your `bunfig.toml` preload script or entrypoint before importing entities.
 */
export function registerOrmCircularSafePlugin(
  options: OrmCircularSafePluginOptions = {},
): void {
  Bun.plugin(createOrmCircularSafePlugin(options));
}
