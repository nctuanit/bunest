import { type DefinitionNode, Kind, parse } from "../engine";
import type { DefinitionsGeneratorOptions } from "../interfaces/graphql.interface";
import { GraphQLDefinitionsFactory } from "./graphql-definitions.factory";

const FEDERATION_INTERNAL_TYPES = new Set([
  "_Any",
  "_Entity",
  "_FieldSet",
  "_Service",
  "FieldSet",
  "link__Import",
  "link__Purpose",
]);

/**
 * Federated SDL -> TypeScript definitions generator matching `@nestjs/graphql`
 * `GraphQLFederationDefinitionsFactory`. Omits internal Apollo Federation types
 * (`_Any`, `_Entity`, `_Service`, etc.) from generated user definitions.
 */
export class GraphQLFederationDefinitionsFactory extends GraphQLDefinitionsFactory {
  protected override async exploreAndEmit(
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
      this.printMessage(
        "No federated GraphQL type definitions found.",
        isDebugEnabled,
      );
      return;
    }

    const ast = parse(combinedSdl);
    const filteredAst = {
      ...ast,
      definitions: ast.definitions.filter(
        (def) => !this.isFederationInternalDefinition(def),
      ),
    };

    const sourceFile = await this.gqlAstExplorer.explore(
      filteredAst,
      outputPath,
      outputAs,
      definitionsGeneratorOptions,
    );
    await sourceFile.save();
    this.printMessage(
      `Generated federated GraphQL TypeScript definitions at ${outputPath}`,
      isDebugEnabled,
    );
  }

  private isFederationInternalDefinition(def: DefinitionNode): boolean {
    if ("name" in def && def.name?.value) {
      return FEDERATION_INTERNAL_TYPES.has(def.name.value);
    }
    return def.kind === Kind.DIRECTIVE_DEFINITION && def.name.value === "link";
  }
}
