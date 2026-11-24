/**
 * GraphQL October 2021 Spec AST Definitions, Source, Locations, Visitor & Traversal.
 * Zero external dependencies.
 */

export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

export class Source {
  readonly body: string;
  readonly name: string;
  readonly locationOffset: SourceLocation;
  private _lineStarts?: number[];

  constructor(
    body: string,
    name = "GraphQL request",
    locationOffset: SourceLocation = { line: 1, column: 1 },
  ) {
    this.body = body;
    this.name = name;
    this.locationOffset = locationOffset;
  }

  get [Symbol.toStringTag](): string {
    return "Source";
  }

  /**
   * O(log N) binary-search line/column lookup from byte offset.
   */
  getLocation(position: number): SourceLocation {
    if (!this._lineStarts) {
      const starts: number[] = [0];
      const body = this.body;
      const len = body.length;
      for (let i = 0; i < len; i++) {
        const ch = body.charCodeAt(i);
        if (ch === 10) {
          starts.push(i + 1);
        } else if (ch === 13) {
          if (body.charCodeAt(i + 1) === 10) {
            i++;
          }
          starts.push(i + 1);
        }
      }
      this._lineStarts = starts;
    }

    const starts = this._lineStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (starts[mid]! <= position) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    const line = lo + 1;
    const column = position - starts[lo]! + 1;
    return {
      line: line + this.locationOffset.line - 1,
      column: line === 1 ? column + this.locationOffset.column - 1 : column,
    };
  }
}

export function getLocation(source: Source, position: number): SourceLocation {
  if (typeof source.getLocation === "function") {
    return source.getLocation(position);
  }
  const src = new Source(source.body, source.name, source.locationOffset);
  return src.getLocation(position);
}

export const TokenKind = {
  SOF: "<SOF>",
  EOF: "<EOF>",
  BANG: "!",
  DOLLAR: "$",
  AMP: "&",
  PAREN_L: "(",
  PAREN_R: ")",
  SPREAD: "...",
  COLON: ":",
  EQUALS: "=",
  AT: "@",
  BRACKET_L: "[",
  BRACKET_R: "]",
  BRACE_L: "{",
  PIPE: "|",
  BRACE_R: "}",
  NAME: "Name",
  INT: "Int",
  FLOAT: "Float",
  STRING: "String",
  BLOCK_STRING: "BlockString",
  COMMENT: "Comment",
} as const;

export type TokenKindEnum = (typeof TokenKind)[keyof typeof TokenKind];

export class Token {
  readonly kind: TokenKindEnum;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly value: string;
  readonly prev: Token | null;
  next: Token | null;

  constructor(
    kind: TokenKindEnum,
    start: number,
    end: number,
    line: number,
    column: number,
    value = "",
    prev: Token | null = null,
  ) {
    this.kind = kind;
    this.start = start;
    this.end = end;
    this.line = line;
    this.column = column;
    this.value = value;
    this.prev = prev;
    this.next = null;
  }
}

export interface Location {
  readonly start: number;
  readonly end: number;
  readonly startToken: Token;
  readonly endToken: Token;
  readonly source: Source;
}

