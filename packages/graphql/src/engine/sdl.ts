/**
 * GraphQL October 2021 Spec SDL Engine:
 * `buildASTSchema`, `buildSchema`, `printSchema`, `printType`, `lexicographicSortSchema`.
 * Supports full type definitions, type extensions, federation directives, `@deprecated`,
 * `@specifiedBy`, `@oneOf`, and exact SDL formatting.
 * Zero external dependencies.
 */

import {
  type ConstDirectiveNode,
  type DirectiveDefinitionNode,
  type DirectiveLocationEnum,
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
  type NamedTypeNode,
  type ObjectTypeDefinitionNode,
  type ObjectTypeExtensionNode,
  OperationTypeNode,
  type ScalarTypeDefinitionNode,
  type ScalarTypeExtensionNode,
  type SchemaDefinitionNode,
  type SchemaExtensionNode,
  type Source,
  type TypeNode,
  type UnionTypeDefinitionNode,
  type UnionTypeExtensionNode,
} from "./ast";
import { GraphQLError } from "./error";
import { isIntrospectionType } from "./introspection";
import { parse, type ParseOptions } from "./parser";
import { print, printBlockString, printString } from "./printer";
import {
  GraphQLScalarType,
  isSpecifiedScalarType,
  type Maybe,
  specifiedScalarTypes,
} from "./scalars";
import { GraphQLSchema } from "./schema";
import {
  astFromValue,
  DEFAULT_DEPRECATION_REASON,
  type GraphQLArgument,
  type GraphQLArgumentConfig,
  GraphQLDirective,
  GraphQLEnumType,
  type GraphQLEnumValueConfigMap,
  type GraphQLField,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLFieldConfigMap,
  type GraphQLInputField,
  type GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInterfaceType,
  GraphQLList,
  type GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLType,
  GraphQLUnionType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isSpecifiedDirective,
  isUnionType,
  specifiedDirectives,
  valueFromAST,
} from "./types";

export interface BuildSchemaOptions extends ParseOptions {
  readonly assumeValid?: boolean;
  readonly assumeValidSDL?: boolean;
}

function getDeprecationReason(
  directives: Maybe<readonly ConstDirectiveNode[]>,
): string | undefined {
  if (!directives) return undefined;
  const deprecated = directives.find((d) => d.name.value === "deprecated");
  if (!deprecated) return undefined;
  const reasonArg = deprecated.arguments?.find(
    (a) => a.name.value === "reason",
  );
  if (reasonArg && reasonArg.value.kind === Kind.STRING) {
    return reasonArg.value.value;
  }
  return DEFAULT_DEPRECATION_REASON;
}

function getSpecifiedByURL(
  directives: Maybe<readonly ConstDirectiveNode[]>,
): string | undefined {
  if (!directives) return undefined;
  const dir = directives.find((d) => d.name.value === "specifiedBy");
  if (!dir) return undefined;
  const urlArg = dir.arguments?.find((a) => a.name.value === "url");
  if (urlArg && urlArg.value.kind === Kind.STRING) {
    return urlArg.value.value;
  }
  return undefined;
}

function hasOneOfDirective(
  directives: Maybe<readonly ConstDirectiveNode[]>,
): boolean {
  return Boolean(directives?.some((d) => d.name.value === "oneOf"));
}

/**
 * Builds an executable `GraphQLSchema` from a parsed SDL `DocumentNode`,
 * handling all type definitions, type extensions (`extend type/interface/union/enum/input/scalar/schema`),
 * directives, default values, `@deprecated`, `@specifiedBy`, and `@oneOf`.
 */
