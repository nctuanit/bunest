/**
 * GraphQL October 2021 Spec Type System Definitions, Directives, Type Guards & Coercion Utilities.
 * Supports duck-typing via `Symbol.toStringTag` so external GraphQL types interoperate cleanly.
 * Zero external dependencies.
 */

import {
  type ConstValueNode,
  DirectiveLocation,
  type DirectiveDefinitionNode,
  type DirectiveLocationEnum,
  type EnumTypeDefinitionNode,
  type EnumTypeExtensionNode,
  type EnumValueDefinitionNode,
  type FieldDefinitionNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type InputObjectTypeDefinitionNode,
  type InputObjectTypeExtensionNode,
  type InputValueDefinitionNode,
  type InterfaceTypeDefinitionNode,
  type InterfaceTypeExtensionNode,
  Kind,
  type ObjectTypeDefinitionNode,
  type ObjectTypeExtensionNode,
  type OperationDefinitionNode,
  type TypeNode,
  type UnionTypeDefinitionNode,
  type UnionTypeExtensionNode,
  type ValueNode,
} from "./ast";
import { GraphQLError, isGraphQLError } from "./error";
import { print } from "./printer";
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLScalarType,
  GraphQLString,
  type Maybe,
} from "./scalars";
import type { GraphQLSchema } from "./schema";

export type ThunkReadonlyArray<T> = (() => readonly T[]) | readonly T[];
export type ThunkObjMap<T> = (() => Record<string, T>) | Record<string, T>;

function resolveReadonlyArrayThunk<T>(thunk: ThunkReadonlyArray<T>): readonly T[] {
  return typeof thunk === "function" ? thunk() : thunk;
}

function resolveObjMapThunk<T>(thunk: ThunkObjMap<T>): Record<string, T> {
  return typeof thunk === "function" ? thunk() : thunk;
}

function getTag(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return (value as { [Symbol.toStringTag]?: string })[Symbol.toStringTag];
}

// ---------------------------------------------------------------------------
// ResponsePath & GraphQLResolveInfo
// ---------------------------------------------------------------------------

export interface ResponsePath {
  readonly prev: ResponsePath | undefined;
  readonly key: string | number;
  readonly typename: string | undefined;
}

export function addPath(
  prev: ResponsePath | undefined,
  key: string | number,
  typename: string | undefined,
): ResponsePath {
  return { prev, key, typename };
}

export function pathToArray(path: ResponsePath): (string | number)[] {
  const flattened: (string | number)[] = [];
  let curr: ResponsePath | undefined = path;
  while (curr) {
    flattened.push(curr.key);
    curr = curr.prev;
  }
  return flattened.reverse();
}

export interface GraphQLResolveInfo {
  readonly fieldName: string;
  readonly fieldNodes: readonly FieldNode[];
  readonly returnType: GraphQLOutputType;
  readonly parentType: GraphQLObjectType;
  readonly path: ResponsePath;
  readonly schema: GraphQLSchema;
  readonly fragments: Record<string, FragmentDefinitionNode>;
  readonly rootValue: unknown;
  readonly operation: OperationDefinitionNode;
  readonly variableValues: Record<string, unknown>;
}

export type GraphQLFieldResolver<
  TSource,
  TContext,
  TArgs = any,
  TResult = unknown,
> = (
  source: TSource,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo,
) => TResult;

export type GraphQLTypeResolver<TSource, TContext> = (
  value: TSource,
  context: TContext,
  info: GraphQLResolveInfo,
  abstractType: GraphQLAbstractType,
) =>
  | Promise<Maybe<string | GraphQLObjectType>>
  | Maybe<string | GraphQLObjectType>;

export type GraphQLIsTypeOfFn<TSource, TContext> = (
  source: TSource,
  context: TContext,
  info: GraphQLResolveInfo,
) => Promise<boolean> | boolean;

// ---------------------------------------------------------------------------
// Wrapping Types: List & NonNull
// ---------------------------------------------------------------------------

export class GraphQLList<T extends GraphQLType = GraphQLType> {
  readonly ofType: T;

  constructor(type: T) {
    if (!isType(type)) {
      throw new Error(`Expected ${String(type)} to be a GraphQL type.`);
    }
    this.ofType = type;
  }

  get [Symbol.toStringTag](): string {
    return "GraphQLList";
  }

  toString(): string {
    return `[${String(this.ofType)}]`;
  }

  toJSON(): string {
    return this.toString();
  }
}

export class GraphQLNonNull<T extends GraphQLType = GraphQLNullableType> {
  readonly ofType: T;

  constructor(type: T) {
    if (!isNullableType(type)) {
      throw new Error(
        `Expected ${String(type)} to be a GraphQL nullable type.`,
      );
    }
    this.ofType = type;
  }

  get [Symbol.toStringTag](): string {
    return "GraphQLNonNull";
  }

  toString(): string {
    return `${String(this.ofType)}!`;
  }

  toJSON(): string {
    return this.toString();
  }
}

// ---------------------------------------------------------------------------
// Argument & Field Types
// ---------------------------------------------------------------------------

export interface GraphQLArgumentConfig {
  readonly description?: Maybe<string>;
  readonly type: GraphQLInputType;
  readonly defaultValue?: unknown;
  readonly deprecationReason?: Maybe<string>;
  readonly extensions?: Maybe<Readonly<Record<string, unknown>>>;
  readonly astNode?: Maybe<InputValueDefinitionNode>;
}

export type GraphQLFieldConfigArgumentMap = Record<string, GraphQLArgumentConfig>;

export interface GraphQLArgument {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly type: GraphQLInputType;
  readonly defaultValue: unknown;
  readonly deprecationReason: Maybe<string>;
  extensions: Record<string, unknown>;
  readonly astNode: Maybe<InputValueDefinitionNode>;
}

export interface GraphQLFieldConfig<
  TSource,
  TContext,
  TArgs = any,
> {
  readonly description?: Maybe<string>;
  readonly type: GraphQLOutputType;
  readonly args?: GraphQLFieldConfigArgumentMap;
  readonly resolve?: GraphQLFieldResolver<TSource, TContext, TArgs>;
  readonly subscribe?: GraphQLFieldResolver<TSource, TContext, TArgs>;
  readonly deprecationReason?: Maybe<string>;
  readonly extensions?: Maybe<Readonly<Record<string, unknown>>>;
  readonly astNode?: Maybe<FieldDefinitionNode>;
}

export type GraphQLFieldConfigMap<TSource, TContext> = Record<
  string,
  GraphQLFieldConfig<TSource, TContext>
>;

export interface GraphQLField<
  TSource,
  TContext,
  TArgs = any,
