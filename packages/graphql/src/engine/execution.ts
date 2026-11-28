/**
 * GraphQL October 2021 Spec Execution & Subscription Engine.
 * Supports:
 * - Full variable coercion & defaults (`getVariableValues`)
 * - Argument & directive evaluation (`@skip`, `@include`)
 * - Fragment spreads, inline fragments & merged sub-selections
 * - Abstract type resolution (`resolveType` returning string OR ObjectType, `isTypeOf`, `__typename`)
 * - Introspection meta-fields (`__schema`, `__type`, `__typename`)
 * - Spec-compliant Non-Null error bubbling across fields & lists
 * - Zero-extra-microtask sync fast path preserving DataLoader batching in a single tick
 * - Full AsyncIterable `subscribe()` & `createSourceEventStream()` with clean `return()` teardown
 * Zero external dependencies.
 */

import { isPromiseLike } from "@bunest/core/common";
import {
  type DirectiveNode,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type FragmentSpreadNode,
  type InlineFragmentNode,
  Kind,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type Source,
  type VariableDefinitionNode,
} from "./ast";
import { GraphQLError, isGraphQLError, locatedError } from "./error";
import {
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef,
} from "./introspection";
import { parse } from "./parser";
import type { Maybe } from "./scalars";
import type { GraphQLSchema } from "./schema";
import { validate } from "./validation";
import {
  addPath,
  coerceInputValue,
  type GraphQLAbstractType,
  type GraphQLDirective,
  type GraphQLField,
  type GraphQLFieldResolver,
  GraphQLIncludeDirective,
  type GraphQLInputType,
  type GraphQLList,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLResolveInfo,
  GraphQLSkipDirective,
  type GraphQLTypeResolver,
  isAbstractType,
  isInputType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  pathToArray,
  type ResponsePath,
  typeFromAST,
  valueFromAST,
} from "./types";

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export interface ExecutionResult<
  TData = Record<string, unknown>,
  TExtensions = Record<string, unknown>,
> {
  errors?: readonly GraphQLError[];
  data?: TData | null;
  extensions?: TExtensions;
}

export interface ExecutionArgs {
  schema: GraphQLSchema;
  document: DocumentNode;
  rootValue?: unknown;
  contextValue?: unknown;
  variableValues?: Maybe<Record<string, unknown>>;
  operationName?: Maybe<string>;
  fieldResolver?: Maybe<GraphQLFieldResolver<any, any>>;
  typeResolver?: Maybe<GraphQLTypeResolver<any, any>>;
  subscribeFieldResolver?: Maybe<GraphQLFieldResolver<any, any>>;
}

interface ExecutionContext {
  readonly schema: GraphQLSchema;
  readonly fragments: Record<string, FragmentDefinitionNode>;
  readonly rootValue: unknown;
  readonly contextValue: unknown;
  readonly operation: OperationDefinitionNode;
  readonly variableValues: Record<string, unknown>;
  readonly fieldResolver: GraphQLFieldResolver<any, any>;
  readonly typeResolver: GraphQLTypeResolver<any, any>;
  readonly subscribeFieldResolver: GraphQLFieldResolver<any, any>;
  readonly errors: GraphQLError[];
}

function isPromise<T>(value: unknown): value is Promise<T> {
  return isPromiseLike(value);
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
  );
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === "function"
  );
}

// ---------------------------------------------------------------------------
// Variable, Argument & Directive Value Coercion
// ---------------------------------------------------------------------------

export function getVariableValues(
  schema: GraphQLSchema,
  varDefNodes: readonly VariableDefinitionNode[],
  inputs: Record<string, unknown>,
  options?: { readonly maxErrors?: number },
):
  | { readonly errors: readonly GraphQLError[]; readonly coerced?: undefined }
  | { readonly coerced: Record<string, unknown>; readonly errors?: undefined } {
  const errors: GraphQLError[] = [];
  const maxErrors = options?.maxErrors;
  const coercedValues: Record<string, unknown> = Object.create(null);

  const onError = (err: GraphQLError): boolean => {
    if (maxErrors !== undefined && errors.length >= maxErrors) {
      errors.push(
        new GraphQLError(
          "Too many errors processing variables, error limit reached. Execution aborted.",
        ),
      );
      return true;
    }
    errors.push(err);
    return false;
  };

  for (const varDefNode of varDefNodes) {
    const varName = varDefNode.variable.name.value;
    const varType = typeFromAST(schema, varDefNode.type);

    if (!isInputType(varType)) {
      if (
        onError(
          new GraphQLError(
            `Variable "$${varName}" expected value of type "${String(varType ?? varDefNode.type)}" which cannot be used as an input type.`,
            { nodes: varDefNode.type },
          ),
        )
      ) {
        return { errors };
      }
      continue;
    }

    const hasValue =
      inputs != null &&
      Object.prototype.hasOwnProperty.call(inputs, varName) &&
      inputs[varName] !== undefined;

    if (!hasValue) {
      if (varDefNode.defaultValue) {
        coercedValues[varName] = valueFromAST(varDefNode.defaultValue, varType);
      } else if (isNonNullType(varType)) {
        if (
          onError(
            new GraphQLError(
              `Variable "$${varName}" of required type "${String(varType)}" was not provided.`,
              { nodes: varDefNode },
            ),
          )
        ) {
          return { errors };
        }
      }
      continue;
    }

    const value = inputs[varName];
    if (value === null && isNonNullType(varType)) {
      if (
        onError(
          new GraphQLError(
            `Variable "$${varName}" of non-null type "${String(varType)}" must not be null.`,
            { nodes: varDefNode },
          ),
        )
      ) {
        return { errors };
      }
      continue;
    }

    let aborted = false;
    coercedValues[varName] = coerceInputValue(
      value,
      varType as GraphQLInputType,
      (path, invalidValue, error) => {
        if (aborted) return;
        let prefix = `Variable "$${varName}" got invalid value ${JSON.stringify(invalidValue)}`;
        if (path.length > 0) {
          prefix += ` at "${varName}.${path.join(".")}"`;
        }
        aborted = onError(
          new GraphQLError(`${prefix}; ${error.message}`, {
            nodes: varDefNode,
            originalError: error.originalError ?? error,
          }),
        );
      },
    );
    if (aborted) {
      return { errors };
    }
  }

  if (errors.length > 0) {
    return { errors };
  }
  return { coerced: coercedValues };
}