export function buildASTSchema(
  documentAST: DocumentNode,
  _options?: BuildSchemaOptions,
): GraphQLSchema {
  if (!documentAST || documentAST.kind !== Kind.DOCUMENT) {
    throw new Error("Must provide valid Document AST.");
  }

  let schemaDef: SchemaDefinitionNode | undefined;
  const schemaExtensions: SchemaExtensionNode[] = [];

  const scalarDefs = new Map<string, ScalarTypeDefinitionNode>();
  const scalarExts = new Map<string, ScalarTypeExtensionNode[]>();
  const objectDefs = new Map<string, ObjectTypeDefinitionNode>();
  const objectExts = new Map<string, ObjectTypeExtensionNode[]>();
  const interfaceDefs = new Map<string, InterfaceTypeDefinitionNode>();
  const interfaceExts = new Map<string, InterfaceTypeExtensionNode[]>();
  const unionDefs = new Map<string, UnionTypeDefinitionNode>();
  const unionExts = new Map<string, UnionTypeExtensionNode[]>();
  const enumDefs = new Map<string, EnumTypeDefinitionNode>();
  const enumExts = new Map<string, EnumTypeExtensionNode[]>();
  const inputDefs = new Map<string, InputObjectTypeDefinitionNode>();
  const inputExts = new Map<string, InputObjectTypeExtensionNode[]>();
  const directiveDefs: DirectiveDefinitionNode[] = [];

  const typeOrder: string[] = [];
  const registerOrder = (name: string) => {
    if (!typeOrder.includes(name)) {
      typeOrder.push(name);
    }
  };

  for (const def of documentAST.definitions) {
    switch (def.kind) {
      case Kind.SCHEMA_DEFINITION:
        schemaDef = def;
        break;
      case Kind.SCHEMA_EXTENSION:
        schemaExtensions.push(def);
        break;
      case Kind.SCALAR_TYPE_DEFINITION:
        scalarDefs.set(def.name.value, def);
        registerOrder(def.name.value);
        break;
      case Kind.SCALAR_TYPE_EXTENSION: {
        const list = scalarExts.get(def.name.value) ?? [];
        list.push(def);
        scalarExts.set(def.name.value, list);
        registerOrder(def.name.value);
        break;
      }
      case Kind.OBJECT_TYPE_DEFINITION:
        objectDefs.set(def.name.value, def);
        registerOrder(def.name.value);
        break;
      case Kind.OBJECT_TYPE_EXTENSION: {
        const list = objectExts.get(def.name.value) ?? [];
        list.push(def);
        objectExts.set(def.name.value, list);
        registerOrder(def.name.value);
        break;
      }
      case Kind.INTERFACE_TYPE_DEFINITION:
        interfaceDefs.set(def.name.value, def);
        registerOrder(def.name.value);
        break;
      case Kind.INTERFACE_TYPE_EXTENSION: {
        const list = interfaceExts.get(def.name.value) ?? [];
        list.push(def);
        interfaceExts.set(def.name.value, list);
        registerOrder(def.name.value);
        break;
      }
      case Kind.UNION_TYPE_DEFINITION:
        unionDefs.set(def.name.value, def);
        registerOrder(def.name.value);
        break;
      case Kind.UNION_TYPE_EXTENSION: {
        const list = unionExts.get(def.name.value) ?? [];
        list.push(def);
        unionExts.set(def.name.value, list);
        registerOrder(def.name.value);
        break;
      }
      case Kind.ENUM_TYPE_DEFINITION:
        enumDefs.set(def.name.value, def);
        registerOrder(def.name.value);
        break;
      case Kind.ENUM_TYPE_EXTENSION: {
        const list = enumExts.get(def.name.value) ?? [];
        list.push(def);
        enumExts.set(def.name.value, list);
        registerOrder(def.name.value);
        break;
      }
      case Kind.INPUT_OBJECT_TYPE_DEFINITION:
        inputDefs.set(def.name.value, def);
        registerOrder(def.name.value);
        break;
      case Kind.INPUT_OBJECT_TYPE_EXTENSION: {
        const list = inputExts.get(def.name.value) ?? [];
        list.push(def);
        inputExts.set(def.name.value, list);
        registerOrder(def.name.value);
        break;
      }
      case Kind.DIRECTIVE_DEFINITION:
        directiveDefs.push(def);
        break;
    }
  }

  const builtTypes = new Map<string, GraphQLNamedType>();
  for (const scalar of specifiedScalarTypes) {
    builtTypes.set(scalar.name, scalar);
  }

  const getNamedTypeByName = (name: string): GraphQLNamedType => {
    const found = builtTypes.get(name);
    if (!found) {
      throw new GraphQLError(`Unknown type "${name}".`);
    }
    return found;
  };

  const buildWrappedType = (typeNode: TypeNode): GraphQLType => {
    if (typeNode.kind === Kind.LIST_TYPE) {
      return new GraphQLList(buildWrappedType(typeNode.type));
    }
    if (typeNode.kind === Kind.NON_NULL_TYPE) {
      return new GraphQLNonNull(buildWrappedType(typeNode.type));
    }
    return getNamedTypeByName(typeNode.name.value);
  };

  const buildArgMap = (
    args: readonly InputValueDefinitionNode[] | undefined,
  ): GraphQLFieldConfigArgumentMap => {
    const map: GraphQLFieldConfigArgumentMap = Object.create(null);
    for (const arg of args ?? []) {
      const argType = buildWrappedType(arg.type) as GraphQLInputType;
      map[arg.name.value] = {
        description: arg.description?.value,
        type: argType,
        defaultValue: arg.defaultValue
          ? valueFromAST(arg.defaultValue, argType)
          : undefined,
        deprecationReason: getDeprecationReason(arg.directives),
        astNode: arg,
      };
    }
    return map;
  };

  const buildFieldMap = (
    fields: readonly FieldDefinitionNode[],
  ): GraphQLFieldConfigMap<any, any> => {
    const map: GraphQLFieldConfigMap<any, any> = Object.create(null);
    for (const field of fields) {
      map[field.name.value] = {
        description: field.description?.value,
        type: buildWrappedType(field.type) as GraphQLOutputType,
        args: buildArgMap(field.arguments),
        deprecationReason: getDeprecationReason(field.directives),
        astNode: field,
      };
    }
    return map;
  };

  const buildInterfaces = (
    nodes: readonly NamedTypeNode[],
  ): GraphQLInterfaceType[] => {
    const seen = new Set<string>();
    const result: GraphQLInterfaceType[] = [];
    for (const n of nodes) {
      if (seen.has(n.name.value)) continue;
      seen.add(n.name.value);
      const t = getNamedTypeByName(n.name.value);
      if (!isInterfaceType(t)) {
        throw new GraphQLError(
          `Expected "${n.name.value}" to be an Interface type.`,
        );
      }
      result.push(t);
    }
    return result;
  };

  // Create all named type instances first (using lazy thunks for cyclic references)
  for (const name of typeOrder) {
    if (scalarDefs.has(name) || scalarExts.has(name)) {
      const def = scalarDefs.get(name);
      const exts = scalarExts.get(name) ?? [];
      if (def || !builtTypes.has(name)) {
        const allDirs = [
          ...(def?.directives ?? []),
          ...exts.flatMap((e) => e.directives ?? []),
        ];
        builtTypes.set(
          name,
          new GraphQLScalarType({
            name,
            description: def?.description?.value,
            specifiedByURL: getSpecifiedByURL(allDirs),
            astNode: def,
            extensionASTNodes: exts,
          }),
        );
      }
      continue;
    }

    if (enumDefs.has(name) || enumExts.has(name)) {
      const def = enumDefs.get(name);
      const exts = enumExts.get(name) ?? [];
      const allValueNodes = [
        ...(def?.values ?? []),
        ...exts.flatMap((e) => e.values ?? []),
      ];
      const values: GraphQLEnumValueConfigMap = Object.create(null);
      for (const v of allValueNodes) {
        values[v.name.value] = {
          description: v.description?.value,
          deprecationReason: getDeprecationReason(v.directives),
          astNode: v,
        };
      }
      builtTypes.set(
        name,
        new GraphQLEnumType({
          name,
          description: def?.description?.value,
          values,
          astNode: def,
          extensionASTNodes: exts,
        }),
      );
      continue;
    }

    if (objectDefs.has(name) || objectExts.has(name)) {
      const def = objectDefs.get(name);
      const exts = objectExts.get(name) ?? [];
      const allIfaces = [
        ...(def?.interfaces ?? []),
        ...exts.flatMap((e) => e.interfaces ?? []),
      ];
      const allFields = [
        ...(def?.fields ?? []),
        ...exts.flatMap((e) => e.fields ?? []),
      ];
      builtTypes.set(
        name,
        new GraphQLObjectType({
          name,
          description: def?.description?.value,
          interfaces: () => buildInterfaces(allIfaces),
          fields: () => buildFieldMap(allFields),
          astNode: def,
          extensionASTNodes: exts,
        }),
      );
      continue;
    }

    if (interfaceDefs.has(name) || interfaceExts.has(name)) {
      const def = interfaceDefs.get(name);
      const exts = interfaceExts.get(name) ?? [];
      const allIfaces = [
        ...(def?.interfaces ?? []),
        ...exts.flatMap((e) => e.interfaces ?? []),
      ];
      const allFields = [
        ...(def?.fields ?? []),
        ...exts.flatMap((e) => e.fields ?? []),
      ];
      builtTypes.set(
        name,
        new GraphQLInterfaceType({
          name,
          description: def?.description?.value,
          interfaces: () => buildInterfaces(allIfaces),
          fields: () => buildFieldMap(allFields),
          astNode: def,
          extensionASTNodes: exts,
        }),
      );
      continue;
    }

    if (unionDefs.has(name) || unionExts.has(name)) {
      const def = unionDefs.get(name);
      const exts = unionExts.get(name) ?? [];
      const allMembers = [
        ...(def?.types ?? []),
        ...exts.flatMap((e) => e.types ?? []),
      ];
      builtTypes.set(
        name,
        new GraphQLUnionType({
          name,
          description: def?.description?.value,
          types: () => {
            const seen = new Set<string>();
            const members: GraphQLObjectType[] = [];
            for (const m of allMembers) {
              if (seen.has(m.name.value)) continue;
              seen.add(m.name.value);
              const t = getNamedTypeByName(m.name.value);
              if (!isObjectType(t)) {
                throw new GraphQLError(
                  `Union member "${m.name.value}" must be an Object type.`,
                );
              }
              members.push(t);
            }
            return members;
          },
          astNode: def,
          extensionASTNodes: exts,
        }),
      );
      continue;
    }

    if (inputDefs.has(name) || inputExts.has(name)) {
      const def = inputDefs.get(name);
      const exts = inputExts.get(name) ?? [];
      const allDirs = [
        ...(def?.directives ?? []),
        ...exts.flatMap((e) => e.directives ?? []),
      ];
      const allFields = [
        ...(def?.fields ?? []),
        ...exts.flatMap((e) => e.fields ?? []),
      ];
      builtTypes.set(
        name,
        new GraphQLInputObjectType({
          name,
          description: def?.description?.value,
          isOneOf: hasOneOfDirective(allDirs),
          fields: () => {
            const map: GraphQLInputFieldConfigMap = Object.create(null);
            for (const f of allFields) {
              const fieldType = buildWrappedType(f.type) as GraphQLInputType;
              map[f.name.value] = {
                description: f.description?.value,
                type: fieldType,
                defaultValue: f.defaultValue
                  ? valueFromAST(f.defaultValue, fieldType)
                  : undefined,
                deprecationReason: getDeprecationReason(f.directives),
                astNode: f,
              };
            }
            return map;
          },
          astNode: def,
          extensionASTNodes: exts,
        }),
      );
    }
  }

  // Directives: user-defined + specified directives not overridden
  const builtDirectives: GraphQLDirective[] = directiveDefs.map(
    (d) =>
      new GraphQLDirective({
        name: d.name.value,
        description: d.description?.value,
        locations: d.locations.map(
          (l) => l.value as DirectiveLocationEnum,
        ),
        args: buildArgMap(d.arguments),
        isRepeatable: d.repeatable,
        astNode: d,
      }),
  );
  for (const specDir of specifiedDirectives) {
    if (!builtDirectives.some((d) => d.name === specDir.name)) {
      builtDirectives.push(specDir);
    }
  }

  // Operation root types
  let queryTypeName: string | undefined;
  let mutationTypeName: string | undefined;
  let subscriptionTypeName: string | undefined;

  if (schemaDef || schemaExtensions.length > 0) {
    const opTypes = [
      ...(schemaDef?.operationTypes ?? []),
      ...schemaExtensions.flatMap((e) => e.operationTypes ?? []),
    ];
    for (const op of opTypes) {
      if (op.operation === OperationTypeNode.QUERY) {
        queryTypeName = op.type.name.value;
      } else if (op.operation === OperationTypeNode.MUTATION) {
        mutationTypeName = op.type.name.value;
      } else if (op.operation === OperationTypeNode.SUBSCRIPTION) {
        subscriptionTypeName = op.type.name.value;
      }
    }
  }

  // Fallback to default Query / Mutation / Subscription if not explicitly overridden by schema definition
  if (!schemaDef) {
    if (!queryTypeName && builtTypes.has("Query")) {
      queryTypeName = "Query";
    }
    if (!mutationTypeName && builtTypes.has("Mutation")) {
      mutationTypeName = "Mutation";
    }
    if (!subscriptionTypeName && builtTypes.has("Subscription")) {
      subscriptionTypeName = "Subscription";
    }
  }

  const getRootObjectType = (
    name: string | undefined,
  ): GraphQLObjectType | undefined => {
    if (!name) return undefined;
    const t = builtTypes.get(name);
    if (!t || !isObjectType(t)) {
      throw new GraphQLError(`Specified root type "${name}" is not an Object type.`);
    }
    return t;
  };

  const userTypes = typeOrder
    .map((n) => builtTypes.get(n))
    .filter((t): t is GraphQLNamedType => t !== undefined);

  return new GraphQLSchema({
    description: schemaDef?.description?.value,
    query: getRootObjectType(queryTypeName),
    mutation: getRootObjectType(mutationTypeName),
    subscription: getRootObjectType(subscriptionTypeName),
    types: userTypes,
    directives: builtDirectives,
    astNode: schemaDef,
    extensionASTNodes: schemaExtensions,
  });
}

