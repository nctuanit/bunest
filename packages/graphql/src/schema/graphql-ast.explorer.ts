import { Injectable } from "@bunest/core";
import {
  type DocumentNode,
  type EnumTypeDefinitionNode,
  type EnumTypeExtensionNode,
  type FieldDefinitionNode,
  type InputObjectTypeDefinitionNode,
  type InputObjectTypeExtensionNode,
  type InputValueDefinitionNode,
  type InterfaceTypeDefinitionNode,
  type InterfaceTypeExtensionNode,
  Kind,
  type ObjectTypeDefinitionNode,
  type ObjectTypeExtensionNode,
  type OperationTypeDefinitionNode,
  type ScalarTypeDefinitionNode,
  type ScalarTypeExtensionNode,
  type TypeNode,
  type TypeSystemDefinitionNode,
  type TypeSystemExtensionNode,
  type UnionTypeDefinitionNode,
  type UnionTypeExtensionNode,
} from "../engine";
import { DEFINITIONS_FILE_HEADER } from "../constants";
import type { DefinitionsGeneratorOptions } from "../interfaces/graphql.interface";
import { FileSystemHelper } from "./file-system.helper";

const ROOT_TYPES = new Set(["Query", "Mutation", "Subscription"]);

export interface GeneratedDefinitionStructure {
  readonly kind: "class" | "interface" | "enum" | "type";
  readonly name: string;
  readonly code: string;
}

export interface GeneratedSourceFile {
  readonly path: string;
  readonly text: string;
  getFullText(): string;
  save(): Promise<void>;
}

/**
 * Zero-dependency GraphQL AST -> TypeScript definitions explorer
 * (uses `graphql`'s built-in AST without `ts-morph`, matching `@nestjs/graphql`
 * `GraphQLAstExplorer`).
 */
@Injectable()
export class GraphQLAstExplorer {
  private readonly fsHelper = new FileSystemHelper();

  async explore(
    documentNode: DocumentNode,
    outputPath: string,
    mode: "class" | "interface",
    options: DefinitionsGeneratorOptions = {},
  ): Promise<GeneratedSourceFile> {
    const enumBlocks: string[] = [];
    const inputBlocks: string[] = [];
    const objectBlocks: string[] = [];
    const rootBlocks: string[] = [];
    const scalarAliasBlocks: string[] = [];
    const otherAliasBlocks: string[] = [];
    const schemaBlocks: string[] = [];

    for (const def of documentNode.definitions) {
      if (def.kind === Kind.SCHEMA_DEFINITION) {
        const s = this.toRootSchemaDefinitionStructure(
          def.operationTypes,
          mode,
        );
        if (s.code) schemaBlocks.push(s.code);
        continue;
      }
      if (
        def.kind === Kind.OBJECT_TYPE_DEFINITION ||
        def.kind === Kind.OBJECT_TYPE_EXTENSION ||
        def.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION ||
        def.kind === Kind.INPUT_OBJECT_TYPE_EXTENSION ||
        def.kind === Kind.INTERFACE_TYPE_DEFINITION ||
        def.kind === Kind.INTERFACE_TYPE_EXTENSION ||
        def.kind === Kind.SCALAR_TYPE_DEFINITION ||
        def.kind === Kind.SCALAR_TYPE_EXTENSION ||
        def.kind === Kind.ENUM_TYPE_DEFINITION ||
        def.kind === Kind.ENUM_TYPE_EXTENSION ||
        def.kind === Kind.UNION_TYPE_DEFINITION ||
        def.kind === Kind.UNION_TYPE_EXTENSION
      ) {
        const s = this.toDefinitionStructures(def, mode, options);
        if (!s.code) continue;
        if (s.kind === "enum") {
          enumBlocks.push(s.code);
        } else if (s.kind === "type") {
          if (
            def.kind === Kind.SCALAR_TYPE_DEFINITION ||
            def.kind === Kind.SCALAR_TYPE_EXTENSION
          ) {
            scalarAliasBlocks.push(s.code);
          } else {
            otherAliasBlocks.push(s.code);
          }
        } else if (
          def.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION ||
          def.kind === Kind.INPUT_OBJECT_TYPE_EXTENSION
        ) {
          inputBlocks.push(s.code);
        } else if (
          (def.kind === Kind.OBJECT_TYPE_DEFINITION ||
            def.kind === Kind.OBJECT_TYPE_EXTENSION) &&
          (def.name.value === "Query" ||
            def.name.value === "Mutation" ||
            def.name.value === "Subscription")
        ) {
          rootBlocks.push(s.code);
        } else {
          objectBlocks.push(s.code);
        }
      }
    }

    const bodySections = [
      ...enumBlocks,
      ...inputBlocks,
      ...schemaBlocks,
      ...objectBlocks,
      ...rootBlocks,
    ];
    const trailingAliases = [
      ...scalarAliasBlocks,
      ...otherAliasBlocks,
      "type Nullable<T> = T | null;",
    ];
    let fullText: string;
    if (bodySections.length === 0) {
      const top = options.additionalHeader
        ? `${DEFINITIONS_FILE_HEADER}\n\n${options.additionalHeader}`
        : DEFINITIONS_FILE_HEADER;
      fullText = `${top}\n${trailingAliases.join("\n")}\n`;
    } else {
      const sections: string[] = [DEFINITIONS_FILE_HEADER];
      if (options.additionalHeader) {
        sections.push(options.additionalHeader);
      }
      sections.push(...bodySections, trailingAliases.join("\n"));
      fullText = `${sections.join("\n\n")}\n`;
    }
    const fsHelper = this.fsHelper;

    return {
      path: outputPath,
      text: fullText,
      getFullText: () => fullText,
      save: async () => {
        await fsHelper.writeFile(outputPath, fullText);
      },
    };
  }