export function getArgumentValues(
  def: GraphQLField<any, any> | GraphQLDirective,
  node: FieldNode | DirectiveNode,
  variableValues?: Maybe<Record<string, unknown>>,
): Record<string, unknown> {
  const coercedValues: Record<string, unknown> = {};
  const argumentNodes = node.arguments ?? [];
  const argNodeMap = new Map(argumentNodes.map((arg) => [arg.name.value, arg]));

  for (const argDef of def.args) {
    const name = argDef.name;
    const argType = argDef.type;
    const argumentNode = argNodeMap.get(name);

    if (!argumentNode) {
      if (argDef.defaultValue !== undefined) {
        coercedValues[name] = argDef.defaultValue;
      } else if (isNonNullType(argType)) {
        throw new GraphQLError(
          `Argument "${name}" of required type "${String(argType)}" was not provided.`,
          { nodes: node },
        );
      }
      continue;
    }

    const valueNode = argumentNode.value;
    let isNull = valueNode.kind === Kind.NULL;

    if (valueNode.kind === Kind.VARIABLE) {
      const variableName = valueNode.name.value;
      if (
        variableValues == null ||
        !Object.prototype.hasOwnProperty.call(variableValues, variableName) ||
        variableValues[variableName] === undefined
      ) {
        if (argDef.defaultValue !== undefined) {
          coercedValues[name] = argDef.defaultValue;
        } else if (isNonNullType(argType)) {
          throw new GraphQLError(
            `Argument "${name}" of required type "${String(argType)}" was provided the variable "$${variableName}" which was not provided a runtime value.`,
            { nodes: valueNode },
          );
        }
        continue;
      }
      isNull = variableValues[variableName] === null;
    }

    if (isNull && isNonNullType(argType)) {
      throw new GraphQLError(
        `Argument "${name}" of non-null type "${String(argType)}" must not be null.`,
        { nodes: valueNode },
      );
    }

    const coercedValue = valueFromAST(valueNode, argType, variableValues);
    if (coercedValue === undefined) {
      throw new GraphQLError(
        `Argument "${name}" has invalid value.`,
        { nodes: valueNode },
      );
    }
    coercedValues[name] = coercedValue;
  }

  return coercedValues;
}

export function getDirectiveValues(
  directiveDef: GraphQLDirective,
  node: { readonly directives?: readonly DirectiveNode[] },
  variableValues?: Maybe<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const directiveNode = node.directives?.find(
    (d) => d.name.value === directiveDef.name,
  );
  if (directiveNode) {
    return getArgumentValues(directiveDef, directiveNode, variableValues);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Default Field & Abstract Type Resolvers
// ---------------------------------------------------------------------------

export const defaultFieldResolver: GraphQLFieldResolver<any, any> = (
  source,
  args,
  contextValue,
  info,
) => {
  if (
    (typeof source === "object" && source !== null) ||
    typeof source === "function"
  ) {
    const property = (source as Record<string, unknown>)[info.fieldName];
    if (typeof property === "function") {
      return property.call(source, args, contextValue, info);
    }
    return property;
  }
  return undefined;
};

export const defaultTypeResolver: GraphQLTypeResolver<any, any> = (
  value,
  contextValue,
  info,
  abstractType,
) => {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { __typename?: unknown }).__typename === "string"
  ) {
    return (value as { __typename: string }).__typename;
  }

  const possibleTypes = info.schema.getPossibleTypes(abstractType);
  const promisedIsTypeOfResults: Promise<boolean>[] = [];

  for (let i = 0; i < possibleTypes.length; i++) {
    const type = possibleTypes[i]!;
    if (type.isTypeOf) {
      const isTypeOfResult = type.isTypeOf(value, contextValue, info);
      if (isPromise<boolean>(isTypeOfResult)) {
        promisedIsTypeOfResults[i] = isTypeOfResult;
      } else if (isTypeOfResult) {
        return type.name;
      }
    }
  }

  if (promisedIsTypeOfResults.length > 0) {
    return Promise.all(promisedIsTypeOfResults).then((resolved) => {
      for (let i = 0; i < resolved.length; i++) {
        if (resolved[i]) {
          return possibleTypes[i]!.name;
        }
      }
      return undefined;
    });
  }

  return undefined;
};

// ---------------------------------------------------------------------------
// Execution Context & Field Collection
// ---------------------------------------------------------------------------

