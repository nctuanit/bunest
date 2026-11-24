/**
 * GraphQL October 2021 Spec Scalar Types & Built-in Scalars (Int, Float, String, Boolean, ID).
 * Zero external dependencies.
 */

import {
  type ConstValueNode,
  Kind,
  type ScalarTypeDefinitionNode,
  type ScalarTypeExtensionNode,
  type ValueNode,
} from "./ast";
import { GraphQLError } from "./error";
import { print } from "./printer";

export type Maybe<T> = T | null | undefined;

export type GraphQLScalarSerializer<TExternal = unknown> = (
  outputValue: unknown,
) => TExternal;

export type GraphQLScalarValueParser<TInternal = unknown> = (
  inputValue: unknown,
) => TInternal;

export type GraphQLScalarLiteralParser<TInternal = unknown> = (
  valueNode: ValueNode,
  variables?: Maybe<Record<string, unknown>>,
) => TInternal;

export interface GraphQLScalarTypeConfig<TInternal = unknown, TExternal = unknown> {
  readonly name: string;
  readonly description?: Maybe<string>;
  readonly specifiedByURL?: Maybe<string>;
  readonly serialize?: GraphQLScalarSerializer<TExternal>;
  readonly parseValue?: GraphQLScalarValueParser<TInternal>;
  readonly parseLiteral?: GraphQLScalarLiteralParser<TInternal>;
  readonly extensions?: Maybe<Readonly<Record<string, unknown>>>;
  readonly astNode?: Maybe<ScalarTypeDefinitionNode>;
  readonly extensionASTNodes?: Maybe<readonly ScalarTypeExtensionNode[]>;
}

export interface GraphQLScalarTypeNormalizedConfig<
  TInternal = unknown,
  TExternal = unknown,
> {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly specifiedByURL: Maybe<string>;
  readonly serialize: GraphQLScalarSerializer<TExternal>;
  readonly parseValue: GraphQLScalarValueParser<TInternal>;
  readonly parseLiteral: GraphQLScalarLiteralParser<TInternal>;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly astNode: Maybe<ScalarTypeDefinitionNode>;
  readonly extensionASTNodes: readonly ScalarTypeExtensionNode[];
}

/**
 * Evaluates a GraphQL AST ValueNode without schema type information.
 */
export function valueFromASTUntyped(
  valueNode: ValueNode | ConstValueNode,
  variables?: Maybe<Record<string, unknown>>,
): unknown {
  switch (valueNode.kind) {
    case Kind.NULL:
      return null;
    case Kind.INT:
      return Number.parseInt(valueNode.value, 10);
    case Kind.FLOAT:
      return Number.parseFloat(valueNode.value);
    case Kind.STRING:
    case Kind.ENUM:
    case Kind.BOOLEAN:
      return valueNode.value;
    case Kind.LIST:
      return valueNode.values.map((node) =>
        valueFromASTUntyped(node, variables),
      );
    case Kind.OBJECT: {
      const obj: Record<string, unknown> = Object.create(null);
      for (const field of valueNode.fields) {
        obj[field.name.value] = valueFromASTUntyped(field.value, variables);
      }
      return obj;
    }
    case Kind.VARIABLE:
      return variables?.[valueNode.name.value];
  }
}

function inspectVal(val: unknown): string {
  if (typeof val === "string") return JSON.stringify(val);
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  if (typeof val === "object") {
    try {
      return JSON.stringify(val);
    } catch {
      return Object.prototype.toString.call(val);
    }
  }
  return String(val);
}

function serializeObject(outputValue: unknown): unknown {
  if (
    outputValue !== null &&
    typeof outputValue === "object" &&
    "valueOf" in outputValue &&
    typeof (outputValue as { valueOf: () => unknown }).valueOf === "function"
  ) {
    const val = (outputValue as { valueOf: () => unknown }).valueOf();
    if (val !== outputValue) {
      return val;
    }
  }
  return outputValue;
}

export class GraphQLScalarType<TInternal = unknown, TExternal = unknown> {
  readonly name: string;
  readonly description: Maybe<string>;
  readonly specifiedByURL: Maybe<string>;
  readonly serialize: GraphQLScalarSerializer<TExternal>;
  readonly parseValue: GraphQLScalarValueParser<TInternal>;
  readonly parseLiteral: GraphQLScalarLiteralParser<TInternal>;
  extensions: Record<string, unknown>;
  readonly astNode: Maybe<ScalarTypeDefinitionNode>;
  readonly extensionASTNodes: readonly ScalarTypeExtensionNode[];