> {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly type: GraphQLOutputType;
  readonly args: readonly GraphQLArgument[];
  resolve?: GraphQLFieldResolver<TSource, TContext, TArgs>;
  subscribe?: GraphQLFieldResolver<TSource, TContext, TArgs>;
  readonly deprecationReason: Maybe<string>;
  extensions: Record<string, unknown>;
  readonly astNode: Maybe<FieldDefinitionNode>;
}

export type GraphQLFieldMap<TSource, TContext> = Record<
  string,
  GraphQLField<TSource, TContext>
>;

function defineArguments(
  argsConfig: Maybe<GraphQLFieldConfigArgumentMap>,
): GraphQLArgument[] {
  if (!argsConfig) return [];
  const args: GraphQLArgument[] = [];
  for (const [argName, argConfig] of Object.entries(argsConfig)) {
    args.push({
      name: argName,
      description: argConfig.description,
      type: argConfig.type,
      defaultValue: argConfig.defaultValue,
      deprecationReason: argConfig.deprecationReason,
      extensions: argConfig.extensions ? { ...argConfig.extensions } : {},
      astNode: argConfig.astNode,
    });
  }
  return args;
}

function argsToConfig(
  args: readonly GraphQLArgument[],
): GraphQLFieldConfigArgumentMap {
  const map: GraphQLFieldConfigArgumentMap = Object.create(null);
  for (const arg of args) {
    map[arg.name] = {
      description: arg.description,
      type: arg.type,
      defaultValue: arg.defaultValue,
      deprecationReason: arg.deprecationReason,
      extensions: arg.extensions,
      astNode: arg.astNode,
    };
  }
  return map;
}

function defineFieldMap<TSource, TContext>(
  fieldsThunk: ThunkObjMap<GraphQLFieldConfig<TSource, TContext>>,
): GraphQLFieldMap<TSource, TContext> {
  const fieldConfigMap = resolveObjMapThunk(fieldsThunk);
  const result: GraphQLFieldMap<TSource, TContext> = Object.create(null);
  for (const [fieldName, fieldConfig] of Object.entries(fieldConfigMap)) {
    result[fieldName] = {
      name: fieldName,
      description: fieldConfig.description,
      type: fieldConfig.type,
      args: defineArguments(fieldConfig.args),
      resolve: fieldConfig.resolve,
      subscribe: fieldConfig.subscribe,
      deprecationReason: fieldConfig.deprecationReason,
      extensions: fieldConfig.extensions ? { ...fieldConfig.extensions } : {},
      astNode: fieldConfig.astNode,
    };
  }
  return result;
}

function fieldsToConfig<TSource, TContext>(
  fields: GraphQLFieldMap<TSource, TContext>,
): GraphQLFieldConfigMap<TSource, TContext> {
  const map: GraphQLFieldConfigMap<TSource, TContext> = Object.create(null);
  for (const [fieldName, field] of Object.entries(fields)) {
    map[fieldName] = {
      description: field.description,
      type: field.type,
      args: argsToConfig(field.args),
      resolve: field.resolve,
      subscribe: field.subscribe,
      deprecationReason: field.deprecationReason,
      extensions: field.extensions,
      astNode: field.astNode,
    };
  }
  return map;
}

// ---------------------------------------------------------------------------
// Object Type
// ---------------------------------------------------------------------------

export interface GraphQLObjectTypeConfig<TSource = any, TContext = any> {
  readonly name: string;
  readonly description?: Maybe<string>;
  readonly interfaces?: ThunkReadonlyArray<GraphQLInterfaceType>;
  readonly fields: ThunkObjMap<GraphQLFieldConfig<TSource, TContext>>;
  readonly isTypeOf?: Maybe<GraphQLIsTypeOfFn<TSource, TContext>>;
  readonly extensions?: Maybe<Readonly<Record<string, unknown>>>;
  readonly astNode?: Maybe<ObjectTypeDefinitionNode>;
  readonly extensionASTNodes?: Maybe<readonly ObjectTypeExtensionNode[]>;
}

export interface GraphQLObjectTypeNormalizedConfig<TSource = any, TContext = any> {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly interfaces: readonly GraphQLInterfaceType[];
  readonly fields: GraphQLFieldConfigMap<TSource, TContext>;
  readonly isTypeOf: Maybe<GraphQLIsTypeOfFn<TSource, TContext>>;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly astNode: Maybe<ObjectTypeDefinitionNode>;
  readonly extensionASTNodes: readonly ObjectTypeExtensionNode[];
}

export class GraphQLObjectType<TSource = any, TContext = any> {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly isTypeOf: Maybe<GraphQLIsTypeOfFn<TSource, TContext>>;
  extensions: Record<string, unknown>;
  readonly astNode: Maybe<ObjectTypeDefinitionNode>;
  readonly extensionASTNodes: readonly ObjectTypeExtensionNode[];

  private readonly _fieldsThunk: ThunkObjMap<GraphQLFieldConfig<TSource, TContext>>;
  private readonly _interfacesThunk: ThunkReadonlyArray<GraphQLInterfaceType>;
  private _fields?: GraphQLFieldMap<TSource, TContext>;
  private _interfaces?: readonly GraphQLInterfaceType[];

  constructor(config: GraphQLObjectTypeConfig<TSource, TContext>) {
    this.name = config.name;
    this.description = config.description;
    this.isTypeOf = config.isTypeOf;
    this.extensions = config.extensions ? { ...config.extensions } : {};
    this.astNode = config.astNode;
    this.extensionASTNodes = config.extensionASTNodes ?? [];
    this._fieldsThunk = config.fields;
    this._interfacesThunk = config.interfaces ?? [];
  }

  get [Symbol.toStringTag](): string {
    return "GraphQLObjectType";
  }

  getFields(): GraphQLFieldMap<TSource, TContext> {
    if (!this._fields) {
      this._fields = defineFieldMap(this._fieldsThunk);
    }
    return this._fields;
  }

  getInterfaces(): readonly GraphQLInterfaceType[] {
    if (!this._interfaces) {
      this._interfaces = resolveReadonlyArrayThunk(this._interfacesThunk);
    }
    return this._interfaces;
  }

  toConfig(): GraphQLObjectTypeNormalizedConfig<TSource, TContext> {
    return {
      name: this.name,
      description: this.description,
      interfaces: [...this.getInterfaces()],
      fields: fieldsToConfig(this.getFields()),
      isTypeOf: this.isTypeOf,
      extensions: this.extensions,
      astNode: this.astNode,
      extensionASTNodes: this.extensionASTNodes,
    };
  }

  toString(): string {
    return this.name;
  }

  toJSON(): string {
    return this.toString();
  }
}

