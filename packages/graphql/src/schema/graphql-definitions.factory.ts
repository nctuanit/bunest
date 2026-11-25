import { parse } from "../engine";
import type {
  DefinitionsGeneratorOptions,
  GenerateOptions,
} from "../interfaces/graphql.interface";
import { GraphQLAstExplorer } from "./graphql-ast.explorer";
import { GraphQLTypesLoader } from "./graphql-types.loader";

/**
 * Generates TypeScript `interface` or `class` definitions from GraphQL SDL
 * files (`typePaths`) or inline `typeDefs` (matching `@nestjs/graphql`
 * `GraphQLDefinitionsFactory`).
 */
export class GraphQLDefinitionsFactory {
  protected readonly gqlAstExplorer = new GraphQLAstExplorer();
  protected readonly gqlTypesLoader = new GraphQLTypesLoader();

  async generate(options: GenerateOptions): Promise<void> {
    const {
      typePaths = [],
      path: outputPath,
      outputAs = "interface",
      debug = false,
      watch = false,
      typeDefs,
      ...generatorOptions
    } = options;

    await this.exploreAndEmit(
      typePaths,
      outputPath,
      outputAs,
      debug,
      generatorOptions,
      typeDefs,
    );

    if (watch && typePaths.length > 0) {
      const snapshot = new Map<string, string>();
      const captureSnapshot = async (): Promise<{
        changed: boolean;
        anyExists: boolean;
      }> => {
        let files: string[] = [];
        try {
          files = await this.gqlTypesLoader.getTypesFromPaths(typePaths);
        } catch {
          return { changed: false, anyExists: false };
        }
        if (files.length === 0) {
          return { changed: false, anyExists: false };
        }
        let changed = false;
        const currentKeys = new Set(files);
        for (const existing of snapshot.keys()) {
          if (!currentKeys.has(existing)) {
            snapshot.delete(existing);
            changed = true;
          }
        }
        for (const file of files) {
          try {
            const text = await Bun.file(file).text();
            if (snapshot.get(file) !== text) {
              snapshot.set(file, text);
              changed = true;
            }
          } catch {
            // File disappeared mid-poll
          }
        }
        return { changed, anyExists: true };
      };

      await captureSnapshot();

      let running = false;
      const timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
          const { changed, anyExists } = await captureSnapshot();
          if (!anyExists) {
            clearInterval(timer);
            return;
          }
          if (changed) {
            await this.exploreAndEmit(
              typePaths,
              outputPath,
              outputAs,
              debug,
              generatorOptions,
              typeDefs,
            );
          }
        } catch {
          // Ignore transient watch errors
        } finally {
          running = false;
        }
      }, 30);
      timer.unref?.();
    }
  }

  protected async exploreAndEmit(
    typePaths: string[],
    outputPath: string,
    outputAs: "class" | "interface",
    isDebugEnabled: boolean,
    definitionsGeneratorOptions: DefinitionsGeneratorOptions,
    typeDefs?: string | string[],
  ): Promise<void> {
    const loadedFromPaths =
      typePaths.length > 0
        ? await this.gqlTypesLoader.mergeTypesByPaths(typePaths)
        : "";
    const inlineSdl = Array.isArray(typeDefs)
      ? typeDefs.join("\n")
      : (typeDefs ?? "");
    const combinedSdl = [inlineSdl, loadedFromPaths]
      .filter((part) => part.trim().length > 0)
      .join("\n");

    if (!combinedSdl.trim()) {
      this.printMessage("No GraphQL type definitions found.", isDebugEnabled);
      return;
    }

    const ast = parse(combinedSdl);
    const sourceFile = await this.gqlAstExplorer.explore(
      ast,
      outputPath,
      outputAs,
      definitionsGeneratorOptions,
    );
    await sourceFile.save();
    this.printMessage(
      `Generated GraphQL TypeScript definitions at ${outputPath}`,
      isDebugEnabled,
    );
  }

  protected printMessage(text: string, isEnabled: boolean): void {
    if (isEnabled) {
      // eslint-disable-next-line no-console
      console.log(text);
    }
  }
}
