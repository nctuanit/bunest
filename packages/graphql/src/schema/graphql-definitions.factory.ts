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
    const combinedSdl = [loadedFromPaths, inlineSdl]
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