export const Kind = {
  // Name
  NAME: "Name",

  // Document
  DOCUMENT: "Document",
  OPERATION_DEFINITION: "OperationDefinition",
  VARIABLE_DEFINITION: "VariableDefinition",
  VARIABLE: "Variable",
  SELECTION_SET: "SelectionSet",
  FIELD: "Field",
  ARGUMENT: "Argument",

  // Fragments
  FRAGMENT_SPREAD: "FragmentSpread",
  INLINE_FRAGMENT: "InlineFragment",
  FRAGMENT_DEFINITION: "FragmentDefinition",

  // Values
  INT: "IntValue",
  FLOAT: "FloatValue",
  STRING: "StringValue",
  BOOLEAN: "BooleanValue",
  NULL: "NullValue",
  ENUM: "EnumValue",
  LIST: "ListValue",
  OBJECT: "ObjectValue",
  OBJECT_FIELD: "ObjectField",

  // Directives
  DIRECTIVE: "Directive",

  // Types
  NAMED_TYPE: "NamedType",
  LIST_TYPE: "ListType",
  NON_NULL_TYPE: "NonNullType",

  // Type System Definitions
  SCHEMA_DEFINITION: "SchemaDefinition",
  OPERATION_TYPE_DEFINITION: "OperationTypeDefinition",

  // Type Definitions
  SCALAR_TYPE_DEFINITION: "ScalarTypeDefinition",
  OBJECT_TYPE_DEFINITION: "ObjectTypeDefinition",
  FIELD_DEFINITION: "FieldDefinition",
  INPUT_VALUE_DEFINITION: "InputValueDefinition",
  INTERFACE_TYPE_DEFINITION: "InterfaceTypeDefinition",
  UNION_TYPE_DEFINITION: "UnionTypeDefinition",
  ENUM_TYPE_DEFINITION: "EnumTypeDefinition",
  ENUM_VALUE_DEFINITION: "EnumValueDefinition",
  INPUT_OBJECT_TYPE_DEFINITION: "InputObjectTypeDefinition",

  // Directive Definitions
  DIRECTIVE_DEFINITION: "DirectiveDefinition",

  // Type System Extensions
  SCHEMA_EXTENSION: "SchemaExtension",

  // Type Extensions
  SCALAR_TYPE_EXTENSION: "ScalarTypeExtension",
  OBJECT_TYPE_EXTENSION: "ObjectTypeExtension",
  INTERFACE_TYPE_EXTENSION: "InterfaceTypeExtension",
  UNION_TYPE_EXTENSION: "UnionTypeExtension",
  ENUM_TYPE_EXTENSION: "EnumTypeExtension",
  INPUT_OBJECT_TYPE_EXTENSION: "InputObjectTypeExtension",
} as const;

export type KindEnum = (typeof Kind)[keyof typeof Kind];

export const OperationTypeNode = {
  QUERY: "query",
  MUTATION: "mutation",
  SUBSCRIPTION: "subscription",
} as const;

export type OperationTypeNode =
  (typeof OperationTypeNode)[keyof typeof OperationTypeNode];

export const DirectiveLocation = {
  // Executable
  QUERY: "QUERY",
  MUTATION: "MUTATION",
  SUBSCRIPTION: "SUBSCRIPTION",
  FIELD: "FIELD",
  FRAGMENT_DEFINITION: "FRAGMENT_DEFINITION",
  FRAGMENT_SPREAD: "FRAGMENT_SPREAD",
  INLINE_FRAGMENT: "INLINE_FRAGMENT",
  VARIABLE_DEFINITION: "VARIABLE_DEFINITION",
  // Type System
  SCHEMA: "SCHEMA",
  SCALAR: "SCALAR",
  OBJECT: "OBJECT",
  FIELD_DEFINITION: "FIELD_DEFINITION",
  ARGUMENT_DEFINITION: "ARGUMENT_DEFINITION",
  INTERFACE: "INTERFACE",
  UNION: "UNION",
  ENUM: "ENUM",
  ENUM_VALUE: "ENUM_VALUE",
  INPUT_OBJECT: "INPUT_OBJECT",
  INPUT_FIELD_DEFINITION: "INPUT_FIELD_DEFINITION",
} as const;

export type DirectiveLocationEnum =
  (typeof DirectiveLocation)[keyof typeof DirectiveLocation];

// ---------------------------------------------------------------------------
// AST Node Interfaces
// ---------------------------------------------------------------------------

export interface NameNode {
  readonly kind: typeof Kind.NAME;
  readonly loc?: Location;
  readonly value: string;
}

export interface DocumentNode {
  readonly kind: typeof Kind.DOCUMENT;
  readonly loc?: Location;
  readonly definitions: readonly DefinitionNode[];
}

export type DefinitionNode =
  | ExecutableDefinitionNode
  | TypeSystemDefinitionNode
  | TypeSystemExtensionNode;

export type ExecutableDefinitionNode =
  | OperationDefinitionNode
  | FragmentDefinitionNode;

export interface OperationDefinitionNode {
  readonly kind: typeof Kind.OPERATION_DEFINITION;
  readonly loc?: Location;
  readonly operation: OperationTypeNode;
  readonly name?: NameNode;
  readonly variableDefinitions?: readonly VariableDefinitionNode[];
  readonly directives?: readonly DirectiveNode[];
  readonly selectionSet: SelectionSetNode;
}

export interface VariableDefinitionNode {
  readonly kind: typeof Kind.VARIABLE_DEFINITION;
  readonly loc?: Location;
  readonly variable: VariableNode;
  readonly type: TypeNode;
  readonly defaultValue?: ConstValueNode;
  readonly directives?: readonly ConstDirectiveNode[];
}

