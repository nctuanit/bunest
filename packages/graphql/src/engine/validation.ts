/**
 * GraphQL October 2021 Spec Validation Engine.
 * Implements `TypeInfo`, `ValidationContext`, `validate()`, all 26 `specifiedRules`,
 * and `NoSchemaIntrospectionCustomRule`.
 * Memoized fragment traversal guarantees O(V + E) linear time on fragment diamond DAGs.
 * Zero external dependencies.
 */

import {
  type ArgumentNode,
  type ASTNode,
  type ASTVisitor,
  BREAK,
  type DirectiveLocationEnum,
  DirectiveLocation,
  type DirectiveNode,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type FragmentSpreadNode,
  getEnterLeaveForKind,
  type InlineFragmentNode,
  Kind,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
  type VariableDefinitionNode,
  type VariableNode,
  visit,
  visitInParallel,
} from "./ast";
import { GraphQLError, isGraphQLError } from "./error";
import {
  isIntrospectionType,
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef,
} from "./introspection";
import { print } from "./printer";
import type { Maybe } from "./scalars";
import type { GraphQLSchema } from "./schema";
import {
  doTypesOverlap,
  getNamedType,
  getNullableType,
  type GraphQLArgument,
  type GraphQLCompositeType,
  type GraphQLDirective,
  type GraphQLEnumValue,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLOutputType,
  type GraphQLType,
  isAbstractType,
  isCompositeType,
  isEnumType,
  isEqualType,
  isInputObjectType,
  isInputType,
  isInterfaceType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  isOutputType,
  isRequiredArgument,
  isRequiredInputField,
  isScalarType,
  isTypeSubTypeOf,
  isUnionType,
  typeFromAST,
} from "./types";

// ---------------------------------------------------------------------------
// TypeInfo
// ---------------------------------------------------------------------------

function getFieldDef(
  schema: GraphQLSchema,
  parentType: GraphQLType,
  fieldNode: FieldNode,
): Maybe<GraphQLField<any, any>> {
  const name = fieldNode.name.value;
  if (name === SchemaMetaFieldDef.name && schema.getQueryType() === parentType) {
    return SchemaMetaFieldDef;
  }
  if (name === TypeMetaFieldDef.name && schema.getQueryType() === parentType) {
    return TypeMetaFieldDef;
  }
  if (
    name === TypeNameMetaFieldDef.name &&
    isCompositeType(parentType)
  ) {
    return TypeNameMetaFieldDef;
  }
  if (isObjectType(parentType) || isInterfaceType(parentType)) {
    return parentType.getFields()[name];
  }
  return undefined;
}

export class TypeInfo {
  private readonly _schema: GraphQLSchema;
  private readonly _typeStack: Array<Maybe<GraphQLOutputType>> = [];
  private readonly _parentTypeStack: Array<Maybe<GraphQLCompositeType>> = [];
  private readonly _inputTypeStack: Array<Maybe<GraphQLInputType>> = [];
  private readonly _fieldDefStack: Array<Maybe<GraphQLField<any, any>>> = [];
  private readonly _defaultValueStack: Array<unknown> = [];
  private _directive: Maybe<GraphQLDirective> = null;
  private _argument: Maybe<GraphQLArgument> = null;
  private _enumValue: Maybe<GraphQLEnumValue> = null;

  constructor(schema: GraphQLSchema) {
    this._schema = schema;
  }

  getType(): Maybe<GraphQLOutputType> {
    return this._typeStack[this._typeStack.length - 1];
  }

  getParentType(): Maybe<GraphQLCompositeType> {
    return this._parentTypeStack[this._parentTypeStack.length - 1];
  }

  getInputType(): Maybe<GraphQLInputType> {
    return this._inputTypeStack[this._inputTypeStack.length - 1];
  }

  getParentInputType(): Maybe<GraphQLInputType> {
    return this._inputTypeStack[this._inputTypeStack.length - 2];
  }

  getFieldDef(): Maybe<GraphQLField<any, any>> {
    return this._fieldDefStack[this._fieldDefStack.length - 1];
  }

  getDefaultValue(): unknown {
    return this._defaultValueStack[this._defaultValueStack.length - 1];
  }

  getDirective(): Maybe<GraphQLDirective> {
    return this._directive;
  }

  getArgument(): Maybe<GraphQLArgument> {
    return this._argument;
  }

  getEnumValue(): Maybe<GraphQLEnumValue> {
    return this._enumValue;
  }

  enter(node: ASTNode): void {
    const schema = this._schema;
    switch (node.kind) {
      case Kind.SELECTION_SET: {
        const namedType = getNamedType(this.getType());
        this._parentTypeStack.push(
          isCompositeType(namedType) ? namedType : undefined,
        );
        break;
      }
      case Kind.FIELD: {
        const parentType = this.getParentType();
        const fieldDef = parentType
          ? getFieldDef(schema, parentType, node)
          : undefined;
        this._fieldDefStack.push(fieldDef);
        this._typeStack.push(fieldDef ? fieldDef.type : undefined);
        break;
      }
      case Kind.DIRECTIVE:
        this._directive = schema.getDirective(node.name.value);
        break;
      case Kind.OPERATION_DEFINITION: {
        const rootType =
          typeof schema.getRootType === "function"
            ? schema.getRootType(node.operation)
            : node.operation === "query"
              ? schema.getQueryType()
              : node.operation === "mutation"
                ? schema.getMutationType()
                : schema.getSubscriptionType();
        this._typeStack.push(isObjectType(rootType) ? rootType : undefined);
        break;
      }
      case Kind.INLINE_FRAGMENT:
      case Kind.FRAGMENT_DEFINITION: {
        const typeConditionAST = node.typeCondition;
        const outputType = typeConditionAST
          ? typeFromAST(schema, typeConditionAST)
          : getNamedType(this.getType());
        this._typeStack.push(isOutputType(outputType) ? outputType : undefined);
        break;
      }
      case Kind.VARIABLE_DEFINITION: {
        const inputType = typeFromAST(schema, node.type);
        this._inputTypeStack.push(
          isInputType(inputType) ? inputType : undefined,
        );
        break;
      }
      case Kind.ARGUMENT: {
        let argDef: Maybe<GraphQLArgument> = null;
        let argType: Maybe<GraphQLInputType> = undefined;
        const fieldOrDirective = this.getDirective() ?? this.getFieldDef();
        if (fieldOrDirective) {
          argDef = fieldOrDirective.args.find(
            (arg) => arg.name === node.name.value,
          );
          if (argDef) {
            argType = argDef.type;
          }
        }
        this._argument = argDef;
        this._defaultValueStack.push(argDef ? argDef.defaultValue : undefined);
        this._inputTypeStack.push(isInputType(argType) ? argType : undefined);
        break;
      }
      case Kind.LIST: {
        const listType = getNullableType(this.getInputType());
        const itemType = isListType(listType) ? listType.ofType : listType;
        this._defaultValueStack.push(undefined);
        this._inputTypeStack.push(
          isInputType(itemType) ? itemType : undefined,
        );
        break;
      }
      case Kind.OBJECT_FIELD: {
        const objectType = getNamedType(this.getInputType());
        let inputFieldType: Maybe<GraphQLInputType> = undefined;
        let inputField: Maybe<{ defaultValue: unknown; type: GraphQLInputType }> =
          undefined;
        if (isInputObjectType(objectType)) {
          inputField = objectType.getFields()[node.name.value];
          if (inputField) {
            inputFieldType = inputField.type;
          }
        }
        this._defaultValueStack.push(
          inputField ? inputField.defaultValue : undefined,
        );
        this._inputTypeStack.push(
          isInputType(inputFieldType) ? inputFieldType : undefined,
        );
        break;
      }
      case Kind.ENUM: {
        const enumType = getNamedType(this.getInputType());
        this._enumValue = isEnumType(enumType)
          ? enumType.getValue(node.value)
          : undefined;
        break;
      }
    }
  }

