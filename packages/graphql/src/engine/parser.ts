/**
 * GraphQL October 2021 Spec Recursive-Descent Parser.
 * Parses full Executable Documents and Type System Documents (SDL & Extensions).
 * Zero external dependencies.
 */

import {
  type ArgumentNode,
  type BooleanValueNode,
  type ConstArgumentNode,
  type ConstDirectiveNode,
  type ConstObjectFieldNode,
  type ConstValueNode,
  type DefinitionNode,
  type DirectiveDefinitionNode,
  type DirectiveNode,
  type DocumentNode,
  type EnumTypeDefinitionNode,
  type EnumTypeExtensionNode,
  type EnumValueDefinitionNode,
  type EnumValueNode,
  type FieldDefinitionNode,
  type FieldNode,
  type FloatValueNode,
  type FragmentDefinitionNode,
  type FragmentSpreadNode,
  type InlineFragmentNode,
  type InputObjectTypeDefinitionNode,
  type InputObjectTypeExtensionNode,
  type InputValueDefinitionNode,
  type InterfaceTypeDefinitionNode,
  type InterfaceTypeExtensionNode,
  type IntValueNode,
  Kind,
  type ListValueNode,
  type Location,
  type NamedTypeNode,
  type NameNode,
  type NullValueNode,
  type ObjectFieldNode,
  type ObjectTypeDefinitionNode,
  type ObjectTypeExtensionNode,
  type ObjectValueNode,
  type OperationDefinitionNode,
  type OperationTypeDefinitionNode,
  OperationTypeNode,
  type ScalarTypeDefinitionNode,
  type ScalarTypeExtensionNode,
  type SchemaDefinitionNode,
  type SchemaExtensionNode,
  type SelectionNode,
  type SelectionSetNode,
  Source,
  type StringValueNode,
  type Token,
  TokenKind,
  type TokenKindEnum,
  type TypeNode,
  type UnionTypeDefinitionNode,
  type UnionTypeExtensionNode,
  type ValueNode,
  type VariableDefinitionNode,
  type VariableNode,
} from "./ast";
import { type GraphQLError, syntaxError } from "./error";
import { Lexer } from "./lexer";

export interface ParseOptions {
  readonly noLocation?: boolean;
  readonly maxTokens?: number;
  readonly allowLegacyFragmentVariables?: boolean;
}

function getTokenDesc(token: Token): string {
  const value = token.value;
  if (
    token.kind === TokenKind.NAME ||
    token.kind === TokenKind.INT ||
    token.kind === TokenKind.FLOAT ||
    token.kind === TokenKind.STRING ||
    token.kind === TokenKind.BLOCK_STRING
  ) {
    return `${token.kind} "${value}"`;
  }
  return token.kind;
}

class Parser {
  private readonly _lexer: Lexer;
  private readonly _options: ParseOptions;
  private _tokenCounter = 0;

  constructor(source: string | Source, options: ParseOptions = {}) {
    let src: Source;
    if (typeof source === "string") {
      src = new Source(source);
    } else if (source instanceof Source) {
      src = source;
    } else {
      src = new Source(
        (source as Source).body,
        (source as Source).name,
        (source as Source).locationOffset,
      );
    }
    this._lexer = new Lexer(src);
    this._options = options;
  }

  private get token(): Token {
    return this._lexer.token;
  }

  private advanceLexer(): Token {
    const maxTokens = this._options.maxTokens;
    const token = this._lexer.advance();
    if (maxTokens !== undefined && token.kind !== TokenKind.EOF) {
      this._tokenCounter++;
      if (this._tokenCounter > maxTokens) {
        throw syntaxError(
          this._lexer.source,
          token.start,
          `Document contains more that ${maxTokens} tokens. Parsing aborted.`,
        );
      }
    }
    return token;
  }

  private loc(startToken: Token): Location | undefined {
    if (this._options.noLocation) {
      return undefined;
    }
    const endToken = this._lexer.lastToken;
    return {
      start: startToken.start,
      end: endToken.end,
      startToken,
      endToken,
      source: this._lexer.source,
    };
  }