// ---------------------------------------------------------------------------
// Interface Type
// ---------------------------------------------------------------------------

export interface GraphQLInterfaceTypeConfig<TSource = any, TContext = any> {
  readonly name: string;
  readonly description?: Maybe<string>;
  readonly interfaces?: ThunkReadonlyArray<GraphQLInterfaceType>;
  readonly fields: ThunkObjMap<GraphQLFieldConfig<TSource, TContext>>;
  readonly resolveType?: Maybe<GraphQLTypeResolver<TSource, TContext>>;
  readonly extensions?: Maybe<Readonly<Record<string, unknown>>>;
  readonly astNode?: Maybe<InterfaceTypeDefinitionNode>;
  readonly extensionASTNodes?: Maybe<readonly InterfaceTypeExtensionNode[]>;
}

export interface GraphQLInterfaceTypeNormalizedConfig<TSource = any, TContext = any> {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly interfaces: readonly GraphQLInterfaceType[];
  readonly fields: GraphQLFieldConfigMap<TSource, TContext>;
  readonly resolveType: Maybe<GraphQLTypeResolver<TSource, TContext>>;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly astNode: Maybe<InterfaceTypeDefinitionNode>;
  readonly extensionASTNodes: readonly InterfaceTypeExtensionNode[];
}

export class GraphQLInterfaceType {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly resolveType: Maybe<GraphQLTypeResolver<any, any>>;
  extensions: Record<string, unknown>;
  readonly astNode: Maybe<InterfaceTypeDefinitionNode>;
  readonly extensionASTNodes: readonly InterfaceTypeExtensionNode[];

  private readonly _fieldsThunk: ThunkObjMap<GraphQLFieldConfig<any, any>>;
  private readonly _interfacesThunk: ThunkReadonlyArray<GraphQLInterfaceType>;
  private _fields?: GraphQLFieldMap<any, any>;
  private _interfaces?: readonly GraphQLInterfaceType[];

  constructor(config: GraphQLInterfaceTypeConfig<any, any>) {
    this.name = config.name;
    this.description = config.description;
    this.resolveType = config.resolveType;
    this.extensions = config.extensions ? { ...config.extensions } : {};
    this.astNode = config.astNode;
    this.extensionASTNodes = config.extensionASTNodes ?? [];
    this._fieldsThunk = config.fields;
    this._interfacesThunk = config.interfaces ?? [];
  }

  get [Symbol.toStringTag](): string {
    return "GraphQLInterfaceType";
  }

  getFields(): GraphQLFieldMap<any, any> {
    if (!this._fields) {
      this._fields = defineFieldMap(this._fieldsThunk);
    }
    return this._fields;
  }

  getInterfaces(): readonly GraphQLInterfaceType[] {
    if (!this._interfaces) {
      this._interfaces = resolveReadonlyArrayThunk(this._interfacesThunk);
    }
    return this._interfaces;
  }

  toConfig(): GraphQLInterfaceTypeNormalizedConfig<any, any> {
    return {
      name: this.name,
      description: this.description,
      interfaces: [...this.getInterfaces()],
      fields: fieldsToConfig(this.getFields()),
      resolveType: this.resolveType,
      extensions: this.extensions,
      astNode: this.astNode,
      extensionASTNodes: this.extensionASTNodes,
    };
  }

  toString(): string {
    return this.name;
  }

  toJSON(): string {
    return this.toString();
  }
}

// ---------------------------------------------------------------------------
// Union Type
// ---------------------------------------------------------------------------

export interface GraphQLUnionTypeConfig<TSource = any, TContext = any> {
  readonly name: string;
  readonly description?: Maybe<string>;
  readonly types: ThunkReadonlyArray<GraphQLObjectType>;
  readonly resolveType?: Maybe<GraphQLTypeResolver<TSource, TContext>>;
  readonly extensions?: Maybe<Readonly<Record<string, unknown>>>;
  readonly astNode?: Maybe<UnionTypeDefinitionNode>;
  readonly extensionASTNodes?: Maybe<readonly UnionTypeExtensionNode[]>;
}

export interface GraphQLUnionTypeNormalizedConfig<TSource = any, TContext = any> {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly types: readonly GraphQLObjectType[];
  readonly resolveType: Maybe<GraphQLTypeResolver<TSource, TContext>>;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly astNode: Maybe<UnionTypeDefinitionNode>;
  readonly extensionASTNodes: readonly UnionTypeExtensionNode[];
}

export class GraphQLUnionType {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly resolveType: Maybe<GraphQLTypeResolver<any, any>>;
  extensions: Record<string, unknown>;
  readonly astNode: Maybe<UnionTypeDefinitionNode>;
  readonly extensionASTNodes: readonly UnionTypeExtensionNode[];

  private readonly _typesThunk: ThunkReadonlyArray<GraphQLObjectType>;
  private _types?: readonly GraphQLObjectType[];

  constructor(config: GraphQLUnionTypeConfig<any, any>) {
    this.name = config.name;
    this.description = config.description;
    this.resolveType = config.resolveType;
    this.extensions = config.extensions ? { ...config.extensions } : {};
    this.astNode = config.astNode;
    this.extensionASTNodes = config.extensionASTNodes ?? [];
    this._typesThunk = config.types;
  }

  get [Symbol.toStringTag](): string {
    return "GraphQLUnionType";
  }

  getTypes(): readonly GraphQLObjectType[] {
    if (!this._types) {
      this._types = resolveReadonlyArrayThunk(this._typesThunk);
    }
    return this._types;
  }

  toConfig(): GraphQLUnionTypeNormalizedConfig<any, any> {
    return {
      name: this.name,
      description: this.description,
      types: [...this.getTypes()],
      resolveType: this.resolveType,
      extensions: this.extensions,
      astNode: this.astNode,
      extensionASTNodes: this.extensionASTNodes,
    };
  }

  toString(): string {
    return this.name;
  }

  toJSON(): string {
    return this.toString();
  }
}

// ---------------------------------------------------------------------------
// Enum Type
// ---------------------------------------------------------------------------

export interface GraphQLEnumValueConfig {
  readonly description?: Maybe<string>;
  readonly value?: unknown;
  readonly deprecationReason?: Maybe<string>;
  readonly extensions?: Maybe<Readonly<Record<string, unknown>>>;
  readonly astNode?: Maybe<EnumValueDefinitionNode>;
}

export type GraphQLEnumValueConfigMap = Record<string, GraphQLEnumValueConfig>;

export interface GraphQLEnumValue {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly value: unknown;
  readonly deprecationReason: Maybe<string>;
  extensions: Record<string, unknown>;
  readonly astNode: Maybe<EnumValueDefinitionNode>;
}