export function buildSchema(
  source: string | Source,
  options?: BuildSchemaOptions,
): GraphQLSchema {
  return buildASTSchema(parse(source, options), options);
}

// ---------------------------------------------------------------------------
// printSchema & printType
// ---------------------------------------------------------------------------

function printDescription(
  def: { readonly description?: Maybe<string> },
  indentation = "",
  firstInBlock = true,
): string {
  const { description } = def;
  if (description == null) {
    return "";
  }
  const blockStr = printBlockString(description, {
    minimize: !description.includes("\n"),
  });
  const prefix = indentation && !firstInBlock ? `\n${indentation}` : indentation;
  return `${prefix}${blockStr.replace(/\n/g, `\n${indentation}`)}\n`;
}

function printDeprecated(
  deprecationReason: Maybe<string>,
): string {
  if (deprecationReason == null) {
    return "";
  }
  if (deprecationReason === DEFAULT_DEPRECATION_REASON) {
    return " @deprecated";
  }
  return ` @deprecated(reason: ${printString(deprecationReason)})`;
}

function printSpecifiedByURL(scalar: GraphQLScalarType): string {
  if (scalar.specifiedByURL == null) {
    return "";
  }
  return ` @specifiedBy(url: ${printString(scalar.specifiedByURL)})`;
}