  private node<T extends Record<string, unknown>>(
    startToken: Token,
    obj: T,
  ): T {
    const location = this.loc(startToken);
    if (location !== undefined) {
      return { ...obj, loc: location };
    }
    return obj;
  }

  private peek(kind: TokenKindEnum): boolean {
    return this.token.kind === kind;
  }

  private peekDescription(): boolean {
    return (
      this.peek(TokenKind.STRING) || this.peek(TokenKind.BLOCK_STRING)
    );
  }

  private expectToken(kind: TokenKindEnum): Token {
    const token = this.token;
    if (token.kind === kind) {
      this.advanceLexer();
      return token;
    }
    throw syntaxError(
      this._lexer.source,
      token.start,
      `Expected ${kind}, found ${getTokenDesc(token)}.`,
    );
  }

  private expectOptionalToken(kind: TokenKindEnum): Token | undefined {
    const token = this.token;
    if (token.kind === kind) {
      this.advanceLexer();
      return token;
    }
    return undefined;
  }

  private expectKeyword(value: string): void {
    const token = this.token;
    if (token.kind === TokenKind.NAME && token.value === value) {
      this.advanceLexer();
      return;
    }
    throw syntaxError(
      this._lexer.source,
      token.start,
      `Expected "${value}", found ${getTokenDesc(token)}.`,
    );
  }

  private expectOptionalKeyword(value: string): boolean {
    const token = this.token;
    if (token.kind === TokenKind.NAME && token.value === value) {
      this.advanceLexer();
      return true;
    }
    return false;
  }

  private unexpected(atToken?: Token): GraphQLError {
    const token = atToken ?? this.token;
    return syntaxError(
      this._lexer.source,
      token.start,
      `Unexpected ${getTokenDesc(token)}.`,
    );
  }

  private any<T>(
    openKind: TokenKindEnum,
    parseFn: () => T,
    closeKind: TokenKindEnum,
  ): T[] {
    this.expectToken(openKind);
    const nodes: T[] = [];
    while (!this.expectOptionalToken(closeKind)) {
      nodes.push(parseFn());
    }
    return nodes;
  }

  private optionalMany<T>(
    openKind: TokenKindEnum,
    parseFn: () => T,
    closeKind: TokenKindEnum,
  ): T[] {
    if (this.expectOptionalToken(openKind)) {
      const nodes: T[] = [];
      do {
        nodes.push(parseFn());
      } while (!this.expectOptionalToken(closeKind));
      return nodes;
    }
    return [];
  }

  private many<T>(
    openKind: TokenKindEnum,
    parseFn: () => T,
    closeKind: TokenKindEnum,
  ): T[] {
    this.expectToken(openKind);
    const nodes: T[] = [];
    do {
      nodes.push(parseFn());
    } while (!this.expectOptionalToken(closeKind));
    return nodes;
  }

  private delimitedMany<T>(
    delimiterKind: TokenKindEnum,
    parseFn: () => T,
  ): T[] {
    this.expectOptionalToken(delimiterKind);
    const nodes: T[] = [];
    do {
      nodes.push(parseFn());
    } while (this.expectOptionalToken(delimiterKind));
    return nodes;
  }

  // -------------------------------------------------------------------------
  // Entry Points
  // -------------------------------------------------------------------------

  parseDocument(): DocumentNode {
    const start = this.token;
    return this.node(start, {
      kind: Kind.DOCUMENT,
      definitions: this.many(
        TokenKind.SOF,
        () => this.parseDefinition(),
        TokenKind.EOF,
      ),
    });
  }

  parseValueEntry(isConst: boolean): ValueNode {
    this.advanceLexer();
    const value = this.parseValueLiteral(isConst);
    this.expectToken(TokenKind.EOF);
    return value;
  }

  parseTypeEntry(): TypeNode {
    this.advanceLexer();
    const type = this.parseTypeReference();
    this.expectToken(TokenKind.EOF);
    return type;
  }

  // -------------------------------------------------------------------------
  // Definitions
  // -------------------------------------------------------------------------