export interface GraphQLEnumTypeConfig {
  readonly name: string;
  readonly description?: Maybe<string>;
  readonly values: GraphQLEnumValueConfigMap;
  readonly extensions?: Maybe<Readonly<Record<string, unknown>>>;
  readonly astNode?: Maybe<EnumTypeDefinitionNode>;
  readonly extensionASTNodes?: Maybe<readonly EnumTypeExtensionNode[]>;
}

export interface GraphQLEnumTypeNormalizedConfig {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly values: GraphQLEnumValueConfigMap;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly astNode: Maybe<EnumTypeDefinitionNode>;
  readonly extensionASTNodes: readonly EnumTypeExtensionNode[];
}

export class GraphQLEnumType {
  readonly name: string;
  readonly description: Maybe<string>;
  extensions: Record<string, unknown>;
  readonly astNode: Maybe<EnumTypeDefinitionNode>;
  readonly extensionASTNodes: readonly EnumTypeExtensionNode[];

  private readonly _values: readonly GraphQLEnumValue[];
  private readonly _valueLookup: Map<unknown, GraphQLEnumValue>;
  private readonly _nameLookup: Map<string, GraphQLEnumValue>;

  constructor(config: GraphQLEnumTypeConfig) {
    this.name = config.name;
    this.description = config.description;
    this.extensions = config.extensions ? { ...config.extensions } : {};
    this.astNode = config.astNode;
    this.extensionASTNodes = config.extensionASTNodes ?? [];

    const values: GraphQLEnumValue[] = [];
    const valueLookup = new Map<unknown, GraphQLEnumValue>();
    const nameLookup = new Map<string, GraphQLEnumValue>();

    for (const [valueName, valueConfig] of Object.entries(config.values)) {
      const val: GraphQLEnumValue = {
        name: valueName,
        description: valueConfig.description,
        value: valueConfig.value !== undefined ? valueConfig.value : valueName,
        deprecationReason: valueConfig.deprecationReason,
        extensions: valueConfig.extensions ? { ...valueConfig.extensions } : {},
        astNode: valueConfig.astNode,
      };
      values.push(val);
      nameLookup.set(valueName, val);
      if (!valueLookup.has(val.value)) {
        valueLookup.set(val.value, val);
      }
    }

    this._values = values;
    this._valueLookup = valueLookup;
    this._nameLookup = nameLookup;
  }

  get [Symbol.toStringTag](): string {
    return "GraphQLEnumType";
  }

  getValues(): readonly GraphQLEnumValue[] {
    return this._values;
  }

  getValue(name: string): Maybe<GraphQLEnumValue> {
    return this._nameLookup.get(name);
  }

  serialize(outputValue: unknown): string {
    const enumValue = this._valueLookup.get(outputValue);
    if (enumValue === undefined) {
      throw new GraphQLError(
        `Enum "${this.name}" cannot represent value: ${JSON.stringify(outputValue)}`,
      );
    }
    return enumValue.name;
  }

  parseValue(inputValue: unknown): unknown {
    if (typeof inputValue !== "string") {
      throw new GraphQLError(
        `Enum "${this.name}" cannot represent non-string value: ${JSON.stringify(inputValue)}.`,
      );
    }
    const enumValue = this._nameLookup.get(inputValue);
    if (enumValue === undefined) {
      throw new GraphQLError(
        `Value "${inputValue}" does not exist in "${this.name}" enum.`,
      );
    }
    return enumValue.value;
  }

  parseLiteral(valueNode: ValueNode): unknown {
    if (valueNode.kind !== Kind.ENUM) {
      throw new GraphQLError(
        `Enum "${this.name}" cannot represent non-enum value: ${print(valueNode)}.`,
        { nodes: valueNode },
      );
    }
    const enumValue = this._nameLookup.get(valueNode.value);
    if (enumValue === undefined) {
      throw new GraphQLError(
        `Value "${valueNode.value}" does not exist in "${this.name}" enum.`,
        { nodes: valueNode },
      );
    }
    return enumValue.value;
  }

  toConfig(): GraphQLEnumTypeNormalizedConfig {
    const values: GraphQLEnumValueConfigMap = Object.create(null);
    for (const val of this._values) {
      values[val.name] = {
        description: val.description,
        value: val.value,
        deprecationReason: val.deprecationReason,
        extensions: val.extensions,
        astNode: val.astNode,
      };
    }
    return {
      name: this.name,
      description: this.description,
      values,
      extensions: this.extensions,
      astNode: this.astNode,
      extensionASTNodes: this.extensionASTNodes,
    };
  }

  toString(): string {
    return this.name;
  }

  toJSON(): string {
    return this.toString();
  }
}

// ---------------------------------------------------------------------------
// Input Object Type
// ---------------------------------------------------------------------------

export interface GraphQLInputFieldConfig {
  readonly description?: Maybe<string>;
  readonly type: GraphQLInputType;
  readonly defaultValue?: unknown;
  readonly deprecationReason?: Maybe<string>;
  readonly extensions?: Maybe<Readonly<Record<string, unknown>>>;
  readonly astNode?: Maybe<InputValueDefinitionNode>;
}

export type GraphQLInputFieldConfigMap = Record<string, GraphQLInputFieldConfig>;

export interface GraphQLInputField {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly type: GraphQLInputType;
  readonly defaultValue: unknown;
  readonly deprecationReason: Maybe<string>;
  extensions: Record<string, unknown>;
  readonly astNode: Maybe<InputValueDefinitionNode>;
}

export type GraphQLInputFieldMap = Record<string, GraphQLInputField>;

export interface GraphQLInputObjectTypeConfig {
  readonly name: string;
  readonly description?: Maybe<string>;
  readonly fields: ThunkObjMap<GraphQLInputFieldConfig>;
  readonly extensions?: Maybe<Readonly<Record<string, unknown>>>;
  readonly astNode?: Maybe<InputObjectTypeDefinitionNode>;
  readonly extensionASTNodes?: Maybe<readonly InputObjectTypeExtensionNode[]>;
  readonly isOneOf?: boolean;
}

export interface GraphQLInputObjectTypeNormalizedConfig {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly fields: GraphQLInputFieldConfigMap;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly astNode: Maybe<InputObjectTypeDefinitionNode>;
  readonly extensionASTNodes: readonly InputObjectTypeExtensionNode[];
  readonly isOneOf: boolean;
}

export class GraphQLInputObjectType {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly isOneOf: boolean;
  extensions: Record<string, unknown>;
  readonly astNode: Maybe<InputObjectTypeDefinitionNode>;
  readonly extensionASTNodes: readonly InputObjectTypeExtensionNode[];