function printInputValue(arg: GraphQLArgument | GraphQLInputField): string {
  const defaultAST = astFromValue(arg.defaultValue, arg.type);
  let argDecl = `${arg.name}: ${String(arg.type)}`;
  if (defaultAST) {
    argDecl += ` = ${print(defaultAST)}`;
  }
  return argDecl + printDeprecated(arg.deprecationReason);
}

function printArgs(
  args: readonly GraphQLArgument[],
  indentation = "",
): string {
  if (args.length === 0) {
    return "";
  }
  if (args.every((arg) => !arg.description)) {
    return `(${args.map(printInputValue).join(", ")})`;
  }
  return (
    "(\n" +
    args
      .map(
        (arg, i) =>
          printDescription(arg, `  ${indentation}`, i === 0) +
          `  ${indentation}${printInputValue(arg)}`,
      )
      .join("\n") +
    `\n${indentation})`
  );
}

function printFields(
  type: GraphQLObjectType | GraphQLInterfaceType,
): string {
  const fields = Object.values(type.getFields());
  if (fields.length === 0) {
    return "";
  }
  return (
    " {\n" +
    fields
      .map(
        (f: GraphQLField<any, any>, i) =>
          printDescription(f, "  ", i === 0) +
          `  ${f.name}${printArgs(f.args, "  ")}: ${String(f.type)}` +
          printDeprecated(f.deprecationReason),
      )
      .join("\n") +
    "\n}"
  );
}

