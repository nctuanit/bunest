/**
 * GraphQL October 2021 Spec Schema Definition & Type Registry.
 * Supports full type collection, interface implementation graphs, directives,
 * introspection types, `toConfig()`, and duck-typing for externally constructed schemas.
 * Zero external dependencies.
 */

import {
  OperationTypeNode,
  type SchemaDefinitionNode,
  type SchemaExtensionNode,
} from "./ast";
import { __Schema, isIntrospectionType } from "./introspection";
import type { Maybe } from "./scalars";
import {
  getNamedType,
  type GraphQLAbstractType,
  type GraphQLDirective,
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isUnionType,
  specifiedDirectives,
} from "./types";

export interface GraphQLSchemaConfig {
  readonly description?: Maybe<string>;
  readonly query?: Maybe<GraphQLObjectType>;
  readonly mutation?: Maybe<GraphQLObjectType>;
  readonly subscription?: Maybe<GraphQLObjectType>;
  readonly types?: Maybe<readonly GraphQLNamedType[]>;
  readonly directives?: Maybe<readonly GraphQLDirective[]>;
  readonly assumeValid?: boolean;
  readonly extensions?: Maybe<Readonly<Record<string, unknown>>>;
  readonly astNode?: Maybe<SchemaDefinitionNode>;
  readonly extensionASTNodes?: Maybe<readonly SchemaExtensionNode[]>;
}

export interface GraphQLSchemaNormalizedConfig {
  readonly description: Maybe<string>;
  readonly query: Maybe<GraphQLObjectType>;
  readonly mutation: Maybe<GraphQLObjectType>;
  readonly subscription: Maybe<GraphQLObjectType>;
  readonly types: readonly GraphQLNamedType[];
  readonly directives: readonly GraphQLDirective[];
  readonly assumeValid: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly astNode: Maybe<SchemaDefinitionNode>;
  readonly extensionASTNodes: readonly SchemaExtensionNode[];
}

export interface InterfaceImplementations {
  readonly objects: readonly GraphQLObjectType[];
  readonly interfaces: readonly GraphQLInterfaceType[];
}

function collectReferencedTypes(
  type: GraphQLType,
  typeSet: Set<GraphQLNamedType>,
  visited: Set<GraphQLNamedType>,
): void {
  const namedType = getNamedType(type);
  typeSet.add(namedType);
  if (!visited.has(namedType)) {
    visited.add(namedType);
    if (isUnionType(namedType)) {
      for (const memberType of namedType.getTypes()) {
        collectReferencedTypes(memberType, typeSet, visited);
      }
    } else if (isObjectType(namedType) || isInterfaceType(namedType)) {
      for (const iface of namedType.getInterfaces()) {
        collectReferencedTypes(iface, typeSet, visited);
      }
      for (const field of Object.values(namedType.getFields())) {
        collectReferencedTypes(field.type, typeSet, visited);
        for (const arg of field.args) {
          collectReferencedTypes(arg.type, typeSet, visited);
        }
      }
    } else if (isInputObjectType(namedType)) {
      for (const field of Object.values(namedType.getFields())) {
        collectReferencedTypes(field.type, typeSet, visited);
      }
    }
  }
}

export class GraphQLSchema {
  readonly description: Maybe<string>;
  extensions: Record<string, unknown>;
  readonly astNode: Maybe<SchemaDefinitionNode>;
  readonly extensionASTNodes: readonly SchemaExtensionNode[];

  private readonly _queryType: Maybe<GraphQLObjectType>;
  private readonly _mutationType: Maybe<GraphQLObjectType>;
  private readonly _subscriptionType: Maybe<GraphQLObjectType>;
  private readonly _directives: readonly GraphQLDirective[];
  private readonly _typeMap: Record<string, GraphQLNamedType>;
  private readonly _subTypeMap: Record<string, Record<string, boolean>>;
  private readonly _implementationsMap: Record<
    string,
    { objects: GraphQLObjectType[]; interfaces: GraphQLInterfaceType[] }
  >;