function buildExecutionContext(
  args: ExecutionArgs,
): ExecutionContext | readonly GraphQLError[] {
  const {
    schema,
    document,
    rootValue,
    contextValue,
    variableValues: rawVariableValues,
    operationName,
    fieldResolver,
    typeResolver,
    subscribeFieldResolver,
  } = args;

  let operation: OperationDefinitionNode | undefined;
  const fragments: Record<string, FragmentDefinitionNode> = Object.create(null);

  for (const definition of document.definitions) {
    switch (definition.kind) {
      case Kind.OPERATION_DEFINITION:
        if (operationName == null) {
          if (operation !== undefined) {
            return [
              new GraphQLError(
                "Must provide operation name if query contains multiple operations.",
              ),
            ];
          }
          operation = definition;
        } else if (definition.name?.value === operationName) {
          operation = definition;
        }
        break;
      case Kind.FRAGMENT_DEFINITION:
        fragments[definition.name.value] = definition;
        break;
    }
  }

  if (!operation) {
    if (operationName != null) {
      return [new GraphQLError(`Unknown operation named "${operationName}".`)];
    }
    return [new GraphQLError("Must provide an operation.")];
  }

  const coercedVariableValues = getVariableValues(
    schema,
    operation.variableDefinitions ?? [],
    rawVariableValues ?? Object.create(null),
  );
  if (coercedVariableValues.errors) {
    return coercedVariableValues.errors;
  }

  return {
    schema,
    fragments,
    rootValue,
    contextValue,
    operation,
    variableValues: coercedVariableValues.coerced,
    fieldResolver: fieldResolver ?? defaultFieldResolver,
    typeResolver: typeResolver ?? defaultTypeResolver,
    subscribeFieldResolver: subscribeFieldResolver ?? defaultFieldResolver,
    errors: [],
  };
}

function shouldIncludeNode(
  exeContext: ExecutionContext,
  node: FieldNode | FragmentSpreadNode | InlineFragmentNode,
): boolean {
  const skip = getDirectiveValues(
    GraphQLSkipDirective,
    node,
    exeContext.variableValues,
  );
  if (skip?.if === true) {
    return false;
  }
  const include = getDirectiveValues(
    GraphQLIncludeDirective,
    node,
    exeContext.variableValues,
  );
  if (include?.if === false) {
    return false;
  }
  return true;
}

function doesFragmentConditionMatch(
  exeContext: ExecutionContext,
  fragment: FragmentDefinitionNode | InlineFragmentNode,
  type: GraphQLObjectType,
): boolean {
  const typeConditionNode = fragment.typeCondition;
  if (!typeConditionNode) {
    return true;
  }
  const conditionalType = typeFromAST(exeContext.schema, typeConditionNode);
  if (!conditionalType) {
    return false;
  }
  if (conditionalType === type || (isObjectType(conditionalType) && conditionalType.name === type.name)) {
    return true;
  }
  if (isAbstractType(conditionalType)) {
    return exeContext.schema.isSubType(conditionalType, type);
  }
  return false;
}

function collectFields(
  exeContext: ExecutionContext,
  runtimeType: GraphQLObjectType,
  selectionSet: SelectionSetNode,
  fields: Map<string, FieldNode[]>,
  visitedFragmentNames: Set<string>,
): Map<string, FieldNode[]> {
  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        if (!shouldIncludeNode(exeContext, selection)) continue;
        const responseKey = selection.alias?.value ?? selection.name.value;
        let list = fields.get(responseKey);
        if (!list) {
          list = [];
          fields.set(responseKey, list);
        }
        list.push(selection);
        break;
      }
      case Kind.INLINE_FRAGMENT: {
        if (
          !shouldIncludeNode(exeContext, selection) ||
          !doesFragmentConditionMatch(exeContext, selection, runtimeType)
        ) {
          continue;
        }
        collectFields(
          exeContext,
          runtimeType,
          selection.selectionSet,
          fields,
          visitedFragmentNames,
        );
        break;
      }
      case Kind.FRAGMENT_SPREAD: {
        const fragName = selection.name.value;
        if (
          visitedFragmentNames.has(fragName) ||
          !shouldIncludeNode(exeContext, selection)
        ) {
          continue;
        }
        visitedFragmentNames.add(fragName);
        const fragment = exeContext.fragments[fragName];
        if (
          !fragment ||
          !doesFragmentConditionMatch(exeContext, fragment, runtimeType)
        ) {
          continue;
        }
        collectFields(
          exeContext,
          runtimeType,
          fragment.selectionSet,
          fields,
          visitedFragmentNames,
        );
        break;
      }
    }
  }
  return fields;
}

function collectSubfields(
  exeContext: ExecutionContext,
  returnType: GraphQLObjectType,
  fieldNodes: readonly FieldNode[],
): Map<string, FieldNode[]> {
  const subFieldNodes = new Map<string, FieldNode[]>();
  const visitedFragmentNames = new Set<string>();
  for (const node of fieldNodes) {
    if (node.selectionSet) {
      collectFields(
        exeContext,
        returnType,
        node.selectionSet,
        subFieldNodes,
        visitedFragmentNames,
      );
    }
  }
  return subFieldNodes;
}

function getFieldDef(
  schema: GraphQLSchema,
  parentType: GraphQLObjectType,
  fieldNode: FieldNode,
): Maybe<GraphQLField<any, any>> {
  const name = fieldNode.name.value;
  if (name === SchemaMetaFieldDef.name && schema.getQueryType() === parentType) {
    return SchemaMetaFieldDef;
  }
  if (name === TypeMetaFieldDef.name && schema.getQueryType() === parentType) {
    return TypeMetaFieldDef;
  }
  if (name === TypeNameMetaFieldDef.name) {
    return TypeNameMetaFieldDef;
  }
  return parentType.getFields()[name];
}

// ---------------------------------------------------------------------------
// Core Execution Algorithms (Sync Fast-Path + Async Promise Coordination)
// ---------------------------------------------------------------------------