function printImplementedInterfaces(
  type: GraphQLObjectType | GraphQLInterfaceType,
): string {
  const interfaces = type.getInterfaces();
  return interfaces.length > 0
    ? ` implements ${interfaces.map((i) => i.name).join(" & ")}`
    : "";
}

function printDirective(directive: GraphQLDirective): string {
  return (
    printDescription(directive) +
    `directive @${directive.name}${printArgs(directive.args)}` +
    (directive.isRepeatable ? " repeatable" : "") +
    ` on ${directive.locations.join(" | ")}`
  );
}

export function printType(type: GraphQLNamedType): string {
  if (isScalarType(type)) {
    return (
      printDescription(type) +
      `scalar ${type.name}` +
      printSpecifiedByURL(type)
    );
  }
  if (isObjectType(type)) {
    return (
      printDescription(type) +
      `type ${type.name}` +
      printImplementedInterfaces(type) +
      printFields(type)
    );
  }
  if (isInterfaceType(type)) {
    return (
      printDescription(type) +
      `interface ${type.name}` +
      printImplementedInterfaces(type) +
      printFields(type)
    );
  }
  if (isUnionType(type)) {
    const types = type.getTypes();
    const possibleTypes = types.length
      ? ` = ${types.map((t) => t.name).join(" | ")}`
      : "";
    return printDescription(type) + `union ${type.name}${possibleTypes}`;
  }
  if (isEnumType(type)) {
    const values = type
      .getValues()
      .map(
        (v, i) =>
          printDescription(v, "  ", i === 0) +
          `  ${v.name}` +
          printDeprecated(v.deprecationReason),
      );
    const body = values.length > 0 ? ` {\n${values.join("\n")}\n}` : "";
    return printDescription(type) + `enum ${type.name}${body}`;
  }
  if (isInputObjectType(type)) {
    const fields = Object.values(type.getFields()).map(
      (f, i) =>
        printDescription(f, "  ", i === 0) + `  ${printInputValue(f)}`,
    );
    const oneOf = type.isOneOf ? " @oneOf" : "";
    const body = fields.length > 0 ? ` {\n${fields.join("\n")}\n}` : "";
    return printDescription(type) + `input ${type.name}${oneOf}${body}`;
  }
  throw new Error(`Unexpected type: ${String(type)}`);
}

function isSchemaOfCommonNames(schema: GraphQLSchema): boolean {
  const queryType = schema.getQueryType();
  if (queryType && queryType.name !== "Query") {
    return false;
  }
  const mutationType = schema.getMutationType();
  if (mutationType && mutationType.name !== "Mutation") {
    return false;
  }
  const subscriptionType = schema.getSubscriptionType();
  if (subscriptionType && subscriptionType.name !== "Subscription") {
    return false;
  }
  return true;
}