  private parseDefinition(): DefinitionNode {
    if (this.peek(TokenKind.BRACE_L)) {
      return this.parseOperationDefinition();
    }

    const hasDescription = this.peekDescription();
    const keywordToken = hasDescription
      ? this._lexer.lookahead()
      : this.token;

    if (keywordToken.kind === TokenKind.NAME) {
      switch (keywordToken.value) {
        case "schema":
          return this.parseSchemaDefinition();
        case "scalar":
          return this.parseScalarTypeDefinition();
        case "type":
          return this.parseObjectTypeDefinition();
        case "interface":
          return this.parseInterfaceTypeDefinition();
        case "union":
          return this.parseUnionTypeDefinition();
        case "enum":
          return this.parseEnumTypeDefinition();
        case "input":
          return this.parseInputObjectTypeDefinition();
        case "directive":
          return this.parseDirectiveDefinition();
        default:
          if (hasDescription) {
            throw syntaxError(
              this._lexer.source,
              this.token.start,
              "Unexpected description, descriptions are supported only on type definitions.",
            );
          }
          switch (keywordToken.value) {
            case "query":
            case "mutation":
            case "subscription":
              return this.parseOperationDefinition();
            case "fragment":
              return this.parseFragmentDefinition();
            case "extend":
              return this.parseTypeSystemExtension();
          }
      }
    }

    throw this.unexpected(keywordToken);
  }

  // -------------------------------------------------------------------------
  // Executable Definitions
  // -------------------------------------------------------------------------

  private parseName(): NameNode {
    const token = this.expectToken(TokenKind.NAME);
    return this.node(token, {
      kind: Kind.NAME,
      value: token.value,
    });
  }

  private parseOperationDefinition(): OperationDefinitionNode {
    const start = this.token;
    if (this.peek(TokenKind.BRACE_L)) {
      return this.node(start, {
        kind: Kind.OPERATION_DEFINITION,
        operation: OperationTypeNode.QUERY,
        name: undefined,
        variableDefinitions: [],
        directives: [],
        selectionSet: this.parseSelectionSet(),
      });
    }
    const operation = this.parseOperationType();
    let name: NameNode | undefined;
    if (this.peek(TokenKind.NAME)) {
      name = this.parseName();
    }
    return this.node(start, {
      kind: Kind.OPERATION_DEFINITION,
      operation,
      name,
      variableDefinitions: this.parseVariableDefinitions(),
      directives: this.parseDirectives(false) as DirectiveNode[],
      selectionSet: this.parseSelectionSet(),
    });
  }

  private parseOperationType(): OperationTypeNode {
    const token = this.expectToken(TokenKind.NAME);
    switch (token.value) {
      case "query":
        return OperationTypeNode.QUERY;
      case "mutation":
        return OperationTypeNode.MUTATION;
      case "subscription":
        return OperationTypeNode.SUBSCRIPTION;
      default:
        throw this.unexpected(token);
    }
  }

  private parseVariableDefinitions(): VariableDefinitionNode[] {
    return this.optionalMany(
      TokenKind.PAREN_L,
      () => this.parseVariableDefinition(),
      TokenKind.PAREN_R,
    );
  }

  private parseVariableDefinition(): VariableDefinitionNode {
    const start = this.token;
    const variable = this.parseVariable();
    this.expectToken(TokenKind.COLON);
    const type = this.parseTypeReference();
    const defaultValue = this.expectOptionalToken(TokenKind.EQUALS)
      ? (this.parseValueLiteral(true) as ConstValueNode)
      : undefined;
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    return this.node(start, {
      kind: Kind.VARIABLE_DEFINITION,
      variable,
      type,
      defaultValue,
      directives,
    });
  }

  private parseVariable(): VariableNode {
    const start = this.token;
    this.expectToken(TokenKind.DOLLAR);
    return this.node(start, {
      kind: Kind.VARIABLE,
      name: this.parseName(),
    });
  }