function executeFields(
  exeContext: ExecutionContext,
  parentType: GraphQLObjectType,
  sourceValue: unknown,
  path: ResponsePath | undefined,
  fields: Map<string, FieldNode[]>,
): Promise<Record<string, unknown>> | Record<string, unknown> {
  const results: Record<string, unknown> = Object.create(null);
  let containsPromise = false;

  for (const [responseName, fieldNodes] of fields.entries()) {
    const fieldPath = addPath(path, responseName, parentType.name);
    const result = executeField(
      exeContext,
      parentType,
      sourceValue,
      fieldNodes,
      fieldPath,
    );
    if (result !== undefined) {
      results[responseName] = result;
      if (isPromise(result)) {
        containsPromise = true;
      }
    }
  }

  if (!containsPromise) {
    return results;
  }

  return resolvePromiseObject(results);
}

async function resolvePromiseObject(
  obj: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const keys = Object.keys(obj);
  const values = await Promise.all(keys.map((k) => obj[k]));
  const resolved: Record<string, unknown> = Object.create(null);
  for (let i = 0; i < keys.length; i++) {
    resolved[keys[i]!] = values[i];
  }
  return resolved;
}

async function executeFieldsSerially(
  exeContext: ExecutionContext,
  parentType: GraphQLObjectType,
  sourceValue: unknown,
  path: ResponsePath | undefined,
  fields: Map<string, FieldNode[]>,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = Object.create(null);
  for (const [responseName, fieldNodes] of fields.entries()) {
    const fieldPath = addPath(path, responseName, parentType.name);
    const result = executeField(
      exeContext,
      parentType,
      sourceValue,
      fieldNodes,
      fieldPath,
    );
    if (result !== undefined) {
      results[responseName] = isPromise(result) ? await result : result;
    }
  }
  return results;
}

function executeField(
  exeContext: ExecutionContext,
  parentType: GraphQLObjectType,
  source: unknown,
  fieldNodes: readonly FieldNode[],
  path: ResponsePath,
): unknown {
  const fieldNode = fieldNodes[0]!;
  const fieldDef = getFieldDef(exeContext.schema, parentType, fieldNode);
  if (!fieldDef) {
    return undefined;
  }

  const returnType = fieldDef.type;
  const resolveFn = fieldDef.resolve ?? exeContext.fieldResolver;

  const info: GraphQLResolveInfo = {
    fieldName: fieldDef.name,
    fieldNodes,
    returnType,
    parentType,
    path,
    schema: exeContext.schema,
    fragments: exeContext.fragments,
    rootValue: exeContext.rootValue,
    operation: exeContext.operation,
    variableValues: exeContext.variableValues,
  };

  try {
    const args = getArgumentValues(
      fieldDef,
      fieldNode,
      exeContext.variableValues,
    );
    const result = resolveFn(source, args, exeContext.contextValue, info);
    if (isPromise(result)) {
      return result
        .then((resolved) =>
          completeValue(exeContext, returnType, fieldNodes, info, path, resolved),
        )
        .catch((rawError) =>
          handleFieldError(
            locatedError(rawError, fieldNodes, pathToArray(path)),
            returnType,
            exeContext,
          ),
        );
    }
    const completed = completeValue(
      exeContext,
      returnType,
      fieldNodes,
      info,
      path,
      result,
    );
    if (isPromise(completed)) {
      return completed.catch((rawError) =>
        handleFieldError(
          locatedError(rawError, fieldNodes, pathToArray(path)),
          returnType,
          exeContext,
        ),
      );
    }
    return completed;
  } catch (rawError) {
    return handleFieldError(
      locatedError(rawError, fieldNodes, pathToArray(path)),
      returnType,
      exeContext,
    );
  }
}

function handleFieldError(
  locatedErr: GraphQLError,
  returnType: GraphQLOutputType,
  exeContext: ExecutionContext,
): null {
  if (isNonNullType(returnType)) {
    throw locatedErr;
  }
  exeContext.errors.push(locatedErr);
  return null;
}

function completeValue(
  exeContext: ExecutionContext,
  returnType: GraphQLOutputType,
  fieldNodes: readonly FieldNode[],
  info: GraphQLResolveInfo,
  path: ResponsePath,
  result: unknown,
): unknown {
  if (result instanceof Error) {
    throw result;
  }

  if (isNonNullType(returnType)) {
    const completed = completeValue(
      exeContext,
      returnType.ofType as GraphQLOutputType,
      fieldNodes,
      info,
      path,
      result,
    );
    if (completed === null) {
      throw new Error(
        `Cannot return null for non-nullable field ${info.parentType.name}.${info.fieldName}.`,
      );
    }
    return completed;
  }

  if (result === null || result === undefined) {
    return null;
  }

  if (isListType(returnType)) {
    return completeListValue(
      exeContext,
      returnType,
      fieldNodes,
      info,
      path,
      result,
    );
  }

  if (isLeafType(returnType)) {
    const serialized = returnType.serialize(result);
    if (serialized === null || serialized === undefined) {
      throw new Error(
        `Expected \`${String(returnType)}.serialize(${JSON.stringify(result)})\` to return non-nullable value, returned: ${String(serialized)}`,
      );
    }
    return serialized;
  }

  if (isAbstractType(returnType)) {
    return completeAbstractValue(
      exeContext,
      returnType,
      fieldNodes,
      info,
      path,
      result,
    );
  }

  if (isObjectType(returnType)) {
    return completeObjectValue(
      exeContext,
      returnType,
      fieldNodes,
      info,
      path,
      result,
    );
  }

  throw new Error(`Cannot complete value of unexpected output type: ${String(returnType)}`);
}