  toDefinitionStructures(
    item: Readonly<TypeSystemDefinitionNode | TypeSystemExtensionNode>,
    mode: "class" | "interface",
    options: DefinitionsGeneratorOptions = {},
  ): GeneratedDefinitionStructure {
    switch (item.kind) {
      case Kind.OBJECT_TYPE_DEFINITION:
      case Kind.OBJECT_TYPE_EXTENSION:
      case Kind.INPUT_OBJECT_TYPE_DEFINITION:
      case Kind.INPUT_OBJECT_TYPE_EXTENSION:
      case Kind.INTERFACE_TYPE_DEFINITION:
      case Kind.INTERFACE_TYPE_EXTENSION:
        return this.toObjectTypeDefinitionStructure(item, mode, options);
      case Kind.SCALAR_TYPE_DEFINITION:
      case Kind.SCALAR_TYPE_EXTENSION:
        return this.toScalarDefinitionStructure(item, options);
      case Kind.ENUM_TYPE_DEFINITION:
      case Kind.ENUM_TYPE_EXTENSION:
        return this.toEnumDefinitionStructure(item, options);
      case Kind.UNION_TYPE_DEFINITION:
      case Kind.UNION_TYPE_EXTENSION:
        return this.toUnionDefinitionStructure(item, options);
      default:
        return { kind: "type", name: "", code: "" };
    }
  }

  toRootSchemaDefinitionStructure(
    operationTypes: ReadonlyArray<OperationTypeDefinitionNode>,
    mode: "class" | "interface",
  ): GeneratedDefinitionStructure {
    const members = operationTypes.map(
      (op) =>
        `    ${op.operation}: ${this.addSymbolIfRoot(op.type.name.value)};`,
    );
    const decl =
      mode === "class" ? "export abstract class" : "export interface";
    return {
      kind: mode,
      name: "ISchema",
      code: `${decl} ISchema {\n${members.join("\n")}\n}`,
    };
  }