  private parseSelectionSet(): SelectionSetNode {
    const start = this.token;
    return this.node(start, {
      kind: Kind.SELECTION_SET,
      selections: this.many(
        TokenKind.BRACE_L,
        () => this.parseSelection(),
        TokenKind.BRACE_R,
      ),
    });
  }

  private parseSelection(): SelectionNode {
    return this.peek(TokenKind.SPREAD)
      ? this.parseFragment()
      : this.parseField();
  }

  private parseField(): FieldNode {
    const start = this.token;
    const nameOrAlias = this.parseName();
    let alias: NameNode | undefined;
    let name: NameNode;
    if (this.expectOptionalToken(TokenKind.COLON)) {
      alias = nameOrAlias;
      name = this.parseName();
    } else {
      name = nameOrAlias;
    }

    const args = this.parseArguments(false) as ArgumentNode[];
    const directives = this.parseDirectives(false) as DirectiveNode[];
    const selectionSet = this.peek(TokenKind.BRACE_L)
      ? this.parseSelectionSet()
      : undefined;

    return this.node(start, {
      kind: Kind.FIELD,
      alias,
      name,
      arguments: args,
      directives,
      selectionSet,
    });
  }

  private parseArguments(
    isConst: boolean,
  ): ArgumentNode[] | ConstArgumentNode[] {
    return this.optionalMany(
      TokenKind.PAREN_L,
      () => this.parseArgument(isConst),
      TokenKind.PAREN_R,
    ) as ArgumentNode[];
  }

  private parseArgument(isConst: boolean): ArgumentNode {
    const start = this.token;
    const name = this.parseName();
    this.expectToken(TokenKind.COLON);
    const value = this.parseValueLiteral(isConst);
    return this.node(start, {
      kind: Kind.ARGUMENT,
      name,
      value,
    });
  }

  private parseFragment(): FragmentSpreadNode | InlineFragmentNode {
    const start = this.token;
    this.expectToken(TokenKind.SPREAD);
    const hasTypeCondition = this.expectOptionalKeyword("on");
    if (!hasTypeCondition && this.peek(TokenKind.NAME)) {
      return this.node(start, {
        kind: Kind.FRAGMENT_SPREAD,
        name: this.parseFragmentName(),
        directives: this.parseDirectives(false) as DirectiveNode[],
      });
    }
    return this.node(start, {
      kind: Kind.INLINE_FRAGMENT,
      typeCondition: hasTypeCondition ? this.parseNamedType() : undefined,
      directives: this.parseDirectives(false) as DirectiveNode[],
      selectionSet: this.parseSelectionSet(),
    });
  }

  private parseFragmentDefinition(): FragmentDefinitionNode {
    const start = this.token;
    this.expectKeyword("fragment");
    const name = this.parseFragmentName();
    const variableDefinitions = this._options.allowLegacyFragmentVariables
      ? this.parseVariableDefinitions()
      : undefined;
    this.expectKeyword("on");
    const typeCondition = this.parseNamedType();
    const directives = this.parseDirectives(false) as DirectiveNode[];
    const selectionSet = this.parseSelectionSet();
    return this.node(start, {
      kind: Kind.FRAGMENT_DEFINITION,
      name,
      ...(variableDefinitions ? { variableDefinitions } : {}),
      typeCondition,
      directives,
      selectionSet,
    });
  }

  private parseFragmentName(): NameNode {
    if (this.token.value === "on") {
      throw this.unexpected();
    }
    return this.parseName();
  }

  // -------------------------------------------------------------------------
  // Values
  // -------------------------------------------------------------------------