function completeListValue(
  exeContext: ExecutionContext,
  returnType: GraphQLList<GraphQLOutputType>,
  fieldNodes: readonly FieldNode[],
  info: GraphQLResolveInfo,
  path: ResponsePath,
  result: unknown,
): unknown {
  if (typeof result === "string" || !isIterable(result)) {
    throw new GraphQLError(
      `Expected Iterable, but did not find one for field "${info.parentType.name}.${info.fieldName}".`,
    );
  }

  const itemType = returnType.ofType;
  let containsPromise = false;
  const completedResults: unknown[] = [];
  let index = 0;

  for (const item of result) {
    const itemPath = addPath(path, index, undefined);
    index++;

    if (isPromise(item)) {
      containsPromise = true;
      completedResults.push(
        item
          .then((resolved) =>
            completeValue(exeContext, itemType, fieldNodes, info, itemPath, resolved),
          )
          .catch((rawError) =>
            handleFieldError(
              locatedError(rawError, fieldNodes, pathToArray(itemPath)),
              itemType,
              exeContext,
            ),
          ),
      );
    } else {
      try {
        const completedItem = completeValue(
          exeContext,
          itemType,
          fieldNodes,
          info,
          itemPath,
          item,
        );
        if (isPromise(completedItem)) {
          containsPromise = true;
          completedResults.push(
            completedItem.catch((rawError) =>
              handleFieldError(
                locatedError(rawError, fieldNodes, pathToArray(itemPath)),
                itemType,
                exeContext,
              ),
            ),
          );
        } else {
          completedResults.push(completedItem);
        }
      } catch (rawError) {
        completedResults.push(
          handleFieldError(
            locatedError(rawError, fieldNodes, pathToArray(itemPath)),
            itemType,
            exeContext,
          ),
        );
      }
    }
  }

  return containsPromise ? Promise.all(completedResults) : completedResults;
}

function completeAbstractValue(
  exeContext: ExecutionContext,
  returnType: GraphQLAbstractType,
  fieldNodes: readonly FieldNode[],
  info: GraphQLResolveInfo,
  path: ResponsePath,
  result: unknown,
): unknown {
  const resolveTypeFn = returnType.resolveType ?? exeContext.typeResolver;
  const runtimeTypeNameOrObj = resolveTypeFn(
    result,
    exeContext.contextValue,
    info,
    returnType,
  );

  if (isPromise(runtimeTypeNameOrObj)) {
    return runtimeTypeNameOrObj.then((resolved) =>
      completeObjectValue(
        exeContext,
        ensureValidRuntimeType(
          resolved,
          exeContext,
          returnType,
          fieldNodes,
          info,
          result,
        ),
        fieldNodes,
        info,
        path,
        result,
      ),
    );
  }

  return completeObjectValue(
    exeContext,
    ensureValidRuntimeType(
      runtimeTypeNameOrObj,
      exeContext,
      returnType,
      fieldNodes,
      info,
      result,
    ),
    fieldNodes,
    info,
    path,
    result,
  );
}

function ensureValidRuntimeType(
  runtimeTypeNameOrObj: Maybe<string | GraphQLObjectType>,
  exeContext: ExecutionContext,
  returnType: GraphQLAbstractType,
  fieldNodes: readonly FieldNode[],
  info: GraphQLResolveInfo,
  result: unknown,
): GraphQLObjectType {
  if (runtimeTypeNameOrObj == null) {
    throw new GraphQLError(
      `Abstract type "${returnType.name}" must resolve to an Object type at runtime for field "${info.parentType.name}.${info.fieldName}". Either the "${returnType.name}" type should provide a "resolveType" function or each possible type should provide an "isTypeOf" function.`,
      { nodes: fieldNodes },
    );
  }

  let runtimeTypeName: string | undefined;
  if (typeof runtimeTypeNameOrObj === "string") {
    runtimeTypeName = runtimeTypeNameOrObj;
  } else if (isObjectType(runtimeTypeNameOrObj)) {
    runtimeTypeName = runtimeTypeNameOrObj.name;
  }

  if (!runtimeTypeName) {
    throw new GraphQLError(
      `Abstract type "${returnType.name}" must resolve to an Object type at runtime for field "${info.parentType.name}.${info.fieldName}" with value ${JSON.stringify(result)}, received "${String(runtimeTypeNameOrObj)}".`,
      { nodes: fieldNodes },
    );
  }

  const runtimeType = exeContext.schema.getType(runtimeTypeName);
  if (!runtimeType) {
    throw new GraphQLError(
      `Abstract type "${returnType.name}" was resolved to a type "${runtimeTypeName}" that does not exist inside the schema.`,
      { nodes: fieldNodes },
    );
  }
  if (!isObjectType(runtimeType)) {
    throw new GraphQLError(
      `Abstract type "${returnType.name}" was resolved to a non-object type "${runtimeTypeName}".`,
      { nodes: fieldNodes },
    );
  }
  if (!exeContext.schema.isSubType(returnType, runtimeType)) {
    throw new GraphQLError(
      `Runtime Object type "${runtimeType.name}" is not a possible type for "${returnType.name}".`,
      { nodes: fieldNodes },
    );
  }
  return runtimeType;
}