export interface VariableNode {
  readonly kind: typeof Kind.VARIABLE;
  readonly loc?: Location;
  readonly name: NameNode;
}

export interface SelectionSetNode {
  readonly kind: typeof Kind.SELECTION_SET;
  readonly loc?: Location;
  readonly selections: readonly SelectionNode[];
}

export type SelectionNode =
  | FieldNode
  | FragmentSpreadNode
  | InlineFragmentNode;

export interface FieldNode {
  readonly kind: typeof Kind.FIELD;
  readonly loc?: Location;
  readonly alias?: NameNode;
  readonly name: NameNode;
  readonly arguments?: readonly ArgumentNode[];
  readonly directives?: readonly DirectiveNode[];
  readonly selectionSet?: SelectionSetNode;
}

export interface ArgumentNode {
  readonly kind: typeof Kind.ARGUMENT;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly value: ValueNode;
}

export interface ConstArgumentNode {
  readonly kind: typeof Kind.ARGUMENT;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly value: ConstValueNode;
}

export interface FragmentSpreadNode {
  readonly kind: typeof Kind.FRAGMENT_SPREAD;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly directives?: readonly DirectiveNode[];
}

export interface InlineFragmentNode {
  readonly kind: typeof Kind.INLINE_FRAGMENT;
  readonly loc?: Location;
  readonly typeCondition?: NamedTypeNode;
  readonly directives?: readonly DirectiveNode[];
  readonly selectionSet: SelectionSetNode;
}

export interface FragmentDefinitionNode {
  readonly kind: typeof Kind.FRAGMENT_DEFINITION;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly variableDefinitions?: readonly VariableDefinitionNode[];
  readonly typeCondition: NamedTypeNode;
  readonly directives?: readonly DirectiveNode[];
  readonly selectionSet: SelectionSetNode;
}

export type ValueNode =
  | VariableNode
  | IntValueNode
  | FloatValueNode
  | StringValueNode
  | BooleanValueNode
  | NullValueNode
  | EnumValueNode
  | ListValueNode
  | ObjectValueNode;

export type ConstValueNode =
  | IntValueNode
  | FloatValueNode
  | StringValueNode
  | BooleanValueNode
  | NullValueNode
  | EnumValueNode
  | ConstListValueNode
  | ConstObjectValueNode;

export interface IntValueNode {
  readonly kind: typeof Kind.INT;
  readonly loc?: Location;
  readonly value: string;
}

export interface FloatValueNode {
  readonly kind: typeof Kind.FLOAT;
  readonly loc?: Location;
  readonly value: string;
}

export interface StringValueNode {
  readonly kind: typeof Kind.STRING;
  readonly loc?: Location;
  readonly value: string;
  readonly block?: boolean;
}

export interface BooleanValueNode {
  readonly kind: typeof Kind.BOOLEAN;
  readonly loc?: Location;
  readonly value: boolean;
}

export interface NullValueNode {
  readonly kind: typeof Kind.NULL;
  readonly loc?: Location;
}

export interface EnumValueNode {
  readonly kind: typeof Kind.ENUM;
  readonly loc?: Location;
  readonly value: string;
}

export interface ListValueNode {
  readonly kind: typeof Kind.LIST;
  readonly loc?: Location;
  readonly values: readonly ValueNode[];
}

export interface ConstListValueNode {
  readonly kind: typeof Kind.LIST;
  readonly loc?: Location;
  readonly values: readonly ConstValueNode[];
}

export interface ObjectValueNode {
  readonly kind: typeof Kind.OBJECT;
  readonly loc?: Location;
  readonly fields: readonly ObjectFieldNode[];
}

export interface ConstObjectValueNode {
  readonly kind: typeof Kind.OBJECT;
  readonly loc?: Location;
  readonly fields: readonly ConstObjectFieldNode[];
}

export interface ObjectFieldNode {
  readonly kind: typeof Kind.OBJECT_FIELD;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly value: ValueNode;
}

export interface ConstObjectFieldNode {
  readonly kind: typeof Kind.OBJECT_FIELD;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly value: ConstValueNode;
}

export interface DirectiveNode {
  readonly kind: typeof Kind.DIRECTIVE;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly arguments?: readonly ArgumentNode[];
}

export interface ConstDirectiveNode {
  readonly kind: typeof Kind.DIRECTIVE;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly arguments?: readonly ConstArgumentNode[];
}