  private parseValueLiteral(isConst: boolean): ValueNode {
    const token = this.token;
    switch (token.kind) {
      case TokenKind.BRACKET_L:
        return this.parseList(isConst);
      case TokenKind.BRACE_L:
        return this.parseObject(isConst);
      case TokenKind.INT:
        this.advanceLexer();
        return this.node(token, {
          kind: Kind.INT,
          value: token.value,
        }) as IntValueNode;
      case TokenKind.FLOAT:
        this.advanceLexer();
        return this.node(token, {
          kind: Kind.FLOAT,
          value: token.value,
        }) as FloatValueNode;
      case TokenKind.STRING:
      case TokenKind.BLOCK_STRING:
        return this.parseStringLiteral();
      case TokenKind.NAME:
        this.advanceLexer();
        switch (token.value) {
          case "true":
            return this.node(token, {
              kind: Kind.BOOLEAN,
              value: true,
            }) as BooleanValueNode;
          case "false":
            return this.node(token, {
              kind: Kind.BOOLEAN,
              value: false,
            }) as BooleanValueNode;
          case "null":
            return this.node(token, {
              kind: Kind.NULL,
            }) as NullValueNode;
          default:
            return this.node(token, {
              kind: Kind.ENUM,
              value: token.value,
            }) as EnumValueNode;
        }
      case TokenKind.DOLLAR:
        if (!isConst) {
          return this.parseVariable();
        }
        break;
    }
    throw this.unexpected();
  }

  private parseStringLiteral(): StringValueNode {
    const token = this.token;
    this.advanceLexer();
    return this.node(token, {
      kind: Kind.STRING,
      value: token.value,
      block: token.kind === TokenKind.BLOCK_STRING,
    });
  }

  private parseList(isConst: boolean): ListValueNode {
    const start = this.token;
    return this.node(start, {
      kind: Kind.LIST,
      values: this.any(
        TokenKind.BRACKET_L,
        () => this.parseValueLiteral(isConst),
        TokenKind.BRACKET_R,
      ),
    });
  }

  private parseObject(isConst: boolean): ObjectValueNode {
    const start = this.token;
    return this.node(start, {
      kind: Kind.OBJECT,
      fields: this.any(
        TokenKind.BRACE_L,
        () => this.parseObjectField(isConst),
        TokenKind.BRACE_R,
      ),
    });
  }

  private parseObjectField(
    isConst: boolean,
  ): ObjectFieldNode | ConstObjectFieldNode {
    const start = this.token;
    const name = this.parseName();
    this.expectToken(TokenKind.COLON);
    const value = this.parseValueLiteral(isConst);
    return this.node(start, {
      kind: Kind.OBJECT_FIELD,
      name,
      value,
    }) as ObjectFieldNode;
  }

  // -------------------------------------------------------------------------
  // Directives & Types
  // -------------------------------------------------------------------------