function completeObjectValue(
  exeContext: ExecutionContext,
  returnType: GraphQLObjectType,
  fieldNodes: readonly FieldNode[],
  info: GraphQLResolveInfo,
  path: ResponsePath,
  result: unknown,
): unknown {
  if (returnType.isTypeOf) {
    const isTypeOf = returnType.isTypeOf(result, exeContext.contextValue, info);
    if (isPromise<boolean>(isTypeOf)) {
      return isTypeOf.then((ok) => {
        if (!ok) {
          throw new GraphQLError(
            `Expected value of type "${returnType.name}" but got: ${JSON.stringify(result)}.`,
            { nodes: fieldNodes },
          );
        }
        return collectAndExecuteSubfields(
          exeContext,
          returnType,
          fieldNodes,
          path,
          result,
        );
      });
    }
    if (!isTypeOf) {
      throw new GraphQLError(
        `Expected value of type "${returnType.name}" but got: ${JSON.stringify(result)}.`,
        { nodes: fieldNodes },
      );
    }
  }

  return collectAndExecuteSubfields(
    exeContext,
    returnType,
    fieldNodes,
    path,
    result,
  );
}

function collectAndExecuteSubfields(
  exeContext: ExecutionContext,
  returnType: GraphQLObjectType,
  fieldNodes: readonly FieldNode[],
  path: ResponsePath,
  result: unknown,
): unknown {
  const subFieldNodes = collectSubfields(exeContext, returnType, fieldNodes);
  return executeFields(exeContext, returnType, result, path, subFieldNodes);
}

function buildResponse(
  data: Record<string, unknown> | null,
  errors: readonly GraphQLError[],
): ExecutionResult {
  return errors.length === 0 ? { data } : { errors, data };
}

function executeRootGroupedFieldSet(
  exeContext: ExecutionContext,
  operation: OperationDefinitionNode,
  rootType: GraphQLObjectType,
  rootValue: unknown,
): Promise<Record<string, unknown>> | Record<string, unknown> {
  const fields = collectFields(
    exeContext,
    rootType,
    operation.selectionSet,
    new Map(),
    new Set(),
  );
  if (operation.operation === "mutation") {
    return executeFieldsSerially(exeContext, rootType, rootValue, undefined, fields);
  }
  return executeFields(exeContext, rootType, rootValue, undefined, fields);
}

// ---------------------------------------------------------------------------
// Public execute() & subscribe()
// ---------------------------------------------------------------------------

function normalizeExecutionArgs(
  argsOrSchema: ExecutionArgs | GraphQLSchema,
  document?: DocumentNode,
  rootValue?: unknown,
  contextValue?: unknown,
  variableValues?: Maybe<Record<string, unknown>>,
  operationName?: Maybe<string>,
  fieldResolver?: Maybe<GraphQLFieldResolver<any, any>>,
  typeResolver?: Maybe<GraphQLTypeResolver<any, any>>,
  subscribeFieldResolver?: Maybe<GraphQLFieldResolver<any, any>>,
): ExecutionArgs {
  if (
    argsOrSchema &&
    typeof argsOrSchema === "object" &&
    "schema" in argsOrSchema &&
    "document" in argsOrSchema
  ) {
    return argsOrSchema as ExecutionArgs;
  }
  return {
    schema: argsOrSchema as GraphQLSchema,
    document: document!,
    rootValue,
    contextValue,
    variableValues,
    operationName,
    fieldResolver,
    typeResolver,
    subscribeFieldResolver,
  };
}

function isErrorList(
  value: ExecutionContext | readonly GraphQLError[],
): value is readonly GraphQLError[] {
  return Array.isArray(value);
}

function getSchemaRootType(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode["operation"],
): Maybe<GraphQLObjectType> {
  if (typeof schema.getRootType === "function") {
    return schema.getRootType(operation);
  }
  switch (operation) {
    case "query":
      return schema.getQueryType();
    case "mutation":
      return schema.getMutationType();
    case "subscription":
      return schema.getSubscriptionType();
  }
}

export function execute(
  args: ExecutionArgs,
): Promise<ExecutionResult> | ExecutionResult;
export function execute(
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: unknown,
  contextValue?: unknown,
  variableValues?: Maybe<Record<string, unknown>>,
  operationName?: Maybe<string>,
  fieldResolver?: Maybe<GraphQLFieldResolver<any, any>>,
  typeResolver?: Maybe<GraphQLTypeResolver<any, any>>,
): Promise<ExecutionResult> | ExecutionResult;
export function execute(
  argsOrSchema: ExecutionArgs | GraphQLSchema,
  document?: DocumentNode,
  rootValue?: unknown,
  contextValue?: unknown,
  variableValues?: Maybe<Record<string, unknown>>,
  operationName?: Maybe<string>,
  fieldResolver?: Maybe<GraphQLFieldResolver<any, any>>,
  typeResolver?: Maybe<GraphQLTypeResolver<any, any>>,
): Promise<ExecutionResult> | ExecutionResult {
  const args = normalizeExecutionArgs(
    argsOrSchema,
    document,
    rootValue,
    contextValue,
    variableValues,
    operationName,
    fieldResolver,
    typeResolver,
  );

  const exeContext = buildExecutionContext(args);
  if (isErrorList(exeContext)) {
    return { errors: exeContext };
  }

  const rootType = getSchemaRootType(
    exeContext.schema,
    exeContext.operation.operation,
  );
  if (!rootType) {
    return {
      errors: [
        new GraphQLError(
          `Schema is not configured to execute ${exeContext.operation.operation} operation.`,
          { nodes: exeContext.operation },
        ),
      ],
    };
  }

  try {
    const data = executeRootGroupedFieldSet(
      exeContext,
      exeContext.operation,
      rootType,
      exeContext.rootValue,
    );
    if (isPromise(data)) {
      return data.then(
        (resolved) => buildResponse(resolved, exeContext.errors),
        (err) => {
          exeContext.errors.push(
            isGraphQLError(err)
              ? err
              : locatedError(err, exeContext.operation),
          );
          return buildResponse(null, exeContext.errors);
        },
      );
    }
    return buildResponse(data, exeContext.errors);
  } catch (err) {
    exeContext.errors.push(
      isGraphQLError(err)
        ? err
        : locatedError(err, exeContext.operation),
    );
    return buildResponse(null, exeContext.errors);
  }
}