export type TypeNode = NamedTypeNode | ListTypeNode | NonNullTypeNode;

export interface NamedTypeNode {
  readonly kind: typeof Kind.NAMED_TYPE;
  readonly loc?: Location;
  readonly name: NameNode;
}

export interface ListTypeNode {
  readonly kind: typeof Kind.LIST_TYPE;
  readonly loc?: Location;
  readonly type: TypeNode;
}

export interface NonNullTypeNode {
  readonly kind: typeof Kind.NON_NULL_TYPE;
  readonly loc?: Location;
  readonly type: NamedTypeNode | ListTypeNode;
}

export type TypeSystemDefinitionNode =
  | SchemaDefinitionNode
  | TypeDefinitionNode
  | DirectiveDefinitionNode;

export interface SchemaDefinitionNode {
  readonly kind: typeof Kind.SCHEMA_DEFINITION;
  readonly loc?: Location;
  readonly description?: StringValueNode;
  readonly directives?: readonly ConstDirectiveNode[];
  readonly operationTypes: readonly OperationTypeDefinitionNode[];
}

export interface OperationTypeDefinitionNode {
  readonly kind: typeof Kind.OPERATION_TYPE_DEFINITION;
  readonly loc?: Location;
  readonly operation: OperationTypeNode;
  readonly type: NamedTypeNode;
}

export type TypeDefinitionNode =
  | ScalarTypeDefinitionNode
  | ObjectTypeDefinitionNode
  | InterfaceTypeDefinitionNode
  | UnionTypeDefinitionNode
  | EnumTypeDefinitionNode
  | InputObjectTypeDefinitionNode;

export interface ScalarTypeDefinitionNode {
  readonly kind: typeof Kind.SCALAR_TYPE_DEFINITION;
  readonly loc?: Location;
  readonly description?: StringValueNode;
  readonly name: NameNode;
  readonly directives?: readonly ConstDirectiveNode[];
}

export interface ObjectTypeDefinitionNode {
  readonly kind: typeof Kind.OBJECT_TYPE_DEFINITION;
  readonly loc?: Location;
  readonly description?: StringValueNode;
  readonly name: NameNode;
  readonly interfaces?: readonly NamedTypeNode[];
  readonly directives?: readonly ConstDirectiveNode[];
  readonly fields?: readonly FieldDefinitionNode[];
}

export interface FieldDefinitionNode {
  readonly kind: typeof Kind.FIELD_DEFINITION;
  readonly loc?: Location;
  readonly description?: StringValueNode;
  readonly name: NameNode;
  readonly arguments?: readonly InputValueDefinitionNode[];
  readonly type: TypeNode;
  readonly directives?: readonly ConstDirectiveNode[];
}

export interface InputValueDefinitionNode {
  readonly kind: typeof Kind.INPUT_VALUE_DEFINITION;
  readonly loc?: Location;
  readonly description?: StringValueNode;
  readonly name: NameNode;
  readonly type: TypeNode;
  readonly defaultValue?: ConstValueNode;
  readonly directives?: readonly ConstDirectiveNode[];
}

export interface InterfaceTypeDefinitionNode {
  readonly kind: typeof Kind.INTERFACE_TYPE_DEFINITION;
  readonly loc?: Location;
  readonly description?: StringValueNode;
  readonly name: NameNode;
  readonly interfaces?: readonly NamedTypeNode[];
  readonly directives?: readonly ConstDirectiveNode[];
  readonly fields?: readonly FieldDefinitionNode[];
}

export interface UnionTypeDefinitionNode {
  readonly kind: typeof Kind.UNION_TYPE_DEFINITION;
  readonly loc?: Location;
  readonly description?: StringValueNode;
  readonly name: NameNode;
  readonly directives?: readonly ConstDirectiveNode[];
  readonly types?: readonly NamedTypeNode[];
}

export interface EnumTypeDefinitionNode {
  readonly kind: typeof Kind.ENUM_TYPE_DEFINITION;
  readonly loc?: Location;
  readonly description?: StringValueNode;
  readonly name: NameNode;
  readonly directives?: readonly ConstDirectiveNode[];
  readonly values?: readonly EnumValueDefinitionNode[];
}