function printSchemaDefinition(schema: GraphQLSchema): string | undefined {
  if (schema.description == null && isSchemaOfCommonNames(schema)) {
    return undefined;
  }
  const operationTypes: string[] = [];
  const queryType = schema.getQueryType();
  if (queryType) {
    operationTypes.push(`  query: ${queryType.name}`);
  }
  const mutationType = schema.getMutationType();
  if (mutationType) {
    operationTypes.push(`  mutation: ${mutationType.name}`);
  }
  const subscriptionType = schema.getSubscriptionType();
  if (subscriptionType) {
    operationTypes.push(`  subscription: ${subscriptionType.name}`);
  }
  return (
    printDescription(schema) + `schema {\n${operationTypes.join("\n")}\n}`
  );
}

export interface PrintSubgraphSchemaOptions {
  /** Include Federation v2 directive definitions (used for `_service { sdl }`). */
  readonly includeFederationDirectives?: boolean;
  /** Emit `extend schema @link(url: ..., import: [...])` header for Federation v2 SDL files. */
  readonly emitFederationLink?: boolean;
}

const FEDERATION_V2_DIRECTIVE_NAMES = new Set([
  "key",
  "requires",
  "provides",
  "external",
  "extends",
  "shareable",
  "inaccessible",
  "override",
  "tag",
  "composeDirective",
  "interfaceObject",
]);

const FEDERATION_INTERNAL_TYPES = new Set(["_Any", "_Entity", "_Service"]);
const FEDERATION_INTERNAL_QUERY_FIELDS = new Set(["_service", "_entities"]);

const FEDERATION_V2_DIRECTIVE_SDL = [
  "directive @key(fields: String!, resolvable: Boolean = true) repeatable on OBJECT | INTERFACE",
  "directive @requires(fields: String!) on FIELD_DEFINITION",
  "directive @provides(fields: String!) on FIELD_DEFINITION",
  "directive @external on OBJECT | FIELD_DEFINITION",
  "directive @extends on OBJECT | INTERFACE",
  "directive @shareable on FIELD_DEFINITION | OBJECT",
  "directive @inaccessible on FIELD_DEFINITION | OBJECT | INTERFACE | UNION | ARGUMENT_DEFINITION | SCALAR | ENUM | ENUM_VALUE | INPUT_OBJECT | INPUT_FIELD_DEFINITION",
  "directive @override(from: String!) on FIELD_DEFINITION",
  "directive @tag(name: String!) repeatable on FIELD_DEFINITION | INTERFACE | OBJECT | UNION | ARGUMENT_DEFINITION | SCALAR | ENUM | ENUM_VALUE | INPUT_OBJECT | INPUT_FIELD_DEFINITION",
  "directive @link(url: String, as: String, for: String, import: [String]) repeatable on SCHEMA",
];

function printAstDirectives(
  astNode: { readonly directives?: readonly { readonly kind: typeof Kind.DIRECTIVE; readonly name: { readonly value: string } }[] } | null | undefined,
  usedFederationDirectives?: Set<string>,
): string {
  const dirs = astNode?.directives;
  if (!dirs || dirs.length === 0) return "";
  const printed: string[] = [];
  for (const dir of dirs) {
    if (dir.name.value === "deprecated") continue;
    if (
      usedFederationDirectives &&
      FEDERATION_V2_DIRECTIVE_NAMES.has(dir.name.value)
    ) {
      usedFederationDirectives.add(`@${dir.name.value}`);
    }
    printed.push(print(dir as any));
  }
  return printed.length > 0 ? ` ${printed.join(" ")}` : "";
}

function printSubgraphFields(
  type: GraphQLObjectType | GraphQLInterfaceType,
  isQueryType: boolean,
  usedFederationDirectives?: Set<string>,
): string {
  const fields = Object.values(type.getFields()).filter(
    (f) => !isQueryType || !FEDERATION_INTERNAL_QUERY_FIELDS.has(f.name),
  );
  if (fields.length === 0) {
    return "";
  }
  return (
    " {\n" +
    fields
      .map(
        (f: GraphQLField<any, any>, i) =>
          printDescription(f, "  ", i === 0) +
          `  ${f.name}${printArgs(f.args, "  ")}: ${String(f.type)}` +
          printDeprecated(f.deprecationReason) +
          printAstDirectives(f.astNode, usedFederationDirectives),
      )
      .join("\n") +
    "\n}"
  );
}