  private parseDirectives(
    isConst: boolean,
  ): DirectiveNode[] | ConstDirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek(TokenKind.AT)) {
      directives.push(this.parseDirective(isConst));
    }
    return directives;
  }

  private parseDirective(isConst: boolean): DirectiveNode {
    const start = this.token;
    this.expectToken(TokenKind.AT);
    return this.node(start, {
      kind: Kind.DIRECTIVE,
      name: this.parseName(),
      arguments: this.parseArguments(isConst) as ArgumentNode[],
    });
  }

  private parseTypeReference(): TypeNode {
    const start = this.token;
    let type: TypeNode;
    if (this.expectOptionalToken(TokenKind.BRACKET_L)) {
      const innerType = this.parseTypeReference();
      this.expectToken(TokenKind.BRACKET_R);
      type = this.node(start, {
        kind: Kind.LIST_TYPE,
        type: innerType,
      });
    } else {
      type = this.parseNamedType();
    }

    if (this.expectOptionalToken(TokenKind.BANG)) {
      return this.node(start, {
        kind: Kind.NON_NULL_TYPE,
        type: type as NamedTypeNode | { kind: typeof Kind.LIST_TYPE; type: TypeNode },
      });
    }
    return type;
  }

  private parseNamedType(): NamedTypeNode {
    const start = this.token;
    return this.node(start, {
      kind: Kind.NAMED_TYPE,
      name: this.parseName(),
    });
  }

  // -------------------------------------------------------------------------
  // Type System Definitions (SDL)
  // -------------------------------------------------------------------------

  private parseDescription(): StringValueNode | undefined {
    if (this.peekDescription()) {
      return this.parseStringLiteral();
    }
    return undefined;
  }

  private parseSchemaDefinition(): SchemaDefinitionNode {
    const start = this.token;
    const description = this.parseDescription();
    this.expectKeyword("schema");
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    const operationTypes = this.many(
      TokenKind.BRACE_L,
      () => this.parseOperationTypeDefinition(),
      TokenKind.BRACE_R,
    );
    return this.node(start, {
      kind: Kind.SCHEMA_DEFINITION,
      description,
      directives,
      operationTypes,
    });
  }

  private parseOperationTypeDefinition(): OperationTypeDefinitionNode {
    const start = this.token;
    const operation = this.parseOperationType();
    this.expectToken(TokenKind.COLON);
    const type = this.parseNamedType();
    return this.node(start, {
      kind: Kind.OPERATION_TYPE_DEFINITION,
      operation,
      type,
    });
  }

  private parseScalarTypeDefinition(): ScalarTypeDefinitionNode {
    const start = this.token;
    const description = this.parseDescription();
    this.expectKeyword("scalar");
    const name = this.parseName();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    return this.node(start, {
      kind: Kind.SCALAR_TYPE_DEFINITION,
      description,
      name,
      directives,
    });
  }

  private parseObjectTypeDefinition(): ObjectTypeDefinitionNode {
    const start = this.token;
    const description = this.parseDescription();
    this.expectKeyword("type");
    const name = this.parseName();
    const interfaces = this.parseImplementsInterfaces();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    const fields = this.parseFieldsDefinition();
    return this.node(start, {
      kind: Kind.OBJECT_TYPE_DEFINITION,
      description,
      name,
      interfaces,
      directives,
      fields,
    });
  }

  private parseImplementsInterfaces(): NamedTypeNode[] {
    if (!this.expectOptionalKeyword("implements")) {
      return [];
    }
    return this.delimitedMany(TokenKind.AMP, () => this.parseNamedType());
  }

  private parseFieldsDefinition(): FieldDefinitionNode[] {
    return this.optionalMany(
      TokenKind.BRACE_L,
      () => this.parseFieldDefinition(),
      TokenKind.BRACE_R,
    );
  }

  private parseFieldDefinition(): FieldDefinitionNode {
    const start = this.token;
    const description = this.parseDescription();
    const name = this.parseName();
    const args = this.parseArgumentDefs();
    this.expectToken(TokenKind.COLON);
    const type = this.parseTypeReference();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    return this.node(start, {
      kind: Kind.FIELD_DEFINITION,
      description,
      name,
      arguments: args,
      type,
      directives,
    });
  }

  private parseArgumentDefs(): InputValueDefinitionNode[] {
    return this.optionalMany(
      TokenKind.PAREN_L,
      () => this.parseInputValueDef(),
      TokenKind.PAREN_R,
    );
  }

  private parseInputValueDef(): InputValueDefinitionNode {
    const start = this.token;
    const description = this.parseDescription();
    const name = this.parseName();
    this.expectToken(TokenKind.COLON);
    const type = this.parseTypeReference();
    const defaultValue = this.expectOptionalToken(TokenKind.EQUALS)
      ? (this.parseValueLiteral(true) as ConstValueNode)
      : undefined;
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    return this.node(start, {
      kind: Kind.INPUT_VALUE_DEFINITION,
      description,
      name,
      type,
      defaultValue,
      directives,
    });
  }

  private parseInterfaceTypeDefinition(): InterfaceTypeDefinitionNode {
    const start = this.token;
    const description = this.parseDescription();
    this.expectKeyword("interface");
    const name = this.parseName();
    const interfaces = this.parseImplementsInterfaces();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    const fields = this.parseFieldsDefinition();
    return this.node(start, {
      kind: Kind.INTERFACE_TYPE_DEFINITION,
      description,
      name,
      interfaces,
      directives,
      fields,
    });
  }

  private parseUnionTypeDefinition(): UnionTypeDefinitionNode {
    const start = this.token;
    const description = this.parseDescription();
    this.expectKeyword("union");
    const name = this.parseName();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    const types = this.parseUnionMemberTypes();
    return this.node(start, {
      kind: Kind.UNION_TYPE_DEFINITION,
      description,
      name,
      directives,
      types,
    });
  }

  private parseUnionMemberTypes(): NamedTypeNode[] {
    return this.expectOptionalToken(TokenKind.EQUALS)
      ? this.delimitedMany(TokenKind.PIPE, () => this.parseNamedType())
      : [];
  }

  private parseEnumTypeDefinition(): EnumTypeDefinitionNode {
    const start = this.token;
    const description = this.parseDescription();
    this.expectKeyword("enum");
    const name = this.parseName();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    const values = this.parseEnumValuesDefinition();
    return this.node(start, {
      kind: Kind.ENUM_TYPE_DEFINITION,
      description,
      name,
      directives,
      values,
    });
  }

  private parseEnumValuesDefinition(): EnumValueDefinitionNode[] {
    return this.optionalMany(
      TokenKind.BRACE_L,
      () => this.parseEnumValueDefinition(),
      TokenKind.BRACE_R,
    );
  }

  private parseEnumValueDefinition(): EnumValueDefinitionNode {
    const start = this.token;
    const description = this.parseDescription();
    const name = this.parseEnumValueName();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    return this.node(start, {
      kind: Kind.ENUM_VALUE_DEFINITION,
      description,
      name,
      directives,
    });
  }

  private parseEnumValueName(): NameNode {
    if (
      this.token.value === "true" ||
      this.token.value === "false" ||
      this.token.value === "null"
    ) {
      throw syntaxError(
        this._lexer.source,
        this.token.start,
        `${getTokenDesc(this.token)} is reserved and cannot be used for an enum value.`,
      );
    }
    return this.parseName();
  }

  private parseInputObjectTypeDefinition(): InputObjectTypeDefinitionNode {
    const start = this.token;
    const description = this.parseDescription();
    this.expectKeyword("input");
    const name = this.parseName();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    const fields = this.parseInputFieldsDefinition();
    return this.node(start, {
      kind: Kind.INPUT_OBJECT_TYPE_DEFINITION,
      description,
      name,
      directives,
      fields,
    });
  }

  private parseInputFieldsDefinition(): InputValueDefinitionNode[] {
    return this.optionalMany(
      TokenKind.BRACE_L,
      () => this.parseInputValueDef(),
      TokenKind.BRACE_R,
    );
  }

  private parseDirectiveDefinition(): DirectiveDefinitionNode {
    const start = this.token;
    const description = this.parseDescription();
    this.expectKeyword("directive");
    this.expectToken(TokenKind.AT);
    const name = this.parseName();
    const args = this.parseArgumentDefs();
    const repeatable = this.expectOptionalKeyword("repeatable");
    this.expectKeyword("on");
    const locations = this.parseDirectiveLocations();
    return this.node(start, {
      kind: Kind.DIRECTIVE_DEFINITION,
      description,
      name,
      arguments: args,
      repeatable,
      locations,
    });
  }

  private parseDirectiveLocations(): NameNode[] {
    return this.delimitedMany(TokenKind.PIPE, () => this.parseName());
  }

  // -------------------------------------------------------------------------
  // Type System Extensions
  // -------------------------------------------------------------------------

  private parseTypeSystemExtension(): DefinitionNode {
    const keywordToken = this._lexer.lookahead();
    if (keywordToken.kind === TokenKind.NAME) {
      switch (keywordToken.value) {
        case "schema":
          return this.parseSchemaExtension();
        case "scalar":
          return this.parseScalarTypeExtension();
        case "type":
          return this.parseObjectTypeExtension();
        case "interface":
          return this.parseInterfaceTypeExtension();
        case "union":
          return this.parseUnionTypeExtension();
        case "enum":
          return this.parseEnumTypeExtension();
        case "input":
          return this.parseInputObjectTypeExtension();
      }
    }
    throw this.unexpected(keywordToken);
  }

  private parseSchemaExtension(): SchemaExtensionNode {
    const start = this.token;
    this.expectKeyword("extend");
    this.expectKeyword("schema");
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    const operationTypes = this.optionalMany(
      TokenKind.BRACE_L,
      () => this.parseOperationTypeDefinition(),
      TokenKind.BRACE_R,
    );
    if (directives.length === 0 && operationTypes.length === 0) {
      throw this.unexpected();
    }
    return this.node(start, {
      kind: Kind.SCHEMA_EXTENSION,
      directives,
      operationTypes,
    });
  }

  private parseScalarTypeExtension(): ScalarTypeExtensionNode {
    const start = this.token;
    this.expectKeyword("extend");
    this.expectKeyword("scalar");
    const name = this.parseName();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    if (directives.length === 0) {
      throw this.unexpected();
    }
    return this.node(start, {
      kind: Kind.SCALAR_TYPE_EXTENSION,
      name,
      directives,
    });
  }

  private parseObjectTypeExtension(): ObjectTypeExtensionNode {
    const start = this.token;
    this.expectKeyword("extend");
    this.expectKeyword("type");
    const name = this.parseName();
    const interfaces = this.parseImplementsInterfaces();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    const fields = this.parseFieldsDefinition();
    if (
      interfaces.length === 0 &&
      directives.length === 0 &&
      fields.length === 0
    ) {
      throw this.unexpected();
    }
    return this.node(start, {
      kind: Kind.OBJECT_TYPE_EXTENSION,
      name,
      interfaces,
      directives,
      fields,
    });
  }

  private parseInterfaceTypeExtension(): InterfaceTypeExtensionNode {
    const start = this.token;
    this.expectKeyword("extend");
    this.expectKeyword("interface");
    const name = this.parseName();
    const interfaces = this.parseImplementsInterfaces();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    const fields = this.parseFieldsDefinition();
    if (
      interfaces.length === 0 &&
      directives.length === 0 &&
      fields.length === 0
    ) {
      throw this.unexpected();
    }
    return this.node(start, {
      kind: Kind.INTERFACE_TYPE_EXTENSION,
      name,
      interfaces,
      directives,
      fields,
    });
  }

  private parseUnionTypeExtension(): UnionTypeExtensionNode {
    const start = this.token;
    this.expectKeyword("extend");
    this.expectKeyword("union");
    const name = this.parseName();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    const types = this.parseUnionMemberTypes();
    if (directives.length === 0 && types.length === 0) {
      throw this.unexpected();
    }
    return this.node(start, {
      kind: Kind.UNION_TYPE_EXTENSION,
      name,
      directives,
      types,
    });
  }

  private parseEnumTypeExtension(): EnumTypeExtensionNode {
    const start = this.token;
    this.expectKeyword("extend");
    this.expectKeyword("enum");
    const name = this.parseName();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    const values = this.parseEnumValuesDefinition();
    if (directives.length === 0 && values.length === 0) {
      throw this.unexpected();
    }
    return this.node(start, {
      kind: Kind.ENUM_TYPE_EXTENSION,
      name,
      directives,
      values,
    });
  }

  private parseInputObjectTypeExtension(): InputObjectTypeExtensionNode {
    const start = this.token;
    this.expectKeyword("extend");
    this.expectKeyword("input");
    const name = this.parseName();
    const directives = this.parseDirectives(true) as ConstDirectiveNode[];
    const fields = this.parseInputFieldsDefinition();
    if (directives.length === 0 && fields.length === 0) {
      throw this.unexpected();
    }
    return this.node(start, {
      kind: Kind.INPUT_OBJECT_TYPE_EXTENSION,
      name,
      directives,
      fields,
    });
  }
}

export function parse(
  source: string | Source,
  options?: ParseOptions,
): DocumentNode {
  return new Parser(source, options).parseDocument();
}

export function parseValue(
  source: string | Source,
  options?: ParseOptions,
): ValueNode {
  return new Parser(source, options).parseValueEntry(false);
}

export function parseConstValue(
  source: string | Source,
  options?: ParseOptions,
): ConstValueNode {
  return new Parser(source, options).parseValueEntry(true) as ConstValueNode;
}

export function parseType(
  source: string | Source,
  options?: ParseOptions,
): TypeNode {
  return new Parser(source, options).parseTypeEntry();
}