export interface EnumValueDefinitionNode {
  readonly kind: typeof Kind.ENUM_VALUE_DEFINITION;
  readonly loc?: Location;
  readonly description?: StringValueNode;
  readonly name: NameNode;
  readonly directives?: readonly ConstDirectiveNode[];
}

export interface InputObjectTypeDefinitionNode {
  readonly kind: typeof Kind.INPUT_OBJECT_TYPE_DEFINITION;
  readonly loc?: Location;
  readonly description?: StringValueNode;
  readonly name: NameNode;
  readonly directives?: readonly ConstDirectiveNode[];
  readonly fields?: readonly InputValueDefinitionNode[];
}

export interface DirectiveDefinitionNode {
  readonly kind: typeof Kind.DIRECTIVE_DEFINITION;
  readonly loc?: Location;
  readonly description?: StringValueNode;
  readonly name: NameNode;
  readonly arguments?: readonly InputValueDefinitionNode[];
  readonly repeatable: boolean;
  readonly locations: readonly NameNode[];
}

export type TypeSystemExtensionNode = SchemaExtensionNode | TypeExtensionNode;

export interface SchemaExtensionNode {
  readonly kind: typeof Kind.SCHEMA_EXTENSION;
  readonly loc?: Location;
  readonly directives?: readonly ConstDirectiveNode[];
  readonly operationTypes?: readonly OperationTypeDefinitionNode[];
}

export type TypeExtensionNode =
  | ScalarTypeExtensionNode
  | ObjectTypeExtensionNode
  | InterfaceTypeExtensionNode
  | UnionTypeExtensionNode
  | EnumTypeExtensionNode
  | InputObjectTypeExtensionNode;

export interface ScalarTypeExtensionNode {
  readonly kind: typeof Kind.SCALAR_TYPE_EXTENSION;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly directives?: readonly ConstDirectiveNode[];
}

export interface ObjectTypeExtensionNode {
  readonly kind: typeof Kind.OBJECT_TYPE_EXTENSION;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly interfaces?: readonly NamedTypeNode[];
  readonly directives?: readonly ConstDirectiveNode[];
  readonly fields?: readonly FieldDefinitionNode[];
}

export interface InterfaceTypeExtensionNode {
  readonly kind: typeof Kind.INTERFACE_TYPE_EXTENSION;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly interfaces?: readonly NamedTypeNode[];
  readonly directives?: readonly ConstDirectiveNode[];
  readonly fields?: readonly FieldDefinitionNode[];
}

export interface UnionTypeExtensionNode {
  readonly kind: typeof Kind.UNION_TYPE_EXTENSION;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly directives?: readonly ConstDirectiveNode[];
  readonly types?: readonly NamedTypeNode[];
}

export interface EnumTypeExtensionNode {
  readonly kind: typeof Kind.ENUM_TYPE_EXTENSION;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly directives?: readonly ConstDirectiveNode[];
  readonly values?: readonly EnumValueDefinitionNode[];
}

export interface InputObjectTypeExtensionNode {
  readonly kind: typeof Kind.INPUT_OBJECT_TYPE_EXTENSION;
  readonly loc?: Location;
  readonly name: NameNode;
  readonly directives?: readonly ConstDirectiveNode[];
  readonly fields?: readonly InputValueDefinitionNode[];
}

export type ASTNode =
  | NameNode
  | DocumentNode
  | OperationDefinitionNode
  | VariableDefinitionNode
  | VariableNode
  | SelectionSetNode
  | FieldNode
  | ArgumentNode
  | FragmentSpreadNode
  | InlineFragmentNode
  | FragmentDefinitionNode
  | IntValueNode
  | FloatValueNode
  | StringValueNode
  | BooleanValueNode
  | NullValueNode
  | EnumValueNode
  | ListValueNode
  | ObjectValueNode
  | ObjectFieldNode
  | DirectiveNode
  | NamedTypeNode
  | ListTypeNode
  | NonNullTypeNode
  | SchemaDefinitionNode
  | OperationTypeDefinitionNode
  | ScalarTypeDefinitionNode
  | ObjectTypeDefinitionNode
  | FieldDefinitionNode
  | InputValueDefinitionNode
  | InterfaceTypeDefinitionNode
  | UnionTypeDefinitionNode
  | EnumTypeDefinitionNode
  | EnumValueDefinitionNode
  | InputObjectTypeDefinitionNode
  | DirectiveDefinitionNode
  | SchemaExtensionNode
  | ScalarTypeExtensionNode
  | ObjectTypeExtensionNode
  | InterfaceTypeExtensionNode
  | UnionTypeExtensionNode
  | EnumTypeExtensionNode
  | InputObjectTypeExtensionNode;