  toObjectTypeDefinitionStructure(
    item:
      | ObjectTypeDefinitionNode
      | ObjectTypeExtensionNode
      | InputObjectTypeDefinitionNode
      | InputObjectTypeExtensionNode
      | InterfaceTypeDefinitionNode
      | InterfaceTypeExtensionNode,
    mode: "class" | "interface",
    options: DefinitionsGeneratorOptions = {},
  ): GeneratedDefinitionStructure {
    const rawName = item.name.value;
    const isRootType = this.isRoot(rawName);
    const transformedName = isRootType
      ? this.addSymbolIfRoot(rawName)
      : this.getTransformedTypeName(rawName, options);

    const isInterfaceNode =
      item.kind === Kind.INTERFACE_TYPE_DEFINITION ||
      item.kind === Kind.INTERFACE_TYPE_EXTENSION;
    const isObjectNode =
      item.kind === Kind.OBJECT_TYPE_DEFINITION ||
      item.kind === Kind.OBJECT_TYPE_EXTENSION;

    const lines: string[] = [];
    const doc = this.getDescriptionDocs(
      "description" in item ? item.description?.value : undefined,
      options,
    );
    if (doc) lines.push(doc);

    let keyword = "export interface";
    if (mode === "class") {
      keyword =
        isRootType || isInterfaceNode
          ? "export abstract class"
          : "export class";
    }

    let header = `${keyword} ${transformedName}`;
    if (
      (isObjectNode || isInterfaceNode) &&
      "interfaces" in item &&
      item.interfaces &&
      item.interfaces.length > 0
    ) {
      const ifaceNames = item.interfaces.map((i) =>
        this.getTransformedTypeName(i.name.value, options),
      );
      header +=
        mode === "class"
          ? ` implements ${ifaceNames.join(", ")}`
          : ` extends ${ifaceNames.join(", ")}`;
    }

    const bodyLines: string[] = [];
    if (options.emitTypenameField && isObjectNode) {
      bodyLines.push(`    __typename?: '${rawName}';`);
    }

    const fields = item.fields ?? [];
    for (const field of fields) {
      if (isRootType && !options.skipResolverArgs) {
        const m = this.toMethodDeclarationStructure(field, mode, options);
        bodyLines.push(m.code);
      } else {
        const p = this.toPropertyDeclarationStructure(field, options);
        bodyLines.push(p.code);
      }
    }

    lines.push(`${header} {\n${bodyLines.join("\n")}\n}`);
    return {
      kind: mode,
      name: transformedName,
      code: lines.join("\n"),
    };
  }

  toPropertyDeclarationStructure(
    item: FieldDefinitionNode | InputValueDefinitionNode,
    options: DefinitionsGeneratorOptions = {},
  ): { name: string; type: string; hasQuestionToken: boolean; code: string } {
    const fieldDef = this.getFieldTypeDefinition(item.type, options);
    const hasQuestionToken = !fieldDef.required;
    const typeStr = fieldDef.required
      ? fieldDef.name
      : `Nullable<${fieldDef.name}>`;
    const doc = this.getDescriptionDocs(
      item.description?.value,
      options,
      "    ",
    );
    const propLine = `    ${item.name.value}${hasQuestionToken ? "?" : ""}: ${typeStr};`;
    return {
      name: item.name.value,
      type: typeStr,
      hasQuestionToken,
      code: doc ? `${doc}\n${propLine}` : propLine,
    };
  }

  toMethodDeclarationStructure(
    item: FieldDefinitionNode | InputValueDefinitionNode,
    mode: "class" | "interface",
    options: DefinitionsGeneratorOptions = {},
  ): { name: string; returnType: string; code: string } {
    const fieldDef = this.getFieldTypeDefinition(item.type, options);
    const rawReturn = fieldDef.required
      ? fieldDef.name
      : `Nullable<${fieldDef.name}>`;
    const returnType = `${rawReturn} | Promise<${rawReturn}>`;
    const params =
      item.kind === Kind.FIELD_DEFINITION && item.arguments
        ? this.getFunctionParameters(item.arguments, options)
        : [];
    const paramsStr = params
      .map((p) => `${p.name}${p.hasQuestionToken ? "?" : ""}: ${p.type}`)
      .join(", ");
    const doc = this.getDescriptionDocs(
      item.description?.value,
      options,
      "    ",
    );
    const prefix = mode === "class" ? "    abstract " : "    ";
    const line = `${prefix}${item.name.value}(${paramsStr}): ${returnType};`;
    return {
      name: item.name.value,
      returnType,
      code: doc ? `${doc}\n${line}` : line,
    };
  }

  getFieldTypeDefinition(
    typeNode: TypeNode,
    options: DefinitionsGeneratorOptions = {},
  ): { name: string; required: boolean } {
    const { type, required } = this.unwrapTypeIfNonNull(typeNode);
    if (type.kind === Kind.LIST_TYPE) {
      const inner = this.getFieldTypeDefinition(type.type, options);
      const innerType = inner.required ? inner.name : `Nullable<${inner.name}>`;
      return { name: `${innerType}[]`, required };
    }
    if (type.kind === Kind.NAMED_TYPE) {
      return {
        name: this.getType(type.name.value, options),
        required,
      };
    }
    return { name: "any", required };
  }

  unwrapTypeIfNonNull(type: TypeNode): { type: TypeNode; required: boolean } {
    if (type.kind === Kind.NON_NULL_TYPE) {
      return { type: type.type, required: true };
    }
    return { type, required: false };
  }