function printSubgraphType(
  type: GraphQLNamedType,
  isQueryType: boolean,
  usedFederationDirectives?: Set<string>,
): string {
  if (isScalarType(type)) {
    return (
      printDescription(type) +
      `scalar ${type.name}` +
      printSpecifiedByURL(type) +
      printAstDirectives(type.astNode, usedFederationDirectives)
    );
  }
  if (isObjectType(type)) {
    const body = printSubgraphFields(type, isQueryType, usedFederationDirectives);
    if (isQueryType && !body) {
      return "";
    }
    return (
      printDescription(type) +
      `type ${type.name}` +
      printImplementedInterfaces(type) +
      printAstDirectives(type.astNode, usedFederationDirectives) +
      body
    );
  }
  if (isInterfaceType(type)) {
    return (
      printDescription(type) +
      `interface ${type.name}` +
      printImplementedInterfaces(type) +
      printAstDirectives(type.astNode, usedFederationDirectives) +
      printSubgraphFields(type, false, usedFederationDirectives)
    );
  }
  if (isUnionType(type)) {
    const types = type.getTypes();
    const possibleTypes = types.length
      ? ` = ${types.map((t) => t.name).join(" | ")}`
      : "";
    return (
      printDescription(type) +
      `union ${type.name}` +
      printAstDirectives(type.astNode, usedFederationDirectives) +
      possibleTypes
    );
  }
  if (isEnumType(type)) {
    const values = type
      .getValues()
      .map(
        (v, i) =>
          printDescription(v, "  ", i === 0) +
          `  ${v.name}` +
          printDeprecated(v.deprecationReason) +
          printAstDirectives(v.astNode, usedFederationDirectives),
      );
    const body = values.length > 0 ? ` {\n${values.join("\n")}\n}` : "";
    return (
      printDescription(type) +
      `enum ${type.name}` +
      printAstDirectives(type.astNode, usedFederationDirectives) +
      body
    );
  }
  if (isInputObjectType(type)) {
    const fields = Object.values(type.getFields()).map(
      (f, i) =>
        printDescription(f, "  ", i === 0) +
        `  ${printInputValue(f)}` +
        printAstDirectives(f.astNode, usedFederationDirectives),
    );
    const oneOf = type.isOneOf ? " @oneOf" : "";
    const body = fields.length > 0 ? ` {\n${fields.join("\n")}\n}` : "";
    return (
      printDescription(type) +
      `input ${type.name}${oneOf}` +
      printAstDirectives(type.astNode, usedFederationDirectives) +
      body
    );
  }
  return printType(type);
}

export function printSubgraphSchema(
  schema: GraphQLSchema,
  options: PrintSubgraphSchemaOptions = {},
): string {
  const usedFederationDirectives = new Set<string>();
  const queryType = schema.getQueryType();
  const directives = schema
    .getDirectives()
    .filter((d) => !isSpecifiedDirective(d));
  const types = Object.values(schema.getTypeMap()).filter(
    (t) =>
      !isSpecifiedScalarType(t) &&
      !isIntrospectionType(t) &&
      !FEDERATION_INTERNAL_TYPES.has(t.name),
  );

  const printedTypes = types
    .map((t) =>
      printSubgraphType(t, t === queryType, usedFederationDirectives),
    )
    .filter((b): b is string => Boolean(b));

  const blocks: string[] = [];

  if (options.emitFederationLink) {
    const imports = [...usedFederationDirectives].sort();
    const importList =
      imports.length > 0
        ? `, import: [${imports.map((d) => `"${d}"`).join(", ")}]`
        : "";
    blocks.push(
      `extend schema @link(url: "https://specs.apollo.dev/federation/v2.3"${importList})`,
    );
  }

  const schemaDef = printSchemaDefinition(schema);
  if (schemaDef) blocks.push(schemaDef);

  if (options.includeFederationDirectives) {
    const existingNames = new Set(directives.map((d) => d.name));
    for (const fedDir of FEDERATION_V2_DIRECTIVE_SDL) {
      const m = /^directive @(\w+)/.exec(fedDir);
      if (!m || !existingNames.has(m[1]!)) {
        blocks.push(fedDir);
      }
    }
  }

  for (const d of directives) {
    blocks.push(printDirective(d));
  }

  blocks.push(...printedTypes);
  return blocks.join("\n\n");
}

export function printSchema(schema: GraphQLSchema): string {
  const directives = schema
    .getDirectives()
    .filter((d) => !isSpecifiedDirective(d));
  const types = Object.values(schema.getTypeMap()).filter(
    (t) => !isSpecifiedScalarType(t) && !isIntrospectionType(t),
  );

  const blocks = [
    printSchemaDefinition(schema),
    ...directives.map(printDirective),
    ...types.map(printType),
  ].filter((b): b is string => Boolean(b));

  return blocks.join("\n\n");
}

export function printIntrospectionSchema(schema: GraphQLSchema): string {
  const directives = schema.getDirectives().filter(isSpecifiedDirective);
  const types = Object.values(schema.getTypeMap()).filter(isIntrospectionType);
  return [...directives.map(printDirective), ...types.map(printType)].join(
    "\n\n",
  );
}