export interface ASTKindToNode {
  readonly Name: NameNode;
  readonly Document: DocumentNode;
  readonly OperationDefinition: OperationDefinitionNode;
  readonly VariableDefinition: VariableDefinitionNode;
  readonly Variable: VariableNode;
  readonly SelectionSet: SelectionSetNode;
  readonly Field: FieldNode;
  readonly Argument: ArgumentNode;
  readonly FragmentSpread: FragmentSpreadNode;
  readonly InlineFragment: InlineFragmentNode;
  readonly FragmentDefinition: FragmentDefinitionNode;
  readonly IntValue: IntValueNode;
  readonly FloatValue: FloatValueNode;
  readonly StringValue: StringValueNode;
  readonly BooleanValue: BooleanValueNode;
  readonly NullValue: NullValueNode;
  readonly EnumValue: EnumValueNode;
  readonly ListValue: ListValueNode;
  readonly ObjectValue: ObjectValueNode;
  readonly ObjectField: ObjectFieldNode;
  readonly Directive: DirectiveNode;
  readonly NamedType: NamedTypeNode;
  readonly ListType: ListTypeNode;
  readonly NonNullType: NonNullTypeNode;
  readonly SchemaDefinition: SchemaDefinitionNode;
  readonly OperationTypeDefinition: OperationTypeDefinitionNode;
  readonly ScalarTypeDefinition: ScalarTypeDefinitionNode;
  readonly ObjectTypeDefinition: ObjectTypeDefinitionNode;
  readonly FieldDefinition: FieldDefinitionNode;
  readonly InputValueDefinition: InputValueDefinitionNode;
  readonly InterfaceTypeDefinition: InterfaceTypeDefinitionNode;
  readonly UnionTypeDefinition: UnionTypeDefinitionNode;
  readonly EnumTypeDefinition: EnumTypeDefinitionNode;
  readonly EnumValueDefinition: EnumValueDefinitionNode;
  readonly InputObjectTypeDefinition: InputObjectTypeDefinitionNode;
  readonly DirectiveDefinition: DirectiveDefinitionNode;
  readonly SchemaExtension: SchemaExtensionNode;
  readonly ScalarTypeExtension: ScalarTypeExtensionNode;
  readonly ObjectTypeExtension: ObjectTypeExtensionNode;
  readonly InterfaceTypeExtension: InterfaceTypeExtensionNode;
  readonly UnionTypeExtension: UnionTypeExtensionNode;
  readonly EnumTypeExtension: EnumTypeExtensionNode;
  readonly InputObjectTypeExtension: InputObjectTypeExtensionNode;
}

export const QueryDocumentKeys: Readonly<Record<string, readonly string[]>> = {
  Name: [],
  Document: ["definitions"],
  OperationDefinition: [
    "name",
    "variableDefinitions",
    "directives",
    "selectionSet",
  ],
  VariableDefinition: ["variable", "type", "defaultValue", "directives"],
  Variable: ["name"],
  SelectionSet: ["selections"],
  Field: ["alias", "name", "arguments", "directives", "selectionSet"],
  Argument: ["name", "value"],
  FragmentSpread: ["name", "directives"],
  InlineFragment: ["typeCondition", "directives", "selectionSet"],
  FragmentDefinition: [
    "name",
    "variableDefinitions",
    "typeCondition",
    "directives",
    "selectionSet",
  ],
  IntValue: [],
  FloatValue: [],
  StringValue: [],
  BooleanValue: [],
  NullValue: [],
  EnumValue: [],
  ListValue: ["values"],
  ObjectValue: ["fields"],
  ObjectField: ["name", "value"],
  Directive: ["name", "arguments"],
  NamedType: ["name"],
  ListType: ["type"],
  NonNullType: ["type"],
  SchemaDefinition: ["description", "directives", "operationTypes"],
  OperationTypeDefinition: ["type"],
  ScalarTypeDefinition: ["description", "name", "directives"],
  ObjectTypeDefinition: [
    "description",
    "name",
    "interfaces",
    "directives",
    "fields",
  ],
  FieldDefinition: ["description", "name", "arguments", "type", "directives"],
  InputValueDefinition: [
    "description",
    "name",
    "type",
    "defaultValue",
    "directives",
  ],
  InterfaceTypeDefinition: [
    "description",
    "name",
    "interfaces",
    "directives",
    "fields",
  ],
  UnionTypeDefinition: ["description", "name", "directives", "types"],
  EnumTypeDefinition: ["description", "name", "directives", "values"],
  EnumValueDefinition: ["description", "name", "directives"],
  InputObjectTypeDefinition: ["description", "name", "directives", "fields"],
  DirectiveDefinition: ["description", "name", "arguments", "locations"],
  SchemaExtension: ["directives", "operationTypes"],
  ScalarTypeExtension: ["name", "directives"],
  ObjectTypeExtension: ["name", "interfaces", "directives", "fields"],
  InterfaceTypeExtension: ["name", "interfaces", "directives", "fields"],
  UnionTypeExtension: ["name", "directives", "types"],
  EnumTypeExtension: ["name", "directives", "values"],
  InputObjectTypeExtension: ["name", "directives", "fields"],
};