  constructor(config: GraphQLSchemaConfig) {
    this.description = config.description;
    this.extensions = config.extensions ? { ...config.extensions } : {};
    this.astNode = config.astNode;
    this.extensionASTNodes = config.extensionASTNodes ?? [];

    this._queryType = config.query;
    this._mutationType = config.mutation;
    this._subscriptionType = config.subscription;
    this._directives = config.directives
      ? [...config.directives]
      : [...specifiedDirectives];

    const initialTypes = new Set<GraphQLNamedType>();
    const visitedTypes = new Set<GraphQLNamedType>();
    // Pre-seed explicit `config.types` first so caller ordering (e.g. lexicographicSortSchema / SDL order) is preserved.
    if (config.types) {
      for (const t of config.types) {
        if (t) {
          initialTypes.add(t);
        }
      }
    }
    if (this._queryType) {
      collectReferencedTypes(this._queryType, initialTypes, visitedTypes);
    }
    if (this._mutationType) {
      collectReferencedTypes(this._mutationType, initialTypes, visitedTypes);
    }
    if (this._subscriptionType) {
      collectReferencedTypes(
        this._subscriptionType,
        initialTypes,
        visitedTypes,
      );
    }
    if (config.types) {
      for (const t of config.types) {
        if (t) {
          collectReferencedTypes(t, initialTypes, visitedTypes);
        }
      }
    }
    for (const directive of this._directives) {
      for (const arg of directive.args) {
        collectReferencedTypes(arg.type, initialTypes, visitedTypes);
      }
    }
    collectReferencedTypes(__Schema, initialTypes, visitedTypes);

    const typeMap: Record<string, GraphQLNamedType> = Object.create(null);
    for (const namedType of initialTypes) {
      if (!namedType.name) continue;
      const existing = typeMap[namedType.name];
      if (existing !== undefined && existing !== namedType) {
        throw new Error(
          `Schema must contain uniquely named types but contains multiple types named "${namedType.name}".`,
        );
      }
      typeMap[namedType.name] = namedType;
    }
    this._typeMap = typeMap;

    const implementationsMap: Record<
      string,
      { objects: GraphQLObjectType[]; interfaces: GraphQLInterfaceType[] }
    > = Object.create(null);

    for (const type of Object.values(typeMap)) {
      if (isInterfaceType(type)) {
        for (const iface of type.getInterfaces()) {
          if (isInterfaceType(iface)) {
            let impls = implementationsMap[iface.name];
            if (!impls) {
              impls = { objects: [], interfaces: [] };
              implementationsMap[iface.name] = impls;
            }
            impls.interfaces.push(type);
          }
        }
      } else if (isObjectType(type)) {
        for (const iface of type.getInterfaces()) {
          if (isInterfaceType(iface)) {
            let impls = implementationsMap[iface.name];
            if (!impls) {
              impls = { objects: [], interfaces: [] };
              implementationsMap[iface.name] = impls;
            }
            impls.objects.push(type);
          }
        }
      }
    }

    this._implementationsMap = implementationsMap;
    this._subTypeMap = Object.create(null);
  }

  get [Symbol.toStringTag](): string {
    return "GraphQLSchema";
  }

  getQueryType(): Maybe<GraphQLObjectType> {
    return this._queryType;
  }

  getMutationType(): Maybe<GraphQLObjectType> {
    return this._mutationType;
  }

  getSubscriptionType(): Maybe<GraphQLObjectType> {
    return this._subscriptionType;
  }

  getRootType(operation: OperationTypeNode): Maybe<GraphQLObjectType> {
    switch (operation) {
      case OperationTypeNode.QUERY:
        return this._queryType;
      case OperationTypeNode.MUTATION:
        return this._mutationType;
      case OperationTypeNode.SUBSCRIPTION:
        return this._subscriptionType;
    }
  }

  getTypeMap(): Record<string, GraphQLNamedType> {
    return this._typeMap;
  }

  getType(name: string): Maybe<GraphQLNamedType> {
    return this._typeMap[name];
  }

  getPossibleTypes(
    abstractType: GraphQLAbstractType,
  ): readonly GraphQLObjectType[] {
    return isUnionType(abstractType)
      ? abstractType.getTypes()
      : this.getImplementations(abstractType).objects;
  }

  getImplementations(
    interfaceType: GraphQLInterfaceType,
  ): InterfaceImplementations {
    const matching = this._implementationsMap[interfaceType.name];
    return matching ?? { objects: [], interfaces: [] };
  }

  isSubType(
    abstractType: GraphQLAbstractType,
    maybeSubType: GraphQLObjectType | GraphQLInterfaceType,
  ): boolean {
    let map = this._subTypeMap[abstractType.name];
    if (map === undefined) {
      map = Object.create(null);
      if (isUnionType(abstractType)) {
        for (const type of abstractType.getTypes()) {
          map![type.name] = true;
        }
      } else {
        const impls = this.getImplementations(abstractType);
        for (const type of impls.objects) {
          map![type.name] = true;
        }
        for (const type of impls.interfaces) {
          map![type.name] = true;
        }
      }
      this._subTypeMap[abstractType.name] = map!;
    }
    return map![maybeSubType.name] !== undefined;
  }

  getDirectives(): readonly GraphQLDirective[] {
    return this._directives;
  }

  getDirective(name: string): Maybe<GraphQLDirective> {
    return this._directives.find((d) => d.name === name);
  }

  toConfig(): GraphQLSchemaNormalizedConfig {
    return {
      description: this.description,
      query: this._queryType,
      mutation: this._mutationType,
      subscription: this._subscriptionType,
      types: Object.values(this._typeMap).filter(
        (t) => !isIntrospectionType(t),
      ),
      directives: [...this._directives],
      assumeValid: true,
      extensions: this.extensions,
      astNode: this.astNode,
      extensionASTNodes: this.extensionASTNodes,
    };
  }
}

export function isSchema(schema: unknown): schema is GraphQLSchema {
  if (schema instanceof GraphQLSchema) return true;
  if (!schema || typeof schema !== "object") return false;
  if (
    (schema as { [Symbol.toStringTag]?: string })[Symbol.toStringTag] ===
    "GraphQLSchema"
  ) {
    return true;
  }
  return (
    typeof (schema as GraphQLSchema).getTypeMap === "function" &&
    typeof (schema as GraphQLSchema).getQueryType === "function"
  );
}