// ---------------------------------------------------------------------------
// lexicographicSortSchema
// ---------------------------------------------------------------------------

function naturalCompare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function sortByName<T extends { readonly name: string }>(
  list: readonly T[],
): T[] {
  return [...list].sort((a, b) => naturalCompare(a.name, b.name));
}

function sortObjMap<T>(map: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = Object.create(null);
  for (const key of Object.keys(map).sort(naturalCompare)) {
    sorted[key] = map[key]!;
  }
  return sorted;
}

export function lexicographicSortSchema(schema: GraphQLSchema): GraphQLSchema {
  const schemaConfig = schema.toConfig();
  const typeMap: Record<string, GraphQLNamedType> = Object.create(null);

  const replaceNamedType = <T extends GraphQLNamedType>(type: T): T =>
    (typeMap[type.name] ?? type) as T;

  const replaceMaybeType = <T extends GraphQLNamedType>(
    type: Maybe<T>,
  ): T | undefined => (type ? replaceNamedType(type) : undefined);

  const replaceType = (type: GraphQLType): GraphQLType => {
    if (isListType(type)) {
      return new GraphQLList(replaceType(type.ofType));
    }
    if (isNonNullType(type)) {
      return new GraphQLNonNull(replaceType(type.ofType));
    }
    return replaceNamedType(type as GraphQLNamedType);
  };

  const sortArgs = (
    args: GraphQLFieldConfigArgumentMap | undefined,
  ): GraphQLFieldConfigArgumentMap => {
    const out: GraphQLFieldConfigArgumentMap = Object.create(null);
    if (!args) return out;
    for (const key of Object.keys(args).sort(naturalCompare)) {
      const arg = args[key]!;
      out[key] = {
        ...arg,
        type: replaceType(arg.type) as GraphQLInputType,
      };
    }
    return out;
  };

  const sortFields = (
    fields: GraphQLFieldConfigMap<any, any>,
  ): GraphQLFieldConfigMap<any, any> => {
    const out: GraphQLFieldConfigMap<any, any> = Object.create(null);
    for (const key of Object.keys(fields).sort(naturalCompare)) {
      const field = fields[key]!;
      out[key] = {
        ...field,
        type: replaceType(field.type) as GraphQLOutputType,
        args: sortArgs(field.args),
      };
    }
    return out;
  };

  const sortInputFields = (
    fields: GraphQLInputFieldConfigMap,
  ): GraphQLInputFieldConfigMap => {
    const out: GraphQLInputFieldConfigMap = Object.create(null);
    for (const key of Object.keys(fields).sort(naturalCompare)) {
      const field = fields[key]!;
      out[key] = {
        ...field,
        type: replaceType(field.type) as GraphQLInputType,
      };
    }
    return out;
  };

  const sortedTypes = sortByName(schemaConfig.types);
  for (const type of sortedTypes) {
    if (isScalarType(type)) {
      typeMap[type.name] = type;
    } else if (isObjectType(type)) {
      const cfg = type.toConfig();
      typeMap[type.name] = new GraphQLObjectType({
        ...cfg,
        interfaces: () => sortByName(cfg.interfaces).map(replaceNamedType),
        fields: () => sortFields(cfg.fields),
      });
    } else if (isInterfaceType(type)) {
      const cfg = type.toConfig();
      typeMap[type.name] = new GraphQLInterfaceType({
        ...cfg,
        interfaces: () => sortByName(cfg.interfaces).map(replaceNamedType),
        fields: () => sortFields(cfg.fields),
      });
    } else if (isUnionType(type)) {
      const cfg = type.toConfig();
      typeMap[type.name] = new GraphQLUnionType({
        ...cfg,
        types: () => sortByName(cfg.types).map(replaceNamedType),
      });
    } else if (isEnumType(type)) {
      const cfg = type.toConfig();
      typeMap[type.name] = new GraphQLEnumType({
        ...cfg,
        values: sortObjMap(cfg.values),
      });
    } else if (isInputObjectType(type)) {
      const cfg = type.toConfig();
      typeMap[type.name] = new GraphQLInputObjectType({
        ...cfg,
        fields: () => sortInputFields(cfg.fields),
      });
    }
  }

  const sortedDirectives = sortByName(schemaConfig.directives).map((dir) => {
    const cfg = dir.toConfig();
    return new GraphQLDirective({
      ...cfg,
      locations: [...cfg.locations].sort(naturalCompare),
      args: sortArgs(cfg.args),
    });
  });

  return new GraphQLSchema({
    ...schemaConfig,
    types: Object.values(typeMap),
    directives: sortedDirectives,
    query: replaceMaybeType(schemaConfig.query),
    mutation: replaceMaybeType(schemaConfig.mutation),
    subscription: replaceMaybeType(schemaConfig.subscription),
  });
}