export const BREAK: Readonly<Record<string, never>> = Object.freeze({});

export type ASTVisitFn<TVisitedNode extends ASTNode = ASTNode> = (
  node: TVisitedNode,
  key: string | number | undefined,
  parent: ASTNode | readonly ASTNode[] | undefined,
  path: readonly (string | number)[],
  ancestors: readonly (ASTNode | readonly ASTNode[])[],
) => any;

export interface EnterLeaveVisitor<TNode extends ASTNode = ASTNode> {
  readonly enter?: ASTVisitFn<TNode>;
  readonly leave?: ASTVisitFn<TNode>;
}

export type ASTVisitor =
  | EnterLeaveVisitor<ASTNode>
  | {
      readonly enter?:
        | ASTVisitFn<ASTNode>
        | { readonly [K in keyof ASTKindToNode]?: ASTVisitFn<ASTKindToNode[K]> };
      readonly leave?:
        | ASTVisitFn<ASTNode>
        | { readonly [K in keyof ASTKindToNode]?: ASTVisitFn<ASTKindToNode[K]> };
    }
  | {
      readonly [K in keyof ASTKindToNode]?:
        | ASTVisitFn<ASTKindToNode[K]>
        | EnterLeaveVisitor<ASTKindToNode[K]>;
    };

export function isASTNode(maybeNode: unknown): maybeNode is ASTNode {
  return (
    maybeNode !== null &&
    typeof maybeNode === "object" &&
    typeof (maybeNode as { kind?: unknown }).kind === "string"
  );
}

export function getEnterLeaveForKind(
  visitor: ASTVisitor,
  kind: string,
): { enter?: ASTVisitFn<any>; leave?: ASTVisitFn<any> } {
  const rec = visitor as Record<string, any>;
  const kindVisitor = rec[kind];
  if (typeof kindVisitor === "object" && kindVisitor !== null) {
    return kindVisitor;
  }
  if (typeof kindVisitor === "function") {
    return { enter: kindVisitor };
  }
  const enter =
    typeof rec.enter === "function"
      ? rec.enter
      : typeof rec.enter === "object" && rec.enter !== null
        ? rec.enter[kind]
        : undefined;
  const leave =
    typeof rec.leave === "function"
      ? rec.leave
      : typeof rec.leave === "object" && rec.leave !== null
        ? rec.leave[kind]
        : undefined;
  return { enter, leave };
}

/**
 * Depth-first AST traversal supporting `enter`, `leave`, `false` (skip subtree),
 * `null` (remove node), node replacement, and `BREAK`.
 */