  getType(typeName: string, options: DefinitionsGeneratorOptions = {}): string {
    const defaults = this.getDefaultTypes(options);
    if (typeName in defaults) {
      return defaults[typeName]!;
    }
    const customMapping = options.customScalarTypeMapping?.[typeName];
    if (customMapping) {
      return typeof customMapping === "string"
        ? customMapping
        : customMapping.name;
    }
    if (this.isRoot(typeName)) {
      return this.addSymbolIfRoot(typeName);
    }
    return this.getTransformedTypeName(typeName, options);
  }

  getDefaultTypes(
    options: DefinitionsGeneratorOptions = {},
  ): Record<string, string> {
    return {
      String: options.defaultTypeMapping?.String ?? "string",
      Int: options.defaultTypeMapping?.Int ?? "number",
      Boolean: options.defaultTypeMapping?.Boolean ?? "boolean",
      ID: options.defaultTypeMapping?.ID ?? "string",
      Float: options.defaultTypeMapping?.Float ?? "number",
    };
  }

  getFunctionParameters(
    inputs: ReadonlyArray<InputValueDefinitionNode>,
    options: DefinitionsGeneratorOptions = {},
  ): Array<{ name: string; type: string; hasQuestionToken: boolean }> {
    return inputs.map((arg) => {
      const def = this.getFieldTypeDefinition(arg.type, options);
      return {
        name: arg.name.value,
        type: def.required ? def.name : `Nullable<${def.name}>`,
        hasQuestionToken: !def.required,
      };
    });
  }

  toScalarDefinitionStructure(
    item: ScalarTypeDefinitionNode | ScalarTypeExtensionNode,
    options: DefinitionsGeneratorOptions = {},
  ): GeneratedDefinitionStructure {
    const name = this.getTransformedTypeName(item.name.value, options);
    const custom = options.customScalarTypeMapping?.[item.name.value];
    const mapped =
      typeof custom === "string"
        ? custom
        : (custom?.name ?? options.defaultScalarType ?? "any");
    return {
      kind: "type",
      name,
      code: `export type ${name} = ${mapped};`,
    };
  }

  toEnumDefinitionStructure(
    item: EnumTypeDefinitionNode | EnumTypeExtensionNode,
    options: DefinitionsGeneratorOptions = {},
  ): GeneratedDefinitionStructure {
    const name = this.getTransformedTypeName(item.name.value, options);
    const valueNodes = item.values ?? [];
    const values = valueNodes.map((v) => v.name.value);
    const enumDoc =
      item.kind === Kind.ENUM_TYPE_DEFINITION
        ? this.getDescriptionDocs(item.description?.value, options)
        : undefined;
    if (options.enumsAsTypes) {
      const union = values.map((v) => `"${v}"`).join(" | ") || "never";
      const code = `export type ${name} = ${union};`;
      return {
        kind: "type",
        name,
        code: enumDoc ? `${enumDoc}\n${code}` : code,
      };
    }
    const members = valueNodes
      .map((v) => {
        const memberDoc = this.getDescriptionDocs(
          v.description?.value,
          options,
          "    ",
        );
        const line = `    ${v.name.value} = "${v.name.value}"`;
        return memberDoc ? `${memberDoc}\n${line}` : line;
      })
      .join(",\n");
    const code = `export enum ${name} {\n${members}\n}`;
    return {
      kind: "enum",
      name,
      code: enumDoc ? `${enumDoc}\n${code}` : code,
    };
  }

  toUnionDefinitionStructure(
    item: UnionTypeDefinitionNode | UnionTypeExtensionNode,
    options: DefinitionsGeneratorOptions = {},
  ): GeneratedDefinitionStructure {
    const name = this.getTransformedTypeName(item.name.value, options);
    const members = (item.types ?? [])
      .map((t) => this.getTransformedTypeName(t.name.value, options))
      .join(" | ");
    return {
      kind: "type",
      name,
      code: `export type ${name} = ${members || "never"};`,
    };
  }

  addSymbolIfRoot(name: string): string {
    return this.isRoot(name) ? `I${name}` : name;
  }

  isRoot(name: string): boolean {
    return ROOT_TYPES.has(name);
  }

  private getTransformedTypeName(
    name: string,
    options: DefinitionsGeneratorOptions,
  ): string {
    return options.typeName ? options.typeName(name) : name;
  }

  private getDescriptionDocs(
    description: string | undefined,
    options: DefinitionsGeneratorOptions,
    indent = "",
  ): string | undefined {
    if (!options.emitDescriptions || !description) {
      return undefined;
    }
    const sanitized = description.replace(/\*\//g, "*\\/");
    return `${indent}/** ${sanitized} */`;
  }
}