  private readonly _fieldsThunk: ThunkObjMap<GraphQLInputFieldConfig>;
  private _fields?: GraphQLInputFieldMap;

  constructor(config: GraphQLInputObjectTypeConfig) {
    this.name = config.name;
    this.description = config.description;
    this.isOneOf = Boolean(config.isOneOf);
    this.extensions = config.extensions ? { ...config.extensions } : {};
    this.astNode = config.astNode;
    this.extensionASTNodes = config.extensionASTNodes ?? [];
    this._fieldsThunk = config.fields;
  }

  get [Symbol.toStringTag](): string {
    return "GraphQLInputObjectType";
  }

  getFields(): GraphQLInputFieldMap {
    if (!this._fields) {
      const raw = resolveObjMapThunk(this._fieldsThunk);
      const map: GraphQLInputFieldMap = Object.create(null);
      for (const [fieldName, fieldConfig] of Object.entries(raw)) {
        map[fieldName] = {
          name: fieldName,
          description: fieldConfig.description,
          type: fieldConfig.type,
          defaultValue: fieldConfig.defaultValue,
          deprecationReason: fieldConfig.deprecationReason,
          extensions: fieldConfig.extensions ? { ...fieldConfig.extensions } : {},
          astNode: fieldConfig.astNode,
        };
      }
      this._fields = map;
    }
    return this._fields;
  }

  toConfig(): GraphQLInputObjectTypeNormalizedConfig {
    const fields: GraphQLInputFieldConfigMap = Object.create(null);
    for (const [name, f] of Object.entries(this.getFields())) {
      fields[name] = {
        description: f.description,
        type: f.type,
        defaultValue: f.defaultValue,
        deprecationReason: f.deprecationReason,
        extensions: f.extensions,
        astNode: f.astNode,
      };
    }
    return {
      name: this.name,
      description: this.description,
      fields,
      extensions: this.extensions,
      astNode: this.astNode,
      extensionASTNodes: this.extensionASTNodes,
      isOneOf: this.isOneOf,
    };
  }

  toString(): string {
    return this.name;
  }

  toJSON(): string {
    return this.toString();
  }
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

export interface GraphQLDirectiveConfig {
  readonly name: string;
  readonly description?: Maybe<string>;
  readonly locations: readonly DirectiveLocationEnum[];
  readonly args?: Maybe<GraphQLFieldConfigArgumentMap>;
  readonly isRepeatable?: Maybe<boolean>;
  readonly extensions?: Maybe<Readonly<Record<string, unknown>>>;
  readonly astNode?: Maybe<DirectiveDefinitionNode>;
}

export interface GraphQLDirectiveNormalizedConfig {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly locations: readonly DirectiveLocationEnum[];
  readonly args: GraphQLFieldConfigArgumentMap;
  readonly isRepeatable: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly astNode: Maybe<DirectiveDefinitionNode>;
}

export class GraphQLDirective {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly locations: readonly DirectiveLocationEnum[];
  readonly args: readonly GraphQLArgument[];
  readonly isRepeatable: boolean;
  extensions: Record<string, unknown>;
  readonly astNode: Maybe<DirectiveDefinitionNode>;

  constructor(config: GraphQLDirectiveConfig) {
    this.name = config.name;
    this.description = config.description;
    this.locations = [...config.locations];
    this.args = defineArguments(config.args);
    this.isRepeatable = Boolean(config.isRepeatable);
    this.extensions = config.extensions ? { ...config.extensions } : {};
    this.astNode = config.astNode;
  }

  get [Symbol.toStringTag](): string {
    return "GraphQLDirective";
  }

  toConfig(): GraphQLDirectiveNormalizedConfig {
    return {
      name: this.name,
      description: this.description,
      locations: [...this.locations],
      args: argsToConfig(this.args),
      isRepeatable: this.isRepeatable,
      extensions: this.extensions,
      astNode: this.astNode,
    };
  }