export function visit<T extends ASTNode>(
  root: T,
  visitor: ASTVisitor,
  visitorKeys: Readonly<Record<string, readonly string[]>> = QueryDocumentKeys,
): any {
  let stack:
    | {
        inArray: boolean;
        index: number;
        keys: readonly string[];
        edits: Array<[string | number, any]>;
        prev: any;
      }
    | undefined = undefined;
  let inArray = Array.isArray(root);
  let keys: readonly string[] = [root as unknown as string];
  let index = -1;
  let edits: Array<[string | number, any]> = [];
  let node: any = root;
  let key: string | number | undefined = undefined;
  let parent: any = undefined;
  const path: (string | number)[] = [];
  const ancestors: (ASTNode | readonly ASTNode[])[] = [];

  do {
    index++;
    const isLeaving = index === keys.length;
    const isEdited = isLeaving && edits.length !== 0;

    if (isLeaving) {
      key = ancestors.length === 0 ? undefined : path[path.length - 1];
      node = parent;
      parent = ancestors.pop();
      if (isEdited) {
        if (inArray) {
          node = node.slice();
          let editOffset = 0;
          for (let i = 0; i < edits.length; i++) {
            const editKey = edits[i]![0] as number;
            const editValue = edits[i]![1];
            const arrayKey = editKey - editOffset;
            if (editValue === null) {
              node.splice(arrayKey, 1);
              editOffset++;
            } else {
              node[arrayKey] = editValue;
            }
          }
        } else {
          const clone = { ...node };
          for (let i = 0; i < edits.length; i++) {
            clone[edits[i]![0]] = edits[i]![1];
          }
          node = clone;
        }
      }
      index = stack!.index;
      keys = stack!.keys;
      edits = stack!.edits;
      inArray = stack!.inArray;
      stack = stack!.prev;
    } else if (parent) {
      key = inArray ? index : keys[index]!;
      node = parent[key];
      if (node === null || node === undefined) {
        continue;
      }
      path.push(key);
    }

    let result: any;
    if (!Array.isArray(node)) {
      const visitFn = isLeaving
        ? getEnterLeaveForKind(visitor, node.kind).leave
        : getEnterLeaveForKind(visitor, node.kind).enter;
      result = visitFn?.call(visitor, node, key, parent, path, ancestors);

      if (result === BREAK) {
        break;
      }

      if (result === false) {
        if (!isLeaving) {
          path.pop();
          continue;
        }
      } else if (result !== undefined) {
        edits.push([key!, result]);
        if (!isLeaving) {
          if (isASTNode(result)) {
            node = result;
          } else {
            path.pop();
            continue;
          }
        }
      }
    }

    if (result === undefined && isEdited) {
      edits.push([key!, node]);
    }

    if (isLeaving) {
      path.pop();
    } else {
      stack = { inArray, index, keys, edits, prev: stack };
      inArray = Array.isArray(node);
      keys = inArray ? node : (visitorKeys[node.kind] ?? []);
      index = -1;
      edits = [];
      if (parent) {
        ancestors.push(parent);
      }
      parent = node;
    }
  } while (stack !== undefined);

  if (edits.length !== 0) {
    return edits[edits.length - 1]![1];
  }
  return root;
}

/**
 * Runs multiple ASTVisitors in a single traversal pass.
 */
export function visitInParallel(visitors: readonly ASTVisitor[]): ASTVisitor {
  const skipping: Array<any> = new Array(visitors.length).fill(null);
  return {
    enter(node, key, parent, path, ancestors) {
      for (let i = 0; i < visitors.length; i++) {
        if (skipping[i] === null) {
          const fn = getEnterLeaveForKind(visitors[i]!, node.kind).enter;
          if (fn) {
            const result = fn.call(
              visitors[i],
              node,
              key,
              parent,
              path,
              ancestors,
            );
            if (result === false) {
              skipping[i] = node;
            } else if (result === BREAK) {
              skipping[i] = BREAK;
            } else if (result !== undefined) {
              return result;
            }
          }
        }
      }
      return undefined;
    },
    leave(node, key, parent, path, ancestors) {
      for (let i = 0; i < visitors.length; i++) {
        if (skipping[i] === null) {
          const fn = getEnterLeaveForKind(visitors[i]!, node.kind).leave;
          if (fn) {
            const result = fn.call(
              visitors[i],
              node,
              key,
              parent,
              path,
              ancestors,
            );
            if (result === BREAK) {
              skipping[i] = BREAK;
            } else if (result !== undefined && result !== false) {
              return result;
            }
          }
        } else if (skipping[i] === node) {
          skipping[i] = null;
        }
      }
      return undefined;
    },
  };
}

/**
 * Returns the OperationDefinitionNode in `documentAST` matching `operationName`,
 * or the sole operation if `operationName` is omitted, or `null` if not found / ambiguous.
 */
export function getOperationAST(
  documentAST: DocumentNode,
  operationName?: string | null,
): OperationDefinitionNode | null {
  let operation: OperationDefinitionNode | null = null;
  for (const definition of documentAST.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      if (operationName == null) {
        if (operation) {
          return null;
        }
        operation = definition;
      } else if (definition.name?.value === operationName) {
        return definition;
      }
    }
  }
  return operation;
}