  constructor(config: GraphQLScalarTypeConfig<TInternal, TExternal>) {
    this.name = config.name;
    this.description = config.description;
    this.specifiedByURL = config.specifiedByURL;
    this.serialize =
      config.serialize ?? ((value: unknown) => value as TExternal);
    const parseValue =
      config.parseValue ?? ((value: unknown) => value as TInternal);
    this.parseValue = parseValue;
    this.parseLiteral =
      config.parseLiteral ??
      ((node, variables) =>
        parseValue(valueFromASTUntyped(node, variables)));
    this.extensions = config.extensions ? { ...config.extensions } : {};
    this.astNode = config.astNode;
    this.extensionASTNodes = config.extensionASTNodes ?? [];
  }

  get [Symbol.toStringTag](): string {
    return "GraphQLScalarType";
  }

  toConfig(): GraphQLScalarTypeNormalizedConfig<TInternal, TExternal> {
    return {
      name: this.name,
      description: this.description,
      specifiedByURL: this.specifiedByURL,
      serialize: this.serialize,
      parseValue: this.parseValue,
      parseLiteral: this.parseLiteral,
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

// Signed 32-bit integer range per GraphQL Spec
const MAX_INT = 2147483647;
const MIN_INT = -2147483648;

function isInteger(num: number): boolean {
  return Number.isFinite(num) && Math.floor(num) === num;
}

export const GraphQLInt = new GraphQLScalarType<number, number>({
  name: "Int",
  description:
    "The `Int` scalar type represents non-fractional signed whole numeric values. Int can represent values between -(2^31) and 2^31 - 1.",
  serialize(outputValue: unknown): number {
    const coercedValue = serializeObject(outputValue);
    if (typeof coercedValue === "boolean") {
      return coercedValue ? 1 : 0;
    }
    let num = coercedValue;
    if (typeof coercedValue === "string" && coercedValue !== "") {
      num = Number(coercedValue);
    }
    if (typeof num !== "number" || !isInteger(num)) {
      throw new GraphQLError(
        `Int cannot represent non-integer value: ${inspectVal(coercedValue)}`,
      );
    }
    if (num > MAX_INT || num < MIN_INT) {
      throw new GraphQLError(
        `Int cannot represent non 32-bit signed integer value: ${inspectVal(coercedValue)}`,
      );
    }
    return num;
  },
  parseValue(inputValue: unknown): number {
    if (typeof inputValue !== "number" || !isInteger(inputValue)) {
      throw new GraphQLError(
        `Int cannot represent non-integer value: ${inspectVal(inputValue)}`,
      );
    }
    if (inputValue > MAX_INT || inputValue < MIN_INT) {
      throw new GraphQLError(
        `Int cannot represent non 32-bit signed integer value: ${inputValue}`,
      );
    }
    return inputValue;
  },
  parseLiteral(valueNode: ValueNode): number {
    if (valueNode.kind !== Kind.INT) {
      throw new GraphQLError(
        `Int cannot represent non-integer value: ${print(valueNode)}`,
        { nodes: valueNode },
      );
    }
    const num = Number.parseInt(valueNode.value, 10);
    if (num > MAX_INT || num < MIN_INT) {
      throw new GraphQLError(
        `Int cannot represent non 32-bit signed integer value: ${valueNode.value}`,
        { nodes: valueNode },
      );
    }
    return num;
  },
});

export const GraphQLFloat = new GraphQLScalarType<number, number>({
  name: "Float",
  description:
    "The `Float` scalar type represents signed double-precision fractional values as specified by [IEEE 754](https://en.wikipedia.org/wiki/IEEE_floating_point).",
  serialize(outputValue: unknown): number {
    const coercedValue = serializeObject(outputValue);
    if (typeof coercedValue === "boolean") {
      return coercedValue ? 1 : 0;
    }
    let num = coercedValue;
    if (typeof coercedValue === "string" && coercedValue !== "") {
      num = Number(coercedValue);
    }
    if (typeof num !== "number" || !Number.isFinite(num)) {
      throw new GraphQLError(
        `Float cannot represent non numeric value: ${inspectVal(coercedValue)}`,
      );
    }
    return num;
  },
  parseValue(inputValue: unknown): number {
    if (typeof inputValue !== "number" || !Number.isFinite(inputValue)) {
      throw new GraphQLError(
        `Float cannot represent non numeric value: ${inspectVal(inputValue)}`,
      );
    }
    return inputValue;
  },
  parseLiteral(valueNode: ValueNode): number {
    if (valueNode.kind !== Kind.FLOAT && valueNode.kind !== Kind.INT) {
      throw new GraphQLError(
        `Float cannot represent non numeric value: ${print(valueNode)}`,
        { nodes: valueNode },
      );
    }
    return Number.parseFloat(valueNode.value);
  },
});

export const GraphQLString = new GraphQLScalarType<string, string>({
  name: "String",
  description:
    "The `String` scalar type represents textual data, represented as UTF-8 character sequences. The String type is most often used by GraphQL to represent free-form human-readable text.",
  serialize(outputValue: unknown): string {
    const coercedValue = serializeObject(outputValue);
    if (typeof coercedValue === "string") {
      return coercedValue;
    }
    if (typeof coercedValue === "boolean") {
      return coercedValue ? "true" : "false";
    }
    if (typeof coercedValue === "number" && Number.isFinite(coercedValue)) {
      return coercedValue.toString();
    }
    throw new GraphQLError(
      `String cannot represent value: ${inspectVal(outputValue)}`,
    );
  },
  parseValue(inputValue: unknown): string {
    if (typeof inputValue !== "string") {
      throw new GraphQLError(
        `String cannot represent a non string value: ${inspectVal(inputValue)}`,
      );
    }
    return inputValue;
  },
  parseLiteral(valueNode: ValueNode): string {
    if (valueNode.kind !== Kind.STRING) {
      throw new GraphQLError(
        `String cannot represent a non string value: ${print(valueNode)}`,
        { nodes: valueNode },
      );
    }
    return valueNode.value;
  },
});

export const GraphQLBoolean = new GraphQLScalarType<boolean, boolean>({
  name: "Boolean",
  description: "The `Boolean` scalar type represents `true` or `false`.",
  serialize(outputValue: unknown): boolean {
    const coercedValue = serializeObject(outputValue);
    if (typeof coercedValue === "boolean") {
      return coercedValue;
    }
    if (typeof coercedValue === "number" && Number.isFinite(coercedValue)) {
      return coercedValue !== 0;
    }
    throw new GraphQLError(
      `Boolean cannot represent a non boolean value: ${inspectVal(coercedValue)}`,
    );
  },
  parseValue(inputValue: unknown): boolean {
    if (typeof inputValue !== "boolean") {
      throw new GraphQLError(
        `Boolean cannot represent a non boolean value: ${inspectVal(inputValue)}`,
      );
    }
    return inputValue;
  },
  parseLiteral(valueNode: ValueNode): boolean {
    if (valueNode.kind !== Kind.BOOLEAN) {
      throw new GraphQLError(
        `Boolean cannot represent a non boolean value: ${print(valueNode)}`,
        { nodes: valueNode },
      );
    }
    return valueNode.value;
  },
});

export const GraphQLID = new GraphQLScalarType<string, string>({
  name: "ID",
  description:
    'The `ID` scalar type represents a unique identifier, often used to refetch an object or as key for a cache. The ID type appears in a JSON response as a String; however, it is not intended to be human-readable. When expected as an input type, any string (such as `"4"`) or integer (such as `4`) input value will be accepted as an ID.',
  serialize(outputValue: unknown): string {
    const coercedValue = serializeObject(outputValue);
    if (typeof coercedValue === "string") {
      return coercedValue;
    }
    if (typeof coercedValue === "number" && isInteger(coercedValue)) {
      return coercedValue.toString();
    }
    throw new GraphQLError(
      `ID cannot represent value: ${inspectVal(outputValue)}`,
    );
  },
  parseValue(inputValue: unknown): string {
    if (typeof inputValue === "string") {
      return inputValue;
    }
    if (typeof inputValue === "number" && isInteger(inputValue)) {
      return inputValue.toString();
    }
    throw new GraphQLError(
      `ID cannot represent value: ${inspectVal(inputValue)}`,
    );
  },
  parseLiteral(valueNode: ValueNode): string {
    if (valueNode.kind !== Kind.STRING && valueNode.kind !== Kind.INT) {
      throw new GraphQLError(
        `ID cannot represent a non-string and non-integer value: ${print(valueNode)}`,
        { nodes: valueNode },
      );
    }
    return valueNode.value;
  },
});

export const specifiedScalarTypes: readonly GraphQLScalarType[] = Object.freeze([
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLID,
]);

export function isSpecifiedScalarType(type: unknown): boolean {
  if (!type || typeof type !== "object") return false;
  const name = (type as { name?: unknown }).name;
  return (
    name === "String" ||
    name === "Int" ||
    name === "Float" ||
    name === "Boolean" ||
    name === "ID"
  );
}