export async function createSourceEventStream(
  args: ExecutionArgs,
): Promise<AsyncIterable<unknown> | ExecutionResult> {
  const exeContext = buildExecutionContext(args);
  if (isErrorList(exeContext)) {
    return { errors: exeContext };
  }

  const rootType = exeContext.schema.getSubscriptionType();
  if (!rootType) {
    return {
      errors: [
        new GraphQLError(
          "Schema is not configured to execute subscription operation.",
          { nodes: exeContext.operation },
        ),
      ],
    };
  }

  const fields = collectFields(
    exeContext,
    rootType,
    exeContext.operation.selectionSet,
    new Map(),
    new Set(),
  );
  const firstEntry = fields.entries().next().value;
  if (!firstEntry) {
    return {
      errors: [
        new GraphQLError("Subscription operation has no root fields.", {
          nodes: exeContext.operation,
        }),
      ],
    };
  }

  const [responseName, fieldNodes] = firstEntry;
  const fieldNode = fieldNodes[0]!;
  const fieldDef = getFieldDef(exeContext.schema, rootType, fieldNode);
  if (!fieldDef) {
    return {
      errors: [
        new GraphQLError(
          `The subscription field "${fieldNode.name.value}" is not defined.`,
          { nodes: fieldNodes },
        ),
      ],
    };
  }

  const path = addPath(undefined, responseName, rootType.name);
  const info: GraphQLResolveInfo = {
    fieldName: fieldDef.name,
    fieldNodes,
    returnType: fieldDef.type,
    parentType: rootType,
    path,
    schema: exeContext.schema,
    fragments: exeContext.fragments,
    rootValue: exeContext.rootValue,
    operation: exeContext.operation,
    variableValues: exeContext.variableValues,
  };

  try {
    const argValues = getArgumentValues(
      fieldDef,
      fieldNode,
      exeContext.variableValues,
    );
    const resolveFn = fieldDef.subscribe ?? exeContext.subscribeFieldResolver;
    const eventStream = await resolveFn(
      exeContext.rootValue,
      argValues,
      exeContext.contextValue,
      info,
    );

    if (eventStream instanceof Error) {
      throw eventStream;
    }
    if (!isAsyncIterable(eventStream)) {
      throw new Error(
        `Subscription field must return Async Iterable. Received: ${String(eventStream)}.`,
      );
    }
    return eventStream;
  } catch (rawError) {
    return {
      errors: [locatedError(rawError, fieldNodes, pathToArray(path))],
    };
  }
}

export async function subscribe(
  args: ExecutionArgs,
): Promise<AsyncIterableIterator<ExecutionResult> | ExecutionResult>;
export async function subscribe(
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: unknown,
  contextValue?: unknown,
  variableValues?: Maybe<Record<string, unknown>>,
  operationName?: Maybe<string>,
  fieldResolver?: Maybe<GraphQLFieldResolver<any, any>>,
  subscribeFieldResolver?: Maybe<GraphQLFieldResolver<any, any>>,
): Promise<AsyncIterableIterator<ExecutionResult> | ExecutionResult>;
export async function subscribe(
  argsOrSchema: ExecutionArgs | GraphQLSchema,
  document?: DocumentNode,
  rootValue?: unknown,
  contextValue?: unknown,
  variableValues?: Maybe<Record<string, unknown>>,
  operationName?: Maybe<string>,
  fieldResolver?: Maybe<GraphQLFieldResolver<any, any>>,
  subscribeFieldResolver?: Maybe<GraphQLFieldResolver<any, any>>,
): Promise<AsyncIterableIterator<ExecutionResult> | ExecutionResult> {
  const args = normalizeExecutionArgs(
    argsOrSchema,
    document,
    rootValue,
    contextValue,
    variableValues,
    operationName,
    fieldResolver,
    undefined,
    subscribeFieldResolver,
  );

  const sourceStream = await createSourceEventStream(args);
  if (!isAsyncIterable(sourceStream)) {
    return sourceStream;
  }

  const exeContextBase = buildExecutionContext(args);
  if (isErrorList(exeContextBase)) {
    return { errors: exeContextBase };
  }
  const rootType = exeContextBase.schema.getSubscriptionType()!;
  const sourceIterator = sourceStream[Symbol.asyncIterator]();

  const mapPayloadToResult = async (
    payload: unknown,
  ): Promise<ExecutionResult> => {
    const eventContext: ExecutionContext = {
      ...exeContextBase,
      rootValue: payload,
      errors: [],
    };
    try {
      const data = await executeRootGroupedFieldSet(
        eventContext,
        eventContext.operation,
        rootType,
        payload,
      );
      return buildResponse(data, eventContext.errors);
    } catch (err) {
      eventContext.errors.push(
        isGraphQLError(err)
          ? err
          : locatedError(err, eventContext.operation),
      );
      return buildResponse(null, eventContext.errors);
    }
  };

  let closed = false;
  const iterator: AsyncIterableIterator<ExecutionResult> = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async next(): Promise<IteratorResult<ExecutionResult>> {
      if (closed) {
        return { value: undefined, done: true };
      }
      const step = await sourceIterator.next();
      if (step.done) {
        closed = true;
        return { value: undefined, done: true };
      }
      const result = await mapPayloadToResult(step.value);
      return { value: result, done: false };
    },
    async return(): Promise<IteratorResult<ExecutionResult>> {
      closed = true;
      if (typeof sourceIterator.return === "function") {
        await sourceIterator.return();
      }
      return { value: undefined, done: true };
    },
    async throw(err?: unknown): Promise<IteratorResult<ExecutionResult>> {
      closed = true;
      if (typeof sourceIterator.throw === "function") {
        await sourceIterator.throw(err);
      } else if (typeof sourceIterator.return === "function") {
        await sourceIterator.return();
      }
      return Promise.reject(err);
    },
  };

  return iterator;
}