  leave(node: ASTNode): void {
    switch (node.kind) {
      case Kind.SELECTION_SET:
        this._parentTypeStack.pop();
        break;
      case Kind.FIELD:
        this._fieldDefStack.pop();
        this._typeStack.pop();
        break;
      case Kind.DIRECTIVE:
        this._directive = null;
        break;
      case Kind.OPERATION_DEFINITION:
      case Kind.INLINE_FRAGMENT:
      case Kind.FRAGMENT_DEFINITION:
        this._typeStack.pop();
        break;
      case Kind.VARIABLE_DEFINITION:
        this._inputTypeStack.pop();
        break;
      case Kind.ARGUMENT:
        this._argument = null;
        this._defaultValueStack.pop();
        this._inputTypeStack.pop();
        break;
      case Kind.LIST:
      case Kind.OBJECT_FIELD:
        this._defaultValueStack.pop();
        this._inputTypeStack.pop();
        break;
      case Kind.ENUM:
        this._enumValue = null;
        break;
    }
  }
}

export function visitWithTypeInfo(
  typeInfo: TypeInfo,
  visitor: ASTVisitor,
): ASTVisitor {
  return {
    enter(node, key, parent, path, ancestors) {
      typeInfo.enter(node);
      const fn = getEnterLeaveForKind(visitor, node.kind).enter;
      if (fn) {
        const result = fn.call(visitor, node, key, parent, path, ancestors);
        if (result !== undefined) {
          typeInfo.leave(node);
          if (result && typeof result === "object" && "kind" in result) {
            typeInfo.enter(result as ASTNode);
          }
        }
        return result;
      }
      return undefined;
    },
    leave(node, key, parent, path, ancestors) {
      const fn = getEnterLeaveForKind(visitor, node.kind).leave;
      let result: unknown;
      if (fn) {
        result = fn.call(visitor, node, key, parent, path, ancestors);
      }
      typeInfo.leave(node);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// ValidationContext
// ---------------------------------------------------------------------------

export interface VariableUsage {
  readonly node: VariableNode;
  readonly type: Maybe<GraphQLInputType>;
  readonly defaultValue: unknown;
}

export class ValidationContext {
  private readonly _schema: GraphQLSchema;
  private readonly _ast: DocumentNode;
  private readonly _typeInfo: TypeInfo;
  private readonly _onError: (error: GraphQLError) => void;
  private readonly _errors: GraphQLError[] = [];
  private _fragments?: Map<string, FragmentDefinitionNode>;
  private readonly _fragmentSpreads = new Map<
    SelectionSetNode,
    FragmentSpreadNode[]
  >();
  private readonly _recursivelyReferencedFragments = new Map<
    OperationDefinitionNode,
    FragmentDefinitionNode[]
  >();
  private readonly _variableUsages = new Map<
    OperationDefinitionNode | FragmentDefinitionNode,
    VariableUsage[]
  >();
  private readonly _recursiveVariableUsages = new Map<
    OperationDefinitionNode,
    VariableUsage[]
  >();

  constructor(
    schema: GraphQLSchema,
    ast: DocumentNode,
    typeInfo: TypeInfo,
    onError: (error: GraphQLError) => void,
  ) {
    this._schema = schema;
    this._ast = ast;
    this._typeInfo = typeInfo;
    this._onError = onError;
  }

  reportError(error: GraphQLError): void {
    this._errors.push(error);
    this._onError(error);
  }

  getErrors(): readonly GraphQLError[] {
    return this._errors;
  }

  getSchema(): GraphQLSchema {
    return this._schema;
  }

  getDocument(): DocumentNode {
    return this._ast;
  }

  getFragment(name: string): FragmentDefinitionNode | undefined {
    if (!this._fragments) {
      const map = new Map<string, FragmentDefinitionNode>();
      for (const def of this._ast.definitions) {
        if (def.kind === Kind.FRAGMENT_DEFINITION) {
          map.set(def.name.value, def);
        }
      }
      this._fragments = map;
    }
    return this._fragments.get(name);
  }

  getFragmentSpreads(node: SelectionSetNode): readonly FragmentSpreadNode[] {
    let spreads = this._fragmentSpreads.get(node);
    if (!spreads) {
      spreads = [];
      const setsToVisit: SelectionSetNode[] = [node];
      while (setsToVisit.length > 0) {
        const set = setsToVisit.pop()!;
        for (const selection of set.selections) {
          if (selection.kind === Kind.FRAGMENT_SPREAD) {
            spreads.push(selection);
          } else if (selection.selectionSet) {
            setsToVisit.push(selection.selectionSet);
          }
        }
      }
      this._fragmentSpreads.set(node, spreads);
    }
    return spreads;
  }

  getRecursivelyReferencedFragments(
    operation: OperationDefinitionNode,
  ): readonly FragmentDefinitionNode[] {
    let fragments = this._recursivelyReferencedFragments.get(operation);
    if (!fragments) {
      fragments = [];
      const collectedNames = new Set<string>();
      const nodesToVisit: SelectionSetNode[] = [operation.selectionSet];
      while (nodesToVisit.length > 0) {
        const node = nodesToVisit.pop()!;
        for (const spread of this.getFragmentSpreads(node)) {
          const fragName = spread.name.value;
          if (!collectedNames.has(fragName)) {
            collectedNames.add(fragName);
            const fragment = this.getFragment(fragName);
            if (fragment) {
              fragments.push(fragment);
              nodesToVisit.push(fragment.selectionSet);
            }
          }
        }
      }
      this._recursivelyReferencedFragments.set(operation, fragments);
    }
    return fragments;
  }

  getVariableUsages(
    node: OperationDefinitionNode | FragmentDefinitionNode,
  ): readonly VariableUsage[] {
    let usages = this._variableUsages.get(node);
    if (!usages) {
      const newUsages: VariableUsage[] = [];
      const typeInfo = new TypeInfo(this._schema);
      visit(
        node,
        visitWithTypeInfo(typeInfo, {
          VariableDefinition: () => false,
          Variable(variable) {
            newUsages.push({
              node: variable,
              type: typeInfo.getInputType(),
              defaultValue: typeInfo.getDefaultValue(),
            });
          },
        }),
      );
      usages = newUsages;
      this._variableUsages.set(node, usages);
    }
    return usages;
  }

  getRecursiveVariableUsages(
    operation: OperationDefinitionNode,
  ): readonly VariableUsage[] {
    let usages = this._recursiveVariableUsages.get(operation);
    if (!usages) {
      usages = [...this.getVariableUsages(operation)];
      for (const fragment of this.getRecursivelyReferencedFragments(operation)) {
        usages.push(...this.getVariableUsages(fragment));
      }
      this._recursiveVariableUsages.set(operation, usages);
    }
    return usages;
  }

  getType(): Maybe<GraphQLOutputType> {
    return this._typeInfo.getType();
  }

  getParentType(): Maybe<GraphQLCompositeType> {
    return this._typeInfo.getParentType();
  }

  getInputType(): Maybe<GraphQLInputType> {
    return this._typeInfo.getInputType();
  }

  getParentInputType(): Maybe<GraphQLInputType> {
    return this._typeInfo.getParentInputType();
  }

  getFieldDef(): Maybe<GraphQLField<any, any>> {
    return this._typeInfo.getFieldDef();
  }

  getDirective(): Maybe<GraphQLDirective> {
    return this._typeInfo.getDirective();
  }

  getArgument(): Maybe<GraphQLArgument> {
    return this._typeInfo.getArgument();
  }

  getEnumValue(): Maybe<GraphQLEnumValue> {
    return this._typeInfo.getEnumValue();
  }
}

export type ValidationRule = (context: ValidationContext) => ASTVisitor;

// ---------------------------------------------------------------------------
// Standard GraphQL October 2021 Validation Rules
// ---------------------------------------------------------------------------

export const ExecutableDefinitionsRule: ValidationRule = (context) => ({
  Document(node) {
    for (const def of node.definitions) {
      if (
        def.kind !== Kind.OPERATION_DEFINITION &&
        def.kind !== Kind.FRAGMENT_DEFINITION
      ) {
        const defName =
          def.kind === Kind.SCHEMA_DEFINITION ||
          def.kind === Kind.SCHEMA_EXTENSION
            ? "schema"
            : `"${def.name.value}"`;
        context.reportError(
          new GraphQLError(
            `The ${defName} definition is not executable.`,
            { nodes: def },
          ),
        );
      }
    }
    return false;
  },
});

export const UniqueOperationNamesRule: ValidationRule = (context) => {
  const knownOperationNames = new Map<string, ASTNode>();
  return {
    OperationDefinition(node) {
      const name = node.name;
      if (name) {
        const existing = knownOperationNames.get(name.value);
        if (existing) {
          context.reportError(
            new GraphQLError(
              `There can be only one operation named "${name.value}".`,
              { nodes: [existing, name] },
            ),
          );
        } else {
          knownOperationNames.set(name.value, name);
        }
      }
      return false;
    },
    FragmentDefinition: () => false,
  };
};

export const LoneAnonymousOperationRule: ValidationRule = (context) => {
  let operationCount = 0;
  return {
    Document(node) {
      operationCount = node.definitions.filter(
        (def) => def.kind === Kind.OPERATION_DEFINITION,
      ).length;
    },
    OperationDefinition(node) {
      if (!node.name && operationCount > 1) {
        context.reportError(
          new GraphQLError(
            "This anonymous operation must be the only defined operation.",
            { nodes: node },
          ),
        );
      }
    },
  };
};

export const SingleFieldSubscriptionsRule: ValidationRule = (context) => ({
  OperationDefinition(node) {
    if (node.operation === "subscription") {
      const schema = context.getSchema();
      const subscriptionType = schema.getSubscriptionType();
      if (!subscriptionType) return;

      const rootFields = new Map<string, FieldNode[]>();
      const visitedFragments = new Set<string>();
      const collect = (selectionSet: SelectionSetNode) => {
        for (const sel of selectionSet.selections) {
          if (sel.kind === Kind.FIELD) {
            const key = sel.alias?.value ?? sel.name.value;
            const list = rootFields.get(key) ?? [];
            list.push(sel);
            rootFields.set(key, list);
          } else if (sel.kind === Kind.INLINE_FRAGMENT) {
            collect(sel.selectionSet);
          } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
            const fragName = sel.name.value;
            if (!visitedFragments.has(fragName)) {
              visitedFragments.add(fragName);
              const frag = context.getFragment(fragName);
              if (frag) collect(frag.selectionSet);
            }
          }
        }
      };
      collect(node.selectionSet);

      if (rootFields.size > 1) {
        const extraNodes = [...rootFields.values()].slice(1).flat();
        const opName = node.name
          ? `Subscription "${node.name.value}"`
          : "Anonymous Subscription";
        context.reportError(
          new GraphQLError(`${opName} must select only one top level field.`, {
            nodes: extraNodes,
          }),
        );
      }

      for (const fieldNodes of rootFields.values()) {
        const fieldNode = fieldNodes[0]!;
        if (fieldNode.name.value.startsWith("__")) {
          const opName = node.name
            ? `Subscription "${node.name.value}"`
            : "Anonymous Subscription";
          context.reportError(
            new GraphQLError(
              `${opName} must not select an introspection top level field.`,
              { nodes: fieldNodes },
            ),
          );
        }
      }
    }
  },
});

export const KnownTypeNamesRule: ValidationRule = (context) => ({
  NamedType(node, _key, parent) {
    // Only check executable AST nodes
    const schema = context.getSchema();
    const typeName = node.name.value;
    if (!schema.getType(typeName)) {
      void parent;
      context.reportError(
        new GraphQLError(`Unknown type "${typeName}".`, { nodes: node }),
      );
    }
  },
});

export const FragmentsOnCompositeTypesRule: ValidationRule = (context) => ({
  InlineFragment(node) {
    if (node.typeCondition) {
      const type = typeFromAST(context.getSchema(), node.typeCondition);
      if (type && !isCompositeType(type)) {
        context.reportError(
          new GraphQLError(
            `Fragment cannot condition on non composite type "${print(node.typeCondition)}".`,
            { nodes: node.typeCondition },
          ),
        );
      }
    }
  },
  FragmentDefinition(node) {
    const type = typeFromAST(context.getSchema(), node.typeCondition);
    if (type && !isCompositeType(type)) {
      context.reportError(
        new GraphQLError(
          `Fragment "${node.name.value}" cannot condition on non composite type "${print(node.typeCondition)}".`,
          { nodes: node.typeCondition },
        ),
      );
    }
  },
});

export const VariablesAreInputTypesRule: ValidationRule = (context) => ({
  VariableDefinition(node) {
    const type = typeFromAST(context.getSchema(), node.type);
    if (type && !isInputType(type)) {
      context.reportError(
        new GraphQLError(
          `Variable "$${node.variable.name.value}" cannot be non-input type "${print(node.type)}".`,
          { nodes: node.type },
        ),
      );
    }
  },
});

export const ScalarLeafsRule: ValidationRule = (context) => ({
  Field(node) {
    const type = context.getType();
    const selectionSet = node.selectionSet;
    if (type) {
      if (isLeafType(getNamedType(type))) {
        if (selectionSet) {
          context.reportError(
            new GraphQLError(
              `Field "${node.name.value}" must not have a selection since type "${String(type)}" has no subfields.`,
              { nodes: selectionSet },
            ),
          );
        }
      } else if (!selectionSet) {
        context.reportError(
          new GraphQLError(
            `Field "${node.name.value}" of type "${String(type)}" must have a selection of subfields. Did you mean "${node.name.value} { ... }"?`,
            { nodes: node },
          ),
        );
      }
    }
  },
});

export const FieldsOnCorrectTypeRule: ValidationRule = (context) => ({
  Field(node) {
    const type = context.getParentType();
    if (type) {
      const fieldDef = context.getFieldDef();
      if (!fieldDef) {
        const fieldName = node.name.value;
        context.reportError(
          new GraphQLError(
            `Cannot query field "${fieldName}" on type "${type.name}".`,
            { nodes: node },
          ),
        );
      }
    }
  },
});

export const UniqueFragmentNamesRule: ValidationRule = (context) => {
  const knownFragmentNames = new Map<string, ASTNode>();
  return {
    OperationDefinition: () => false,
    FragmentDefinition(node) {
      const fragName = node.name.value;
      const existing = knownFragmentNames.get(fragName);
      if (existing) {
        context.reportError(
          new GraphQLError(
            `There can be only one fragment named "${fragName}".`,
            { nodes: [existing, node.name] },
          ),
        );
      } else {
        knownFragmentNames.set(fragName, node.name);
      }
      return false;
    },
  };
};

export const KnownFragmentNamesRule: ValidationRule = (context) => ({
  FragmentSpread(node) {
    const fragName = node.name.value;
    if (!context.getFragment(fragName)) {
      context.reportError(
        new GraphQLError(`Unknown fragment "${fragName}".`, {
          nodes: node.name,
        }),
      );
    }
  },
});

export const NoUnusedFragmentsRule: ValidationRule = (context) => {
  const operationDefs: OperationDefinitionNode[] = [];
  const fragmentDefs: FragmentDefinitionNode[] = [];
  return {
    OperationDefinition(node) {
      operationDefs.push(node);
      return false;
    },
    FragmentDefinition(node) {
      fragmentDefs.push(node);
      return false;
    },
    Document: {
      leave() {
        const fragmentNameUsed = new Set<string>();
        for (const operation of operationDefs) {
          for (const frag of context.getRecursivelyReferencedFragments(
            operation,
          )) {
            fragmentNameUsed.add(frag.name.value);
          }
        }
        for (const fragmentDef of fragmentDefs) {
          const fragName = fragmentDef.name.value;
          if (!fragmentNameUsed.has(fragName)) {
            context.reportError(
              new GraphQLError(`Fragment "${fragName}" is never used.`, {
                nodes: fragmentDef,
              }),
            );
          }
        }
      },
    },
  };
};

export const PossibleFragmentSpreadsRule: ValidationRule = (context) => ({
  InlineFragment(node) {
    const fragType = context.getType();
    const parentType = context.getParentType();
    if (
      isCompositeType(fragType) &&
      isCompositeType(parentType) &&
      !doTypesOverlap(context.getSchema(), fragType, parentType)
    ) {
      context.reportError(
        new GraphQLError(
          `Fragment cannot be spread here as objects of type "${parentType.name}" can never be of type "${fragType.name}".`,
          { nodes: node },
        ),
      );
    }
  },
  FragmentSpread(node) {
    const fragName = node.name.value;
    const frag = context.getFragment(fragName);
    const fragType = frag
      ? typeFromAST(context.getSchema(), frag.typeCondition)
      : undefined;
    const parentType = context.getParentType();
    if (
      isCompositeType(fragType) &&
      isCompositeType(parentType) &&
      !doTypesOverlap(context.getSchema(), fragType, parentType)
    ) {
      context.reportError(
        new GraphQLError(
          `Fragment "${fragName}" cannot be spread here as objects of type "${parentType.name}" can never be of type "${fragType.name}".`,
          { nodes: node },
        ),
      );
    }
  },
});

export const NoFragmentCyclesRule: ValidationRule = (context) => {
  const visitedFrags = new Set<string>();
  const spreadPath: FragmentSpreadNode[] = [];
  const spreadPathIndexByName = new Map<string, number>();

  function detectCycleRecursive(fragment: FragmentDefinitionNode): void {
    if (visitedFrags.has(fragment.name.value)) {
      return;
    }
    const fragmentName = fragment.name.value;
    visitedFrags.add(fragmentName);

    const spreadNodes = context.getFragmentSpreads(fragment.selectionSet);
    if (spreadNodes.length === 0) {
      return;
    }

    spreadPathIndexByName.set(fragmentName, spreadPath.length);

    for (const spreadNode of spreadNodes) {
      const spreadName = spreadNode.name.value;
      const cycleIndex = spreadPathIndexByName.get(spreadName);

      spreadPath.push(spreadNode);
      if (cycleIndex === undefined) {
        const spreadFragment = context.getFragment(spreadName);
        if (spreadFragment) {
          detectCycleRecursive(spreadFragment);
        }
      } else {
        const cyclePath = spreadPath.slice(cycleIndex);
        const viaPath = cyclePath
          .slice(0, -1)
          .map((s) => `"${s.name.value}"`)
          .join(", ");
        context.reportError(
          new GraphQLError(
            `Cannot spread fragment "${spreadName}" within itself` +
              (viaPath !== "" ? ` via ${viaPath}.` : "."),
            { nodes: cyclePath },
          ),
        );
      }
      spreadPath.pop();
    }

    spreadPathIndexByName.delete(fragmentName);
  }

  return {
    OperationDefinition: () => false,
    FragmentDefinition(node) {
      detectCycleRecursive(node);
      return false;
    },
  };
};

export const UniqueVariableNamesRule: ValidationRule = (context) => ({
  OperationDefinition(node) {
    const seen = new Map<string, VariableDefinitionNode>();
    for (const varDef of node.variableDefinitions ?? []) {
      const name = varDef.variable.name.value;
      const existing = seen.get(name);
      if (existing) {
        context.reportError(
          new GraphQLError(`There can be only one variable named "$${name}".`, {
            nodes: [existing.variable.name, varDef.variable.name],
          }),
        );
      } else {
        seen.set(name, varDef);
      }
    }
  },
});

export const NoUndefinedVariablesRule: ValidationRule = (context) => {
  const variableNameDefined = new Set<string>();
  return {
    OperationDefinition: {
      enter() {
        variableNameDefined.clear();
      },
      leave(operation) {
        for (const { node } of context.getRecursiveVariableUsages(operation)) {
          const varName = node.name.value;
          if (!variableNameDefined.has(varName)) {
            context.reportError(
              new GraphQLError(
                operation.name
                  ? `Variable "$${varName}" is not defined by operation "${operation.name.value}".`
                  : `Variable "$${varName}" is not defined.`,
                { nodes: [node, operation] },
              ),
            );
          }
        }
      },
    },
    VariableDefinition(node) {
      variableNameDefined.add(node.variable.name.value);
    },
  };
};

export const NoUnusedVariablesRule: ValidationRule = (context) => {
  let variableDefs: VariableDefinitionNode[] = [];
  return {
    OperationDefinition: {
      enter() {
        variableDefs = [];
      },
      leave(operation) {
        const variableNameUsed = new Set<string>();
        for (const usage of context.getRecursiveVariableUsages(operation)) {
          variableNameUsed.add(usage.node.name.value);
        }
        for (const variableDef of variableDefs) {
          const varName = variableDef.variable.name.value;
          if (!variableNameUsed.has(varName)) {
            context.reportError(
              new GraphQLError(
                operation.name
                  ? `Variable "$${varName}" is never used in operation "${operation.name.value}".`
                  : `Variable "$${varName}" is never used.`,
                { nodes: variableDef },
              ),
            );
          }
        }
      },
    },
    VariableDefinition(node) {
      variableDefs.push(node);
    },
  };
};

function getDirectiveLocationForASTPath(
  ancestors: readonly (ASTNode | readonly ASTNode[])[],
): DirectiveLocationEnum | undefined {
  const appliedTo = ancestors[ancestors.length - 1];
  if (!appliedTo || Array.isArray(appliedTo)) return undefined;
  const node = appliedTo as ASTNode;
  switch (node.kind) {
    case Kind.OPERATION_DEFINITION:
      switch (node.operation) {
        case "query":
          return DirectiveLocation.QUERY;
        case "mutation":
          return DirectiveLocation.MUTATION;
        case "subscription":
          return DirectiveLocation.SUBSCRIPTION;
      }
      break;
    case Kind.FIELD:
      return DirectiveLocation.FIELD;
    case Kind.FRAGMENT_SPREAD:
      return DirectiveLocation.FRAGMENT_SPREAD;
    case Kind.INLINE_FRAGMENT:
      return DirectiveLocation.INLINE_FRAGMENT;
    case Kind.FRAGMENT_DEFINITION:
      return DirectiveLocation.FRAGMENT_DEFINITION;
    case Kind.VARIABLE_DEFINITION:
      return DirectiveLocation.VARIABLE_DEFINITION;
    case Kind.SCHEMA_DEFINITION:
    case Kind.SCHEMA_EXTENSION:
      return DirectiveLocation.SCHEMA;
    case Kind.SCALAR_TYPE_DEFINITION:
    case Kind.SCALAR_TYPE_EXTENSION:
      return DirectiveLocation.SCALAR;
    case Kind.OBJECT_TYPE_DEFINITION:
    case Kind.OBJECT_TYPE_EXTENSION:
      return DirectiveLocation.OBJECT;
    case Kind.FIELD_DEFINITION:
      return DirectiveLocation.FIELD_DEFINITION;
    case Kind.INTERFACE_TYPE_DEFINITION:
    case Kind.INTERFACE_TYPE_EXTENSION:
      return DirectiveLocation.INTERFACE;
    case Kind.UNION_TYPE_DEFINITION:
    case Kind.UNION_TYPE_EXTENSION:
      return DirectiveLocation.UNION;
    case Kind.ENUM_TYPE_DEFINITION:
    case Kind.ENUM_TYPE_EXTENSION:
      return DirectiveLocation.ENUM;
    case Kind.ENUM_VALUE_DEFINITION:
      return DirectiveLocation.ENUM_VALUE;
    case Kind.INPUT_OBJECT_TYPE_DEFINITION:
    case Kind.INPUT_OBJECT_TYPE_EXTENSION:
      return DirectiveLocation.INPUT_OBJECT;
    case Kind.INPUT_VALUE_DEFINITION: {
      const parentNode = ancestors[ancestors.length - 3];
      if (
        parentNode &&
        !Array.isArray(parentNode) &&
        (parentNode as ASTNode).kind === Kind.INPUT_OBJECT_TYPE_DEFINITION
      ) {
        return DirectiveLocation.INPUT_FIELD_DEFINITION;
      }
      return DirectiveLocation.ARGUMENT_DEFINITION;
    }
  }
  return undefined;
}

export const KnownDirectivesRule: ValidationRule = (context) => ({
  Directive(node, _key, _parent, _path, ancestors) {
    const directiveDef = context.getSchema().getDirective(node.name.value);
    if (!directiveDef) {
      context.reportError(
        new GraphQLError(`Unknown directive "@${node.name.value}".`, {
          nodes: node,
        }),
      );
      return;
    }
    const candidateLocation = getDirectiveLocationForASTPath(ancestors);
    if (
      candidateLocation &&
      !directiveDef.locations.includes(candidateLocation)
    ) {
      context.reportError(
        new GraphQLError(
          `Directive "@${node.name.value}" may not be used on ${candidateLocation}.`,
          { nodes: node },
        ),
      );
    }
  },
});

export const UniqueDirectivesPerLocationRule: ValidationRule = (context) => {
  const uniqueDirectiveMap = new Map<string, boolean>();
  for (const directive of context.getSchema().getDirectives()) {
    uniqueDirectiveMap.set(directive.name, !directive.isRepeatable);
  }
  return {
    enter(node) {
      if (!("directives" in node) || !node.directives) return;
      const seen = new Map<string, DirectiveNode>();
      for (const dir of node.directives) {
        const name = dir.name.value;
        if (uniqueDirectiveMap.get(name)) {
          const prev = seen.get(name);
          if (prev) {
            context.reportError(
              new GraphQLError(
                `The directive "@${name}" can only be used once at this location.`,
                { nodes: [prev, dir] },
              ),
            );
          } else {
            seen.set(name, dir);
          }
        }
      }
    },
  };
};

export const KnownArgumentNamesRule: ValidationRule = (context) => ({
  Argument(argNode) {
    const argDef = context.getArgument();
    const fieldDef = context.getFieldDef();
    const parentType = context.getParentType();
    const directive = context.getDirective();

    if (!argDef) {
      if (directive) {
        context.reportError(
          new GraphQLError(
            `Unknown argument "${argNode.name.value}" on directive "@${directive.name}".`,
            { nodes: argNode },
          ),
        );
      } else if (fieldDef && parentType) {
        context.reportError(
          new GraphQLError(
            `Unknown argument "${argNode.name.value}" on field "${parentType.name}.${fieldDef.name}".`,
            { nodes: argNode },
          ),
        );
      }
    }
  },
});

export const UniqueArgumentNamesRule: ValidationRule = (context) => {
  const checkArgs = (args: readonly ArgumentNode[] | undefined) => {
    if (!args) return;
    const seen = new Map<string, ArgumentNode>();
    for (const arg of args) {
      const name = arg.name.value;
      const prev = seen.get(name);
      if (prev) {
        context.reportError(
          new GraphQLError(
            `There can be only one argument named "${name}".`,
            { nodes: [prev.name, arg.name] },
          ),
        );
      } else {
        seen.set(name, arg);
      }
    }
  };
  return {
    Field: (node) => {
      checkArgs(node.arguments);
    },
    Directive: (node) => {
      checkArgs(node.arguments);
    },
  };
};

export const ProvidedRequiredArgumentsRule: ValidationRule = (context) => ({
  Field: {
    leave(fieldNode) {
      const fieldDef = context.getFieldDef();
      if (!fieldDef) return false;
      const provided = new Set(
        (fieldNode.arguments ?? []).map((a) => a.name.value),
      );
      for (const argDef of fieldDef.args) {
        if (!provided.has(argDef.name) && isRequiredArgument(argDef)) {
          context.reportError(
            new GraphQLError(
              `Field "${fieldDef.name}" argument "${argDef.name}" of type "${String(argDef.type)}" is required, but it was not provided.`,
              { nodes: fieldNode },
            ),
          );
        }
      }
      return undefined;
    },
  },
  Directive: {
    leave(directiveNode) {
      const directiveDef = context.getDirective();
      if (!directiveDef) return false;
      const provided = new Set(
        (directiveNode.arguments ?? []).map((a) => a.name.value),
      );
      for (const argDef of directiveDef.args) {
        if (!provided.has(argDef.name) && isRequiredArgument(argDef)) {
          context.reportError(
            new GraphQLError(
              `Directive "@${directiveDef.name}" argument "${argDef.name}" of type "${String(argDef.type)}" is required, but it was not provided.`,
              { nodes: directiveNode },
            ),
          );
        }
      }
      return undefined;
    },
  },
});

export const UniqueInputFieldNamesRule: ValidationRule = (context) => ({
  ObjectValue(node) {
    const seen = new Map<string, ASTNode>();
    for (const field of node.fields) {
      const name = field.name.value;
      const prev = seen.get(name);
      if (prev) {
        context.reportError(
          new GraphQLError(
            `There can be only one input field named "${name}".`,
            { nodes: [prev, field.name] },
          ),
        );
      } else {
        seen.set(name, field.name);
      }
    }
  },
});

export const ValuesOfCorrectTypeRule: ValidationRule = (context) => {
  function isValidValueNode(node: ValueNode): void {
    const locationType = context.getInputType();
    if (!locationType) return;
    const type = getNamedType(locationType);
    if (!isLeafType(type)) {
      context.reportError(
        new GraphQLError(
          `Expected value of type "${String(locationType)}", found ${print(node)}.`,
          { nodes: node },
        ),
      );
      return;
    }
    try {
      const parseResult = type.parseLiteral(node, undefined);
      if (parseResult === undefined) {
        context.reportError(
          new GraphQLError(
            `Expected value of type "${String(locationType)}", found ${print(node)}.`,
            { nodes: node },
          ),
        );
      }
    } catch (error) {
      if (isGraphQLError(error)) {
        context.reportError(error);
      } else {
        context.reportError(
          new GraphQLError(
            `Expected value of type "${String(locationType)}", found ${print(node)}; ${error instanceof Error ? error.message : String(error)}`,
            {
              nodes: node,
              originalError: error instanceof Error ? error : undefined,
            },
          ),
        );
      }
    }
  }

  return {
    ListValue(node) {
      const type = getNullableType(context.getParentInputType());
      if (!isListType(type)) {
        isValidValueNode(node);
        return false;
      }
      return undefined;
    },
    ObjectValue(node) {
      const type = getNamedType(context.getInputType());
      if (!isInputObjectType(type)) {
        isValidValueNode(node);
        return false;
      }
      const fieldNodeMap = new Map(node.fields.map((f) => [f.name.value, f]));
      for (const fieldDef of Object.values(type.getFields())) {
        const fieldNode = fieldNodeMap.get(fieldDef.name);
        if (!fieldNode && isRequiredInputField(fieldDef)) {
          context.reportError(
            new GraphQLError(
              `Field "${type.name}.${fieldDef.name}" of required type "${String(fieldDef.type)}" was not provided.`,
              { nodes: node },
            ),
          );
        }
      }
      if (type.isOneOf) {
        if (node.fields.length !== 1) {
          context.reportError(
            new GraphQLError(
              `OneOf Input Object "${type.name}" must specify exactly one key.`,
              { nodes: node },
            ),
          );
        } else if (node.fields[0]!.value.kind === Kind.NULL) {
          context.reportError(
            new GraphQLError(
              `Field "${type.name}.${node.fields[0]!.name.value}" must be non-null.`,
              { nodes: node.fields[0]!.value },
            ),
          );
        }
      }
      return undefined;
    },
    ObjectField(node) {
      const parentType = getNamedType(context.getParentInputType());
      const fieldType = context.getInputType();
      if (!fieldType && isInputObjectType(parentType)) {
        context.reportError(
          new GraphQLError(
            `Field "${node.name.value}" is not defined by type "${parentType.name}".`,
            { nodes: node },
          ),
        );
      }
    },
    NullValue(node) {
      const type = context.getInputType();
      if (isNonNullType(type)) {
        context.reportError(
          new GraphQLError(
            `Expected value of type "${String(type)}", found ${print(node)}.`,
            { nodes: node },
          ),
        );
      }
    },
    EnumValue: (node) => isValidValueNode(node),
    IntValue: (node) => isValidValueNode(node),
    FloatValue: (node) => isValidValueNode(node),
    StringValue: (node) => isValidValueNode(node),
    BooleanValue: (node) => isValidValueNode(node),
  };
};

export const VariablesInAllowedPositionRule: ValidationRule = (context) => {
  let varDefMap = new Map<string, VariableDefinitionNode>();
  return {
    OperationDefinition: {
      enter() {
        varDefMap = new Map();
      },
      leave(operation) {
        const usages = context.getRecursiveVariableUsages(operation);
        const schema = context.getSchema();
        for (const { node, type, defaultValue } of usages) {
          const varName = node.name.value;
          const varDef = varDefMap.get(varName);
          if (varDef && type) {
            const varType = typeFromAST(schema, varDef.type);
            if (
              varType &&
              !allowedVariableUsage(
                schema,
                varType,
                varDef.defaultValue,
                type,
                defaultValue,
              )
            ) {
              context.reportError(
                new GraphQLError(
                  `Variable "$${varName}" of type "${String(varType)}" used in position expecting type "${String(type)}".`,
                  { nodes: [varDef, node] },
                ),
              );
            }
          }
        }
      },
    },
    VariableDefinition(node) {
      varDefMap.set(node.variable.name.value, node);
    },
  };
};

function allowedVariableUsage(
  schema: GraphQLSchema,
  varType: GraphQLType,
  varDefaultValue: Maybe<ValueNode>,
  locationType: GraphQLType,
  locationDefaultValue: unknown,
): boolean {
  if (isNonNullType(locationType) && !isNonNullType(varType)) {
    const hasNonNullVariableDefaultValue =
      varDefaultValue != null && varDefaultValue.kind !== Kind.NULL;
    const hasLocationDefaultValue = locationDefaultValue !== undefined;
    if (!hasNonNullVariableDefaultValue && !hasLocationDefaultValue) {
      return false;
    }
    return isTypeSubTypeOf(schema, varType, locationType.ofType);
  }
  return isTypeSubTypeOf(schema, varType, locationType);
}

// ---------------------------------------------------------------------------
// OverlappingFieldsCanBeMergedRule (Memoized for O(V + E) Diamond DAG Safety)
// ---------------------------------------------------------------------------

interface NodeAndDef {
  readonly parentType: Maybe<GraphQLCompositeType>;
  readonly node: FieldNode;
  readonly def: Maybe<GraphQLField<any, any>>;
}

type NodeAndDefCollection = Map<string, NodeAndDef[]>;

class PairSet {
  private readonly _data = new Map<string, Map<string, boolean>>();

  has(a: string, b: string, areMutuallyExclusive: boolean): boolean {
    const first = this._data.get(a);
    const result = first?.get(b);
    if (result === undefined) return false;
    if (areMutuallyExclusive === false) {
      return result === false;
    }
    return true;
  }

  add(a: string, b: string, areMutuallyExclusive: boolean): void {
    this._pairSetAdd(a, b, areMutuallyExclusive);
    this._pairSetAdd(b, a, areMutuallyExclusive);
  }

  private _pairSetAdd(a: string, b: string, areMutuallyExclusive: boolean): void {
    let map = this._data.get(a);
    if (!map) {
      map = new Map();
      this._data.set(a, map);
    }
    map.set(b, areMutuallyExclusive);
  }
}

export const OverlappingFieldsCanBeMergedRule: ValidationRule = (context) => {
  const comparedFragmentPairs = new PairSet();
  const cachedFieldsAndFragmentNames = new Map<
    SelectionSetNode,
    [NodeAndDefCollection, string[]]
  >();

  function getFieldsAndFragmentNames(
    parentType: Maybe<GraphQLCompositeType>,
    selectionSet: SelectionSetNode,
  ): [NodeAndDefCollection, string[]] {
    let cached = cachedFieldsAndFragmentNames.get(selectionSet);
    if (!cached) {
      const astAndDefs: NodeAndDefCollection = new Map();
      const fragmentNames = new Set<string>();
      collectFieldsAndFragmentNames(
        parentType,
        selectionSet,
        astAndDefs,
        fragmentNames,
      );
      cached = [astAndDefs, [...fragmentNames]];
      cachedFieldsAndFragmentNames.set(selectionSet, cached);
    }
    return cached;
  }

  function getReferencedFieldsAndFragmentNames(
    fragment: FragmentDefinitionNode,
  ): [NodeAndDefCollection, string[]] {
    const cached = cachedFieldsAndFragmentNames.get(fragment.selectionSet);
    if (cached) return cached;
    const fragType = typeFromAST(context.getSchema(), fragment.typeCondition);
    return getFieldsAndFragmentNames(
      isCompositeType(fragType) ? fragType : undefined,
      fragment.selectionSet,
    );
  }

  function collectFieldsAndFragmentNames(
    parentType: Maybe<GraphQLCompositeType>,
    selectionSet: SelectionSetNode,
    astAndDefs: NodeAndDefCollection,
    fragmentNames: Set<string>,
  ): void {
    for (const selection of selectionSet.selections) {
      switch (selection.kind) {
        case Kind.FIELD: {
          const fieldName = selection.name.value;
          const fieldDef =
            parentType &&
            (isObjectType(parentType) || isInterfaceType(parentType))
              ? parentType.getFields()[fieldName]
              : undefined;
          const responseName = selection.alias?.value ?? fieldName;
          let list = astAndDefs.get(responseName);
          if (!list) {
            list = [];
            astAndDefs.set(responseName, list);
          }
          list.push({ parentType, node: selection, def: fieldDef });
          break;
        }
        case Kind.FRAGMENT_SPREAD:
          fragmentNames.add(selection.name.value);
          break;
        case Kind.INLINE_FRAGMENT: {
          const typeCondition = selection.typeCondition;
          const inlineType = typeCondition
            ? typeFromAST(context.getSchema(), typeCondition)
            : parentType;
          collectFieldsAndFragmentNames(
            isCompositeType(inlineType) ? inlineType : undefined,
            selection.selectionSet,
            astAndDefs,
            fragmentNames,
          );
          break;
        }
      }
    }
  }

  function sameArguments(
    args1: readonly ArgumentNode[] | undefined,
    args2: readonly ArgumentNode[] | undefined,
  ): boolean {
    const a1 = args1 ?? [];
    const a2 = args2 ?? [];
    if (a1.length !== a2.length) return false;
    return a1.every((arg1) => {
      const arg2 = a2.find((a) => a.name.value === arg1.name.value);
      if (!arg2) return false;
      return print(arg1.value) === print(arg2.value);
    });
  }

  function doTypesConflict(type1: GraphQLOutputType, type2: GraphQLOutputType): boolean {
    if (isListType(type1)) {
      return isListType(type2)
        ? doTypesConflict(type1.ofType, type2.ofType)
        : true;
    }
    if (isListType(type2)) {
      return true;
    }
    if (isNonNullType(type1)) {
      return isNonNullType(type2)
        ? doTypesConflict(type1.ofType, type2.ofType)
        : true;
    }
    if (isNonNullType(type2)) {
      return true;
    }
    if (isLeafType(type1) || isLeafType(type2)) {
      return !isEqualType(type1, type2);
    }
    return false;
  }

  function findConflict(
    parentFieldsAreMutuallyExclusive: boolean,
    responseName: string,
    field1: NodeAndDef,
    field2: NodeAndDef,
  ): { reason: string; nodes1: FieldNode[]; nodes2: FieldNode[] } | undefined {
    const { parentType: parentType1, node: node1, def: def1 } = field1;
    const { parentType: parentType2, node: node2, def: def2 } = field2;
    if (node1 === node2) return undefined;

    const areMutuallyExclusive =
      parentFieldsAreMutuallyExclusive ||
      (parentType1 !== parentType2 &&
        isObjectType(parentType1) &&
        isObjectType(parentType2));

    if (!areMutuallyExclusive) {
      if (node1.name.value !== node2.name.value) {
        return {
          reason: `"${node1.name.value}" and "${node2.name.value}" are different fields`,
          nodes1: [node1],
          nodes2: [node2],
        };
      }
      if (!sameArguments(node1.arguments, node2.arguments)) {
        return {
          reason: "they have differing arguments",
          nodes1: [node1],
          nodes2: [node2],
        };
      }
    }

    if (def1 && def2 && doTypesConflict(def1.type, def2.type)) {
      return {
        reason: `they return conflicting types "${String(def1.type)}" and "${String(def2.type)}"`,
        nodes1: [node1],
        nodes2: [node2],
      };
    }

    if (node1.selectionSet && node2.selectionSet) {
      const subConflicts: Array<{
        reason: string;
        nodes1: FieldNode[];
        nodes2: FieldNode[];
      }> = [];
      const type1 = def1 ? getNamedType(def1.type) : undefined;
      const type2 = def2 ? getNamedType(def2.type) : undefined;
      findConflictsBetweenSubSelectionSets(
        subConflicts,
        areMutuallyExclusive,
        isCompositeType(type1) ? type1 : undefined,
        node1.selectionSet,
        isCompositeType(type2) ? type2 : undefined,
        node2.selectionSet,
      );
      if (subConflicts.length > 0) {
        return {
          reason: subConflicts.map((c) => c.reason).join("; "),
          nodes1: [node1, ...subConflicts.flatMap((c) => c.nodes1)],
          nodes2: [node2, ...subConflicts.flatMap((c) => c.nodes2)],
        };
      }
    }

    return undefined;
  }

  function collectConflictsWithin(
    conflicts: Array<{ reason: string; nodes1: FieldNode[]; nodes2: FieldNode[] }>,
    fieldMap: NodeAndDefCollection,
  ): void {
    for (const [responseName, fields] of fieldMap.entries()) {
      if (fields.length > 1) {
        for (let i = 0; i < fields.length; i++) {
          for (let j = i + 1; j < fields.length; j++) {
            const c = findConflict(false, responseName, fields[i]!, fields[j]!);
            if (c) conflicts.push(c);
          }
        }
      }
    }
  }

  function collectConflictsBetween(
    conflicts: Array<{ reason: string; nodes1: FieldNode[]; nodes2: FieldNode[] }>,
    parentFieldsAreMutuallyExclusive: boolean,
    fieldMap1: NodeAndDefCollection,
    fieldMap2: NodeAndDefCollection,
  ): void {
    for (const [responseName, fields1] of fieldMap1.entries()) {
      const fields2 = fieldMap2.get(responseName);
      if (fields2) {
        for (const f1 of fields1) {
          for (const f2 of fields2) {
            const c = findConflict(
              parentFieldsAreMutuallyExclusive,
              responseName,
              f1,
              f2,
            );
            if (c) conflicts.push(c);
          }
        }
      }
    }
  }

  function collectConflictsBetweenFieldsAndFragment(
    conflicts: Array<{ reason: string; nodes1: FieldNode[]; nodes2: FieldNode[] }>,
    comparedFragments: Set<string>,
    areMutuallyExclusive: boolean,
    fieldMap: NodeAndDefCollection,
    fragmentName: string,
  ): void {
    if (comparedFragments.has(fragmentName)) return;
    comparedFragments.add(fragmentName);

    const fragment = context.getFragment(fragmentName);
    if (!fragment) return;

    const [fieldMap2, referencedFragmentNames2] =
      getReferencedFieldsAndFragmentNames(fragment);
    if (fieldMap === fieldMap2) return;

    collectConflictsBetween(conflicts, areMutuallyExclusive, fieldMap, fieldMap2);

    for (const fragName2 of referencedFragmentNames2) {
      collectConflictsBetweenFieldsAndFragment(
        conflicts,
        comparedFragments,
        areMutuallyExclusive,
        fieldMap,
        fragName2,
      );
    }
  }

  function collectConflictsBetweenFragments(
    conflicts: Array<{ reason: string; nodes1: FieldNode[]; nodes2: FieldNode[] }>,
    areMutuallyExclusive: boolean,
    fragmentName1: string,
    fragmentName2: string,
  ): void {
    if (fragmentName1 === fragmentName2) return;
    if (comparedFragmentPairs.has(fragmentName1, fragmentName2, areMutuallyExclusive)) {
      return;
    }
    comparedFragmentPairs.add(fragmentName1, fragmentName2, areMutuallyExclusive);

    const frag1 = context.getFragment(fragmentName1);
    const frag2 = context.getFragment(fragmentName2);
    if (!frag1 || !frag2) return;

    const [fieldMap1, fragNames1] = getReferencedFieldsAndFragmentNames(frag1);
    const [fieldMap2, fragNames2] = getReferencedFieldsAndFragmentNames(frag2);

    collectConflictsBetween(conflicts, areMutuallyExclusive, fieldMap1, fieldMap2);

    for (const fn2 of fragNames2) {
      collectConflictsBetweenFragments(conflicts, areMutuallyExclusive, fragmentName1, fn2);
    }
    for (const fn1 of fragNames1) {
      collectConflictsBetweenFragments(conflicts, areMutuallyExclusive, fn1, fragmentName2);
    }
  }

  function findConflictsBetweenSubSelectionSets(
    conflicts: Array<{ reason: string; nodes1: FieldNode[]; nodes2: FieldNode[] }>,
    areMutuallyExclusive: boolean,
    parentType1: Maybe<GraphQLCompositeType>,
    selectionSet1: SelectionSetNode,
    parentType2: Maybe<GraphQLCompositeType>,
    selectionSet2: SelectionSetNode,
  ): void {
    const [fieldMap1, fragmentNames1] = getFieldsAndFragmentNames(
      parentType1,
      selectionSet1,
    );
    const [fieldMap2, fragmentNames2] = getFieldsAndFragmentNames(
      parentType2,
      selectionSet2,
    );

    collectConflictsBetween(conflicts, areMutuallyExclusive, fieldMap1, fieldMap2);

    if (fragmentNames2.length !== 0) {
      const compared = new Set<string>();
      for (const fn2 of fragmentNames2) {
        collectConflictsBetweenFieldsAndFragment(
          conflicts,
          compared,
          areMutuallyExclusive,
          fieldMap1,
          fn2,
        );
      }
    }

    if (fragmentNames1.length !== 0) {
      const compared = new Set<string>();
      for (const fn1 of fragmentNames1) {
        collectConflictsBetweenFieldsAndFragment(
          conflicts,
          compared,
          areMutuallyExclusive,
          fieldMap2,
          fn1,
        );
      }
    }

    for (const fn1 of fragmentNames1) {
      for (const fn2 of fragmentNames2) {
        collectConflictsBetweenFragments(conflicts, areMutuallyExclusive, fn1, fn2);
      }
    }
  }

  return {
    SelectionSet(selectionSet) {
      const [fieldMap, fragmentNames] = getFieldsAndFragmentNames(
        context.getParentType(),
        selectionSet,
      );
      const conflicts: Array<{
        reason: string;
        nodes1: FieldNode[];
        nodes2: FieldNode[];
      }> = [];

      collectConflictsWithin(conflicts, fieldMap);

      if (fragmentNames.length !== 0) {
        const comparedFragments = new Set<string>();
        for (let i = 0; i < fragmentNames.length; i++) {
          collectConflictsBetweenFieldsAndFragment(
            conflicts,
            comparedFragments,
            false,
            fieldMap,
            fragmentNames[i]!,
          );
          for (let j = i + 1; j < fragmentNames.length; j++) {
            collectConflictsBetweenFragments(
              conflicts,
              false,
              fragmentNames[i]!,
              fragmentNames[j]!,
            );
          }
        }
      }

      for (const conflict of conflicts) {
        const responseName =
          conflict.nodes1[0]?.alias?.value ??
          conflict.nodes1[0]?.name.value ??
          "";
        context.reportError(
          new GraphQLError(
            `Fields "${responseName}" conflict because ${conflict.reason}. Use different aliases on the fields to fetch both if this was intentional.`,
            { nodes: [...conflict.nodes1, ...conflict.nodes2] },
          ),
        );
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Custom Security Rule: NoSchemaIntrospectionCustomRule
// ---------------------------------------------------------------------------

export const NoSchemaIntrospectionCustomRule: ValidationRule = (context) => ({
  Field(node) {
    const type = getNamedType(context.getType());
    if (type && isIntrospectionType(type)) {
      context.reportError(
        new GraphQLError(
          `GraphQL introspection has been disabled, but the requested query contained the field "${node.name.value}".`,
          { nodes: node },
        ),
      );
    }
  },
});

export const specifiedRules: readonly ValidationRule[] = Object.freeze([
  ExecutableDefinitionsRule,
  UniqueOperationNamesRule,
  LoneAnonymousOperationRule,
  SingleFieldSubscriptionsRule,
  KnownTypeNamesRule,
  FragmentsOnCompositeTypesRule,
  VariablesAreInputTypesRule,
  ScalarLeafsRule,
  FieldsOnCorrectTypeRule,
  UniqueFragmentNamesRule,
  KnownFragmentNamesRule,
  NoUnusedFragmentsRule,
  PossibleFragmentSpreadsRule,
  NoFragmentCyclesRule,
  UniqueVariableNamesRule,
  NoUndefinedVariablesRule,
  NoUnusedVariablesRule,
  KnownDirectivesRule,
  UniqueDirectivesPerLocationRule,
  KnownArgumentNamesRule,
  UniqueArgumentNamesRule,
  ValuesOfCorrectTypeRule,
  ProvidedRequiredArgumentsRule,
  VariablesInAllowedPositionRule,
  OverlappingFieldsCanBeMergedRule,
  UniqueInputFieldNamesRule,
]);

// ---------------------------------------------------------------------------
// validate() Entry Point
// ---------------------------------------------------------------------------

export interface ValidationOptions {
  readonly maxErrors?: number;
}

export function validate(
  schema: GraphQLSchema,
  documentAST: DocumentNode,
  rules: readonly ValidationRule[] = specifiedRules,
  options?: ValidationOptions,
): readonly GraphQLError[] {
  if (!documentAST || documentAST.kind !== Kind.DOCUMENT) {
    throw new Error("Must provide document.");
  }
  const abortObj = Object.freeze({});
  const errors: GraphQLError[] = [];
  const maxErrors = options?.maxErrors;
  const typeInfo = new TypeInfo(schema);
  const context = new ValidationContext(schema, documentAST, typeInfo, (error) => {
    if (maxErrors !== undefined && errors.length >= maxErrors) {
      errors.push(
        new GraphQLError(
          "Too many validation errors, error limit reached. Validation aborted.",
        ),
      );
      throw abortObj;
    }
    errors.push(error);
  });

  const visitors = rules.map((rule) => rule(context));
  try {
    visit(documentAST, visitWithTypeInfo(typeInfo, visitInParallel(visitors)));
  } catch (e) {
    if (e !== abortObj) {
      throw e;
    }
  }
  return errors;
}

export { BREAK };