  toString(): string {
    return `@${this.name}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

export const DEFAULT_DEPRECATION_REASON = "No longer supported";

export const GraphQLIncludeDirective = new GraphQLDirective({
  name: "include",
  description:
    "Directs the executor to include this field or fragment only when the `if` argument is true.",
  locations: [
    DirectiveLocation.FIELD,
    DirectiveLocation.FRAGMENT_SPREAD,
    DirectiveLocation.INLINE_FRAGMENT,
  ],
  args: {
    if: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: "Included when true.",
    },
  },
});

export const GraphQLSkipDirective = new GraphQLDirective({
  name: "skip",
  description:
    "Directs the executor to skip this field or fragment when the `if` argument is true.",
  locations: [
    DirectiveLocation.FIELD,
    DirectiveLocation.FRAGMENT_SPREAD,
    DirectiveLocation.INLINE_FRAGMENT,
  ],
  args: {
    if: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: "Skipped when true.",
    },
  },
});

export const GraphQLDeprecatedDirective = new GraphQLDirective({
  name: "deprecated",
  description:
    "Marks an element of a GraphQL schema as no longer supported.",
  locations: [
    DirectiveLocation.FIELD_DEFINITION,
    DirectiveLocation.ARGUMENT_DEFINITION,
    DirectiveLocation.INPUT_FIELD_DEFINITION,
    DirectiveLocation.ENUM_VALUE,
  ],
  args: {
    reason: {
      type: GraphQLString,
      description:
        "Explains why this element was deprecated, usually also including a suggestion for how to access supported similar data. Formatted using the Markdown syntax, as specified by [CommonMark](https://commonmark.org/).",
      defaultValue: DEFAULT_DEPRECATION_REASON,
    },
  },
});

export const GraphQLSpecifiedByDirective = new GraphQLDirective({
  name: "specifiedBy",
  description: "Exposes a URL that specifies the behavior of this scalar.",
  locations: [DirectiveLocation.SCALAR],
  args: {
    url: {
      type: new GraphQLNonNull(GraphQLString),
      description: "The URL that specifies the behavior of this scalar.",
    },
  },
});

export const GraphQLOneOfDirective = new GraphQLDirective({
  name: "oneOf",
  description:
    "Indicates exactly one field must be supplied and this field must not be `null`.",
  locations: [DirectiveLocation.INPUT_OBJECT],
  args: {},
});

export const specifiedDirectives: readonly GraphQLDirective[] = Object.freeze([
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  GraphQLDeprecatedDirective,
  GraphQLSpecifiedByDirective,
  GraphQLOneOfDirective,
]);

export function isSpecifiedDirective(directive: unknown): boolean {
  if (!isDirective(directive)) return false;
  return specifiedDirectives.some((d) => d.name === directive.name);
}

// ---------------------------------------------------------------------------
// Type Unions
// ---------------------------------------------------------------------------

export type GraphQLNamedType =
  | GraphQLScalarType
  | GraphQLObjectType
  | GraphQLInterfaceType
  | GraphQLUnionType
  | GraphQLEnumType
  | GraphQLInputObjectType;

export type GraphQLNamedInputType =
  | GraphQLScalarType
  | GraphQLEnumType
  | GraphQLInputObjectType;

export type GraphQLNamedOutputType =
  | GraphQLScalarType
  | GraphQLObjectType
  | GraphQLInterfaceType
  | GraphQLUnionType
  | GraphQLEnumType;

export type GraphQLInputType =
  | GraphQLScalarType
  | GraphQLEnumType
  | GraphQLInputObjectType
  | GraphQLList<GraphQLInputType>
  | GraphQLNonNull<
      | GraphQLScalarType
      | GraphQLEnumType
      | GraphQLInputObjectType
      | GraphQLList<GraphQLInputType>
    >;

export type GraphQLOutputType =
  | GraphQLScalarType
  | GraphQLObjectType
  | GraphQLInterfaceType
  | GraphQLUnionType
  | GraphQLEnumType
  | GraphQLList<GraphQLOutputType>
  | GraphQLNonNull<
      | GraphQLScalarType
      | GraphQLObjectType
      | GraphQLInterfaceType
      | GraphQLUnionType
      | GraphQLEnumType
      | GraphQLList<GraphQLOutputType>
    >;

export type GraphQLLeafType = GraphQLScalarType | GraphQLEnumType;

export type GraphQLCompositeType =
  | GraphQLObjectType
  | GraphQLInterfaceType
  | GraphQLUnionType;

export type GraphQLAbstractType = GraphQLInterfaceType | GraphQLUnionType;

export type GraphQLWrappingType =
  | GraphQLList<any>
  | GraphQLNonNull<any>;

export type GraphQLNullableType =
  | GraphQLScalarType
  | GraphQLObjectType
  | GraphQLInterfaceType
  | GraphQLUnionType
  | GraphQLEnumType
  | GraphQLInputObjectType
  | GraphQLList<any>;

export type GraphQLType =
  | GraphQLScalarType
  | GraphQLObjectType
  | GraphQLInterfaceType
  | GraphQLUnionType
  | GraphQLEnumType
  | GraphQLInputObjectType
  | GraphQLList<any>
  | GraphQLNonNull<any>;

// ---------------------------------------------------------------------------
// Type Guards (instanceof + Symbol.toStringTag duck-typing)
// ---------------------------------------------------------------------------

export function isScalarType(type: unknown): type is GraphQLScalarType {
  return (
    type instanceof GraphQLScalarType || getTag(type) === "GraphQLScalarType"
  );
}

export function isObjectType(type: unknown): type is GraphQLObjectType {
  return (
    type instanceof GraphQLObjectType || getTag(type) === "GraphQLObjectType"
  );
}

export function isInterfaceType(type: unknown): type is GraphQLInterfaceType {
  return (
    type instanceof GraphQLInterfaceType ||
    getTag(type) === "GraphQLInterfaceType"
  );
}

export function isUnionType(type: unknown): type is GraphQLUnionType {
  return (
    type instanceof GraphQLUnionType || getTag(type) === "GraphQLUnionType"
  );
}

export function isEnumType(type: unknown): type is GraphQLEnumType {
  return type instanceof GraphQLEnumType || getTag(type) === "GraphQLEnumType";
}

export function isInputObjectType(
  type: unknown,
): type is GraphQLInputObjectType {
  return (
    type instanceof GraphQLInputObjectType ||
    getTag(type) === "GraphQLInputObjectType"
  );
}

export function isListType(type: unknown): type is GraphQLList<any> {
  return type instanceof GraphQLList || getTag(type) === "GraphQLList";
}

export function isNonNullType(type: unknown): type is GraphQLNonNull<any> {
  return type instanceof GraphQLNonNull || getTag(type) === "GraphQLNonNull";
}

export function isDirective(directive: unknown): directive is GraphQLDirective {
  return (
    directive instanceof GraphQLDirective ||
    getTag(directive) === "GraphQLDirective"
  );
}

export function isNamedType(type: unknown): type is GraphQLNamedType {
  return (
    isScalarType(type) ||
    isObjectType(type) ||
    isInterfaceType(type) ||
    isUnionType(type) ||
    isEnumType(type) ||
    isInputObjectType(type)
  );
}

export function isWrappingType(type: unknown): type is GraphQLWrappingType {
  return isListType(type) || isNonNullType(type);
}

export function isType(type: unknown): type is GraphQLType {
  return isNamedType(type) || isWrappingType(type);
}

export function isNullableType(type: unknown): type is GraphQLNullableType {
  return isType(type) && !isNonNullType(type);
}

export function isLeafType(type: unknown): type is GraphQLLeafType {
  return isScalarType(type) || isEnumType(type);
}

export function isCompositeType(type: unknown): type is GraphQLCompositeType {
  return isObjectType(type) || isInterfaceType(type) || isUnionType(type);
}

export function isAbstractType(type: unknown): type is GraphQLAbstractType {
  return isInterfaceType(type) || isUnionType(type);
}

export function isInputType(type: unknown): type is GraphQLInputType {
  return (
    isScalarType(type) ||
    isEnumType(type) ||
    isInputObjectType(type) ||
    (isWrappingType(type) && isInputType(type.ofType))
  );
}

export function isOutputType(type: unknown): type is GraphQLOutputType {
  return (
    isScalarType(type) ||
    isObjectType(type) ||
    isInterfaceType(type) ||
    isUnionType(type) ||
    isEnumType(type) ||
    (isWrappingType(type) && isOutputType(type.ofType))
  );
}

export function isRequiredArgument(arg: GraphQLArgument): boolean {
  return isNonNullType(arg.type) && arg.defaultValue === undefined;
}

export function isRequiredInputField(field: GraphQLInputField): boolean {
  return isNonNullType(field.type) && field.defaultValue === undefined;
}

export function getNullableType<T extends GraphQLType>(
  type: T,
): T extends GraphQLNonNull<infer U> ? U : T;
export function getNullableType(
  type: Maybe<GraphQLType>,
): Maybe<GraphQLNullableType>;
export function getNullableType(
  type: Maybe<GraphQLType>,
): Maybe<GraphQLNullableType> {
  if (!type) return undefined;
  return isNonNullType(type) ? (type.ofType as GraphQLNullableType) : type;
}

export function getNamedType(type: GraphQLType): GraphQLNamedType;
export function getNamedType(
  type: Maybe<GraphQLType>,
): Maybe<GraphQLNamedType>;
export function getNamedType(
  type: Maybe<GraphQLType>,
): Maybe<GraphQLNamedType> {
  if (!type) return undefined;
  let unwrapped: GraphQLType = type;
  while (isWrappingType(unwrapped)) {
    unwrapped = unwrapped.ofType;
  }
  return unwrapped as GraphQLNamedType;
}

// ---------------------------------------------------------------------------
// Type Comparators
// ---------------------------------------------------------------------------

export function isEqualType(typeA: GraphQLType, typeB: GraphQLType): boolean {
  if (typeA === typeB) return true;
  if (isNonNullType(typeA) && isNonNullType(typeB)) {
    return isEqualType(typeA.ofType, typeB.ofType);
  }
  if (isListType(typeA) && isListType(typeB)) {
    return isEqualType(typeA.ofType, typeB.ofType);
  }
  if (isNamedType(typeA) && isNamedType(typeB)) {
    return typeA.name === typeB.name;
  }
  return false;
}

export function isTypeSubTypeOf(
  schema: GraphQLSchema,
  maybeSubType: GraphQLType,
  superType: GraphQLType,
): boolean {
  if (maybeSubType === superType) return true;
  if (isNonNullType(superType)) {
    if (isNonNullType(maybeSubType)) {
      return isTypeSubTypeOf(schema, maybeSubType.ofType, superType.ofType);
    }
    return false;
  }
  if (isNonNullType(maybeSubType)) {
    return isTypeSubTypeOf(schema, maybeSubType.ofType, superType);
  }
  if (isListType(superType)) {
    if (isListType(maybeSubType)) {
      return isTypeSubTypeOf(schema, maybeSubType.ofType, superType.ofType);
    }
    return false;
  }
  if (isListType(maybeSubType)) {
    return false;
  }
  if (isNamedType(maybeSubType) && isNamedType(superType)) {
    if (maybeSubType.name === superType.name) return true;
  }
  return (
    isAbstractType(superType) &&
    (isInterfaceType(maybeSubType) || isObjectType(maybeSubType)) &&
    schema.isSubType(superType, maybeSubType)
  );
}

export function doTypesOverlap(
  schema: GraphQLSchema,
  typeA: GraphQLCompositeType,
  typeB: GraphQLCompositeType,
): boolean {
  if (typeA === typeB || typeA.name === typeB.name) {
    return true;
  }
  if (isAbstractType(typeA)) {
    if (isAbstractType(typeB)) {
      return schema
        .getPossibleTypes(typeA)
        .some((type) => schema.isSubType(typeB, type));
    }
    return schema.isSubType(typeA, typeB);
  }
  if (isAbstractType(typeB)) {
    return schema.isSubType(typeB, typeA);
  }
  return false;
}

// ---------------------------------------------------------------------------
// AST <-> JS Value & Type Conversion
// ---------------------------------------------------------------------------

export function typeFromAST(
  schema: GraphQLSchema,
  typeNode: TypeNode,
): GraphQLType | undefined {
  if (typeNode.kind === Kind.LIST_TYPE) {
    const inner = typeFromAST(schema, typeNode.type);
    return inner ? new GraphQLList(inner) : undefined;
  }
  if (typeNode.kind === Kind.NON_NULL_TYPE) {
    const inner = typeFromAST(schema, typeNode.type);
    return inner && isNullableType(inner)
      ? new GraphQLNonNull(inner)
      : undefined;
  }
  return schema.getType(typeNode.name.value) ?? undefined;
}

/**
 * Produces a JavaScript value given a GraphQL Value AST and target input type.
 * Returns `undefined` when the AST value is invalid for `type`.
 */
export function valueFromAST(
  valueNode: Maybe<ValueNode>,
  type: GraphQLInputType,
  variables?: Maybe<Record<string, unknown>>,
): unknown {
  if (!valueNode) {
    return undefined;
  }

  if (valueNode.kind === Kind.VARIABLE) {
    const variableName = valueNode.name.value;
    if (!variables || !(variableName in variables)) {
      return undefined;
    }
    const variableVal = variables[variableName];
    if (variableVal === null && isNonNullType(type)) {
      return undefined;
    }
    return variableVal;
  }

  if (isNonNullType(type)) {
    if (valueNode.kind === Kind.NULL) {
      return undefined;
    }
    return valueFromAST(valueNode, type.ofType as GraphQLInputType, variables);
  }

  if (valueNode.kind === Kind.NULL) {
    return null;
  }

  if (isListType(type)) {
    const itemType = type.ofType as GraphQLInputType;
    if (valueNode.kind === Kind.LIST) {
      const coercedValues: unknown[] = [];
      for (const itemNode of valueNode.values) {
        if (isMissingVariable(itemNode, variables)) {
          if (isNonNullType(itemType)) {
            return undefined;
          }
          coercedValues.push(null);
        } else {
          const itemValue = valueFromAST(itemNode, itemType, variables);
          if (itemValue === undefined) {
            return undefined;
          }
          coercedValues.push(itemValue);
        }
      }
      return coercedValues;
    }
    const coercedSingle = valueFromAST(valueNode, itemType, variables);
    if (coercedSingle === undefined) {
      return undefined;
    }
    return [coercedSingle];
  }

  if (isInputObjectType(type)) {
    if (valueNode.kind !== Kind.OBJECT) {
      return undefined;
    }
    const coercedObj: Record<string, unknown> = Object.create(null);
    const fieldNodes = new Map(
      valueNode.fields.map((f) => [f.name.value, f]),
    );

    for (const field of Object.values(type.getFields())) {
      const fieldNode = fieldNodes.get(field.name);
      if (!fieldNode || isMissingVariable(fieldNode.value, variables)) {
        if (field.defaultValue !== undefined) {
          coercedObj[field.name] = field.defaultValue;
        } else if (isNonNullType(field.type)) {
          return undefined;
        }
        continue;
      }
      const fieldValue = valueFromAST(fieldNode.value, field.type, variables);
      if (fieldValue === undefined) {
        return undefined;
      }
      coercedObj[field.name] = fieldValue;
    }

    if (type.isOneOf) {
      const keys = Object.keys(coercedObj);
      if (keys.length !== 1 || coercedObj[keys[0]!] === null) {
        return undefined;
      }
    }

    return coercedObj;
  }

  if (isLeafType(type)) {
    try {
      return type.parseLiteral(valueNode, variables);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function isMissingVariable(
  valueNode: ValueNode,
  variables: Maybe<Record<string, unknown>>,
): boolean {
  return (
    valueNode.kind === Kind.VARIABLE &&
    (!variables ||
      !(valueNode.name.value in variables) ||
      variables[valueNode.name.value] === undefined)
  );
}

/**
 * Produces a GraphQL ConstValueNode given a JavaScript value and target input type.
 */
export function astFromValue(
  value: unknown,
  type: GraphQLInputType,
): ConstValueNode | null {
  if (isNonNullType(type)) {
    const astValue = astFromValue(value, type.ofType as GraphQLInputType);
    if (astValue?.kind === Kind.NULL) {
      return null;
    }
    return astValue;
  }

  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return { kind: Kind.NULL };
  }

  if (isListType(type)) {
    const itemType = type.ofType as GraphQLInputType;
    if (Array.isArray(value)) {
      const valuesNodes: ConstValueNode[] = [];
      for (const item of value) {
        const itemNode = astFromValue(item, itemType);
        if (itemNode != null) {
          valuesNodes.push(itemNode);
        }
      }
      return { kind: Kind.LIST, values: valuesNodes };
    }
    return astFromValue(value, itemType);
  }

  if (isInputObjectType(type)) {
    if (typeof value !== "object") {
      return null;
    }
    const fieldNodes: Array<{
      readonly kind: typeof Kind.OBJECT_FIELD;
      readonly name: { readonly kind: typeof Kind.NAME; readonly value: string };
      readonly value: ConstValueNode;
    }> = [];
    for (const field of Object.values(type.getFields())) {
      const fieldValue = astFromValue(
        (value as Record<string, unknown>)[field.name],
        field.type,
      );
      if (fieldValue) {
        fieldNodes.push({
          kind: Kind.OBJECT_FIELD,
          name: { kind: Kind.NAME, value: field.name },
          value: fieldValue,
        });
      }
    }
    return { kind: Kind.OBJECT, fields: fieldNodes };
  }

  if (isLeafType(type)) {
    const serialized = type.serialize(value);
    if (serialized === null || serialized === undefined) {
      return null;
    }
    if (typeof serialized === "boolean") {
      return { kind: Kind.BOOLEAN, value: serialized };
    }
    if (typeof serialized === "number" && Number.isFinite(serialized)) {
      const stringNum = String(serialized);
      return /^-?(?:0|[1-9][0-9]*)$/.test(stringNum)
        ? { kind: Kind.INT, value: stringNum }
        : { kind: Kind.FLOAT, value: stringNum };
    }
    if (typeof serialized === "string") {
      if (isEnumType(type)) {
        return { kind: Kind.ENUM, value: serialized };
      }
      if (type === GraphQLID && /^-?(?:0|[1-9][0-9]*)$/.test(serialized)) {
        return { kind: Kind.STRING, value: serialized };
      }
      return { kind: Kind.STRING, value: serialized };
    }
    throw new TypeError(
      `Cannot convert value to AST: ${JSON.stringify(serialized)}.`,
    );
  }

  return null;
}

/**
 * Coerces a JavaScript runtime value according to a GraphQL Input Type,
 * calling `onError` for every coercion violation.
 */
export function coerceInputValue(
  inputValue: unknown,
  type: GraphQLInputType,
  onError: (
    path: readonly (string | number)[],
    invalidValue: unknown,
    error: GraphQLError,
  ) => void = (_path, _val, err) => {
    throw err;
  },
  path: readonly (string | number)[] = [],
): unknown {
  if (isNonNullType(type)) {
    if (inputValue != null) {
      return coerceInputValue(
        inputValue,
        type.ofType as GraphQLInputType,
        onError,
        path,
      );
    }
    onError(
      path,
      inputValue,
      new GraphQLError(
        `Expected non-nullable type "${String(type)}" not to be null.`,
      ),
    );
    return undefined;
  }

  if (inputValue == null) {
    return null;
  }

  if (isListType(type)) {
    const itemType = type.ofType as GraphQLInputType;
    if (Array.isArray(inputValue)) {
      return inputValue.map((itemValue, index) =>
        coerceInputValue(itemValue, itemType, onError, [...path, index]),
      );
    }
    return [coerceInputValue(inputValue, itemType, onError, path)];
  }

  if (isInputObjectType(type)) {
    if (typeof inputValue !== "object" || Array.isArray(inputValue)) {
      onError(
        path,
        inputValue,
        new GraphQLError(
          `Expected type "${type.name}" to be an object.`,
        ),
      );
      return undefined;
    }

    const coercedValue: Record<string, unknown> = {};
    const fields = type.getFields();
    const record = inputValue as Record<string, unknown>;

    for (const field of Object.values(fields)) {
      const fieldValue = record[field.name];
      if (fieldValue === undefined) {
        if (field.defaultValue !== undefined) {
          coercedValue[field.name] = field.defaultValue;
        } else if (isNonNullType(field.type)) {
          onError(
            [...path, field.name],
            fieldValue,
            new GraphQLError(
              `Field "${field.name}" of required type "${String(field.type)}" was not provided.`,
            ),
          );
        }
      } else {
        coercedValue[field.name] = coerceInputValue(
          fieldValue,
          field.type,
          onError,
          [...path, field.name],
        );
      }
    }

    for (const fieldName of Object.keys(record)) {
      if (!Object.prototype.hasOwnProperty.call(fields, fieldName)) {
        onError(
          [...path, fieldName],
          record[fieldName],
          new GraphQLError(
            `Field "${fieldName}" is not defined by type "${type.name}".`,
          ),
        );
      }
    }

    if (type.isOneOf) {
      const keys = Object.keys(coercedValue);
      if (keys.length !== 1) {
        onError(
          path,
          inputValue,
          new GraphQLError(
            `Exactly one key must be specified for OneOf type "${type.name}".`,
          ),
        );
      } else {
        const key = keys[0]!;
        if (coercedValue[key] === null) {
          onError(
            [...path, key],
            null,
            new GraphQLError(
              `Field "${key}" must be non-null.`,
            ),
          );
        }
      }
    }

    return coercedValue;
  }

  if (isLeafType(type)) {
    try {
      const parseResult = type.parseValue(inputValue);
      if (parseResult === undefined) {
        onError(
          path,
          inputValue,
          new GraphQLError(
            `Expected type "${type.name}".`,
          ),
        );
      }
      return parseResult;
    } catch (err) {
      let gqlErr: GraphQLError;
      if (isGraphQLError(err)) {
        gqlErr = err;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        gqlErr = new GraphQLError(`Expected type "${type.name}". ${msg}`, {
          originalError: err instanceof Error ? err : undefined,
        });
      }
      onError(path, inputValue, gqlErr);
      return undefined;
    }
  }

  return undefined;
}