// ---------------------------------------------------------------------------
// High-Level Convenience Entry Points: graphql() & graphqlSync()
// ---------------------------------------------------------------------------

export interface GraphQLArgs {
  schema: GraphQLSchema;
  source: string | Source;
  rootValue?: unknown;
  contextValue?: unknown;
  variableValues?: Maybe<Record<string, unknown>>;
  operationName?: Maybe<string>;
  fieldResolver?: Maybe<GraphQLFieldResolver<any, any>>;
  typeResolver?: Maybe<GraphQLTypeResolver<any, any>>;
}

function normalizeGraphQLArgs(
  argsOrSchema: GraphQLArgs | GraphQLSchema,
  source?: string | Source,
  rootValue?: unknown,
  contextValue?: unknown,
  variableValues?: Maybe<Record<string, unknown>>,
  operationName?: Maybe<string>,
  fieldResolver?: Maybe<GraphQLFieldResolver<any, any>>,
  typeResolver?: Maybe<GraphQLTypeResolver<any, any>>,
): GraphQLArgs {
  if (
    argsOrSchema &&
    typeof argsOrSchema === "object" &&
    "schema" in argsOrSchema &&
    "source" in argsOrSchema
  ) {
    return argsOrSchema as GraphQLArgs;
  }
  return {
    schema: argsOrSchema as GraphQLSchema,
    source: source!,
    rootValue,
    contextValue,
    variableValues,
    operationName,
    fieldResolver,
    typeResolver,
  };
}

function graphqlImpl(args: GraphQLArgs): Promise<ExecutionResult> | ExecutionResult {
  const {
    schema,
    source,
    rootValue,
    contextValue,
    variableValues,
    operationName,
    fieldResolver,
    typeResolver,
  } = args;

  let document: DocumentNode;
  try {
    document = parse(source);
  } catch (syntaxErr) {
    let err: GraphQLError;
    if (isGraphQLError(syntaxErr)) {
      err = syntaxErr;
    } else {
      err = new GraphQLError(
        syntaxErr instanceof Error ? syntaxErr.message : String(syntaxErr),
      );
    }
    return { errors: [err] };
  }

  const validationErrors = validate(schema, document);
  if (validationErrors.length > 0) {
    return { errors: validationErrors };
  }

  return execute({
    schema,
    document,
    rootValue,
    contextValue,
    variableValues,
    operationName,
    fieldResolver,
    typeResolver,
  });
}

/**
 * Convenience all-in-one parse + validate + execute returning a `Promise<ExecutionResult>`.
 */
export function graphql(args: GraphQLArgs): Promise<ExecutionResult>;
export function graphql(
  schema: GraphQLSchema,
  source: string | Source,
  rootValue?: unknown,
  contextValue?: unknown,
  variableValues?: Maybe<Record<string, unknown>>,
  operationName?: Maybe<string>,
  fieldResolver?: Maybe<GraphQLFieldResolver<any, any>>,
  typeResolver?: Maybe<GraphQLTypeResolver<any, any>>,
): Promise<ExecutionResult>;
export function graphql(
  argsOrSchema: GraphQLArgs | GraphQLSchema,
  source?: string | Source,
  rootValue?: unknown,
  contextValue?: unknown,
  variableValues?: Maybe<Record<string, unknown>>,
  operationName?: Maybe<string>,
  fieldResolver?: Maybe<GraphQLFieldResolver<any, any>>,
  typeResolver?: Maybe<GraphQLTypeResolver<any, any>>,
): Promise<ExecutionResult> {
  const args = normalizeGraphQLArgs(
    argsOrSchema,
    source,
    rootValue,
    contextValue,
    variableValues,
    operationName,
    fieldResolver,
    typeResolver,
  );
  return new Promise((resolve) => resolve(graphqlImpl(args)));
}

/**
 * Synchronous parse + validate + execute; throws if any resolver returns a Promise.
 */
export function graphqlSync(args: GraphQLArgs): ExecutionResult;
export function graphqlSync(
  schema: GraphQLSchema,
  source: string | Source,
  rootValue?: unknown,
  contextValue?: unknown,
  variableValues?: Maybe<Record<string, unknown>>,
  operationName?: Maybe<string>,
  fieldResolver?: Maybe<GraphQLFieldResolver<any, any>>,
  typeResolver?: Maybe<GraphQLTypeResolver<any, any>>,
): ExecutionResult;
export function graphqlSync(
  argsOrSchema: GraphQLArgs | GraphQLSchema,
  source?: string | Source,
  rootValue?: unknown,
  contextValue?: unknown,
  variableValues?: Maybe<Record<string, unknown>>,
  operationName?: Maybe<string>,
  fieldResolver?: Maybe<GraphQLFieldResolver<any, any>>,
  typeResolver?: Maybe<GraphQLTypeResolver<any, any>>,
): ExecutionResult {
  const args = normalizeGraphQLArgs(
    argsOrSchema,
    source,
    rootValue,
    contextValue,
    variableValues,
    operationName,
    fieldResolver,
    typeResolver,
  );
  const result = graphqlImpl(args);
  if (isPromise(result)) {
    throw new Error("GraphQL execution failed to complete synchronously.");
  }
  return result;
}
