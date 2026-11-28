import {
  dirname,
  existsSyncPath,
  extname,
  join,
  readTextSync,
  resolve,
} from "@bunest/core";
import { getLineAndColumnAtPos } from "./lexer";
import {
  parseTypeScript,
  type RawArrayLiteralExpression,
  type RawArrayType,
  type RawArrowFunction,
  type RawAsExpression,
  type RawBlock,
  type RawCallExpression,
  type RawClassDeclaration,
  type RawConstructorDeclaration,
  type RawDecorator,
  type RawEnumDeclaration,
  type RawExportDeclaration,
  type RawExportSpecifier,
  type RawExpressionWithTypeArguments,
  type RawFunctionDeclaration,
  type RawFunctionExpression,
  type RawFunctionType,
  type RawIdentifier,
  type RawImportDeclaration,
  type RawImportSpecifier,
  type RawInterfaceDeclaration,
  type RawLiteralType,
  type RawMethodDeclaration,
  type RawMethodSignature,
  type RawNewExpression,
  type RawNode,
  type RawNumericLiteral,
  type RawObjectLiteralExpression,
  type RawParameter,
  type RawParenthesizedExpression,
  type RawParenthesizedType,
  type RawPropertyAccessExpression,
  type RawPropertyAssignment,
  type RawPropertyDeclaration,
  type RawPropertySignature,
  type RawReturnStatement,
  type RawShorthandPropertyAssignment,
  type RawSourceFile,
  type RawStringLiteral,
  type RawTupleType,
  type RawTypeAliasDeclaration,
  type RawTypeLiteral,
  type RawTypeOperator,
  type RawTypeReference,
  type RawUnionOrIntersectionType,
  type RawVariableDeclaration,
  type RawVariableStatement,
} from "./parser";
import {
  TypeResolver,
  type BunestSymbol,
  type BunestType,
  type ResolverProjectHost,
} from "./resolver";
import { SyntaxKind } from "./syntax-kind";

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

const EXPRESSION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.CallExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ClassExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.TypeAssertionExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.TemplateExpression,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.BinaryExpression,
  SyntaxKind.PrefixUnaryExpression,
  SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.AwaitExpression,
  SyntaxKind.YieldExpression,
  SyntaxKind.TypeOfExpression,
  SyntaxKind.VoidExpression,
  SyntaxKind.DeleteExpression,
  SyntaxKind.JsxExpression,
]);

// ============================================================================
// Base AST Node + `Node.is*` Type Guards
// ============================================================================

export class BunestNode {
  readonly kind: SyntaxKind;
  readonly start: number;
  end: number;
  protected sf: BunestSourceFile;
  protected readonly parentNode?: BunestNode;
  protected readonly childNodes: BunestNode[] = [];

  constructor(
    raw: RawNode,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    this.kind = raw.kind;
    this.start = raw.start;
    this.end = raw.end;
    this.sf = sf;
    this.parentNode = parent;
  }

  getKind(): SyntaxKind {
    return this.kind;
  }

  getStart(): number {
    return this.start;
  }

  getEnd(): number {
    return this.end;
  }

  getText(): string {
    return this.sf.getFullText().slice(this.start, this.end);
  }

  getSourceFile(): BunestSourceFile {
    return this.sf;
  }

  getParent(): BunestNode | undefined {
    return this.parentNode;
  }

  getChildren(): BunestNode[] {
    return this.childNodes;
  }

  getChildAt(index: number): BunestNode | undefined {
    return this.childNodes[index];
  }

  getType(): BunestType {
    return this.sf.getResolver().getNodeType(this);
  }

  getSymbol(): BunestSymbol | undefined {
    if (this.kind === SyntaxKind.Identifier) {
      return this.sf
        .getResolver()
        .resolveIdentifierSymbol(this.getText(), this.sf, this);
    }
    return undefined;
  }

  getDescendantsOfKind(kind: SyntaxKind): BunestNode[] {
    const out: BunestNode[] = [];
    const visit = (node: BunestNode): void => {
      for (const child of node.childNodes) {
        if (child.kind === kind) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  // ─── Static Type Guards (compatible with ts-morph `Node.is*`) ────────────

  static isObjectLiteralExpression(
    node: BunestNode | undefined,
  ): node is BunestObjectLiteralExpression {
    return node?.kind === SyntaxKind.ObjectLiteralExpression;
  }

  static isPropertyAssignment(
    node: BunestNode | undefined,
  ): node is BunestPropertyAssignment {
    return node?.kind === SyntaxKind.PropertyAssignment;
  }

  static isShorthandPropertyAssignment(
    node: BunestNode | undefined,
  ): node is BunestShorthandPropertyAssignment {
    return node?.kind === SyntaxKind.ShorthandPropertyAssignment;
  }

  static isArrayLiteralExpression(
    node: BunestNode | undefined,
  ): node is BunestArrayLiteralExpression {
    return node?.kind === SyntaxKind.ArrayLiteralExpression;
  }

  static isIdentifier(
    node: BunestNode | undefined,
  ): node is BunestIdentifier {
    return node?.kind === SyntaxKind.Identifier;
  }

  static isCallExpression(
    node: BunestNode | undefined,
  ): node is BunestCallExpression {
    return node?.kind === SyntaxKind.CallExpression;
  }

  static isNewExpression(
    node: BunestNode | undefined,
  ): node is BunestNewExpression {
    return node?.kind === SyntaxKind.NewExpression;
  }

  static isPropertyAccessExpression(
    node: BunestNode | undefined,
  ): node is BunestPropertyAccessExpression {
    return node?.kind === SyntaxKind.PropertyAccessExpression;
  }

  static isArrowFunction(
    node: BunestNode | undefined,
  ): node is BunestArrowFunction {
    return node?.kind === SyntaxKind.ArrowFunction;
  }

  static isStringLiteral(
    node: BunestNode | undefined,
  ): node is BunestStringLiteral {
    return node?.kind === SyntaxKind.StringLiteral;
  }

  static isNoSubstitutionTemplateLiteral(
    node: BunestNode | undefined,
  ): node is BunestStringLiteral {
    return node?.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
  }

  static isNumericLiteral(
    node: BunestNode | undefined,
  ): node is BunestNumericLiteral {
    return node?.kind === SyntaxKind.NumericLiteral;
  }

  static isParenthesizedExpression(
    node: BunestNode | undefined,
  ): node is BunestParenthesizedExpression {
    return node?.kind === SyntaxKind.ParenthesizedExpression;
  }

  static isAsExpression(
    node: BunestNode | undefined,
  ): node is BunestAsExpression {
    return node?.kind === SyntaxKind.AsExpression;
  }

  static isSatisfiesExpression(
    node: BunestNode | undefined,
  ): node is BunestAsExpression {
    return node?.kind === SyntaxKind.SatisfiesExpression;
  }

  static isUnionTypeNode(
    node: BunestNode | undefined,
  ): node is BunestUnionTypeNode {
    return node?.kind === SyntaxKind.UnionType;
  }

  static isExpression(node: BunestNode | undefined): node is BunestNode {
    return node !== undefined && EXPRESSION_KINDS.has(node.kind);
  }

  static isClassDeclaration(
    node: BunestNode | undefined,
  ): node is BunestClassDeclaration {
    return node?.kind === SyntaxKind.ClassDeclaration;
  }

  static isInterfaceDeclaration(
    node: BunestNode | undefined,
  ): node is BunestInterfaceDeclaration {
    return node?.kind === SyntaxKind.InterfaceDeclaration;
  }

  static isTypeAliasDeclaration(
    node: BunestNode | undefined,
  ): node is BunestTypeAliasDeclaration {
    return node?.kind === SyntaxKind.TypeAliasDeclaration;
  }

  static isEnumDeclaration(
    node: BunestNode | undefined,
  ): node is BunestEnumDeclaration {
    return node?.kind === SyntaxKind.EnumDeclaration;
  }

  static isFunctionDeclaration(
    node: BunestNode | undefined,
  ): node is BunestFunctionDeclaration {
    return node?.kind === SyntaxKind.FunctionDeclaration;
  }

  static isVariableDeclaration(
    node: BunestNode | undefined,
  ): node is BunestVariableDeclaration {
    return node?.kind === SyntaxKind.VariableDeclaration;
  }

  static isDecorator(
    node: BunestNode | undefined,
  ): node is BunestDecorator {
    return node?.kind === SyntaxKind.Decorator;
  }
}

// ============================================================================
// Concrete Node Subclasses
// ============================================================================

export class BunestIdentifier extends BunestNode {
  private readonly rawText: string;

  constructor(raw: RawIdentifier, sf: BunestSourceFile, parent?: BunestNode) {
    super(raw, sf, parent);
    this.rawText = raw.text;
  }

  override getText(): string {
    return this.rawText;
  }
}

export class BunestStringLiteral extends BunestNode {
  private readonly literalValue: string;

  constructor(
    raw: RawStringLiteral,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.literalValue = raw.value;
  }

  getLiteralValue(): string {
    return this.literalValue;
  }
}

export class BunestNumericLiteral extends BunestNode {
  private readonly literalValue: number;

  constructor(
    raw: RawNumericLiteral,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.literalValue = raw.value;
  }

  getLiteralValue(): number {
    return this.literalValue;
  }
}

export class BunestDecorator extends BunestNode {
  private readonly expression: BunestNode;

  constructor(raw: RawDecorator, sf: BunestSourceFile, parent?: BunestNode) {
    super(raw, sf, parent);
    this.expression = wrapRawNode(raw.expression, sf, this);
    this.childNodes.push(this.expression);
  }

  getExpression(): BunestNode {
    return this.expression;
  }

  getCallExpression(): BunestCallExpression | undefined {
    return BunestNode.isCallExpression(this.expression)
      ? this.expression
      : undefined;
  }

  getArguments(): BunestNode[] {
    return this.getCallExpression()?.getArguments() ?? [];
  }

  getName(): string {
    const target = BunestNode.isCallExpression(this.expression)
      ? this.expression.getExpression()
      : this.expression;
    if (BunestNode.isPropertyAccessExpression(target)) {
      return target.getName();
    }
    return target.getText();
  }
}

export class BunestImportSpecifier extends BunestNode {
  private readonly typeOnly: boolean;
  private readonly nameNode: BunestIdentifier;
  private readonly aliasNode?: BunestIdentifier;

  constructor(
    raw: RawImportSpecifier,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.typeOnly = raw.isTypeOnly;
    this.nameNode = new BunestIdentifier(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
    if (raw.alias) {
      this.aliasNode = new BunestIdentifier(raw.alias, sf, this);
      this.childNodes.push(this.aliasNode);
    }
  }

  isTypeOnly(): boolean {
    return this.typeOnly;
  }

  getName(): string {
    return this.nameNode.getText();
  }

  getNameNode(): BunestIdentifier {
    return this.nameNode;
  }

  getAliasNode(): BunestIdentifier | undefined {
    return this.aliasNode;
  }
}

export class BunestImportDeclaration extends BunestNode {
  private readonly typeOnly: boolean;
  private readonly defaultImport?: BunestIdentifier;
  private readonly namespaceImport?: BunestIdentifier;
  private readonly namedImports: BunestImportSpecifier[];
  private readonly moduleSpecifier: BunestStringLiteral;

  constructor(
    raw: RawImportDeclaration,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.typeOnly = raw.isTypeOnly;
    if (raw.defaultImport) {
      this.defaultImport = new BunestIdentifier(raw.defaultImport, sf, this);
      this.childNodes.push(this.defaultImport);
    }
    if (raw.namespaceImport) {
      this.namespaceImport = new BunestIdentifier(
        raw.namespaceImport,
        sf,
        this,
      );
      this.childNodes.push(this.namespaceImport);
    }
    this.namedImports = raw.namedImports.map((s) => {
      const wrapped = new BunestImportSpecifier(s, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    this.moduleSpecifier = new BunestStringLiteral(
      raw.moduleSpecifier,
      sf,
      this,
    );
    this.childNodes.push(this.moduleSpecifier);
  }

  isTypeOnly(): boolean {
    return this.typeOnly;
  }

  getDefaultImport(): BunestIdentifier | undefined {
    return this.defaultImport;
  }

  getNamespaceImport(): BunestIdentifier | undefined {
    return this.namespaceImport;
  }

  getNamedImports(): BunestImportSpecifier[] {
    return this.namedImports;
  }

  getModuleSpecifier(): BunestStringLiteral {
    return this.moduleSpecifier;
  }

  getModuleSpecifierValue(): string {
    return this.moduleSpecifier.getLiteralValue();
  }
}

export class BunestExportSpecifier extends BunestNode {
  private readonly nameNode: BunestIdentifier;
  private readonly aliasNode?: BunestIdentifier;

  constructor(
    raw: RawExportSpecifier,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.nameNode = new BunestIdentifier(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
    if (raw.alias) {
      this.aliasNode = new BunestIdentifier(raw.alias, sf, this);
      this.childNodes.push(this.aliasNode);
    }
  }

  getName(): string {
    return this.nameNode.getText();
  }

  getAliasName(): string | undefined {
    return this.aliasNode?.getText();
  }
}

export class BunestExportDeclaration extends BunestNode {
  private readonly namespaceExport: boolean;
  private readonly namedExports: BunestExportSpecifier[];
  private readonly moduleSpecifier?: BunestStringLiteral;

  constructor(
    raw: RawExportDeclaration,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.namespaceExport = raw.isNamespaceExport;
    this.namedExports = raw.namedExports.map((e) => {
      const wrapped = new BunestExportSpecifier(e, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    if (raw.moduleSpecifier) {
      this.moduleSpecifier = new BunestStringLiteral(
        raw.moduleSpecifier,
        sf,
        this,
      );
      this.childNodes.push(this.moduleSpecifier);
    }
  }

  isNamespaceExport(): boolean {
    return this.namespaceExport;
  }

  getNamedExports(): BunestExportSpecifier[] {
    return this.namedExports;
  }

  getModuleSpecifierValue(): string | undefined {
    return this.moduleSpecifier?.getLiteralValue();
  }
}

export class BunestExpressionWithTypeArguments extends BunestNode {
  private readonly expression: BunestNode;
  private readonly typeArguments: BunestNode[];

  constructor(
    raw: RawExpressionWithTypeArguments,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.expression = wrapRawNode(raw.expression, sf, this);
    this.childNodes.push(this.expression);
    this.typeArguments = raw.typeArguments.map((t) => {
      const wrapped = wrapRawNode(t, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
  }

  getExpression(): BunestNode {
    return this.expression;
  }

  getTypeArguments(): BunestNode[] {
    return this.typeArguments;
  }
}

export class BunestParameterDeclaration extends BunestNode {
  private readonly decorators: BunestDecorator[];
  private readonly modifiers: BunestNode[];
  private readonly nameNode: BunestNode;
  private readonly questionToken: boolean;
  private readonly isRest: boolean;
  private readonly typeNode?: BunestNode;
  private readonly initializer?: BunestNode;

  constructor(raw: RawParameter, sf: BunestSourceFile, parent?: BunestNode) {
    super(raw, sf, parent);
    this.decorators = raw.decorators.map((d) => {
      const wrapped = new BunestDecorator(d, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    this.modifiers = raw.modifiers.map((m) => new BunestNode(m, sf, this));
    this.nameNode = wrapRawNode(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
    this.questionToken = raw.questionToken;
    this.isRest = raw.isRest;
    if (raw.typeNode) {
      this.typeNode = wrapRawNode(raw.typeNode, sf, this);
      this.childNodes.push(this.typeNode);
    }
    if (raw.initializer) {
      this.initializer = wrapRawNode(raw.initializer, sf, this);
      this.childNodes.push(this.initializer);
    }
  }

  getName(): string {
    return this.nameNode.getText();
  }

  getNameNode(): BunestNode {
    return this.nameNode;
  }

  getDecorators(): BunestDecorator[] {
    return this.decorators;
  }

  getModifiers(): BunestNode[] {
    return this.modifiers;
  }

  isOptional(): boolean {
    return this.questionToken;
  }

  hasQuestionToken(): boolean {
    return this.questionToken;
  }

  isRestParameter(): boolean {
    return this.isRest;
  }

  hasInitializer(): boolean {
    return this.initializer !== undefined;
  }

  getInitializer(): BunestNode | undefined {
    return this.initializer;
  }

  getTypeNode(): BunestNode | undefined {
    return this.typeNode;
  }

  override getType(): BunestType {
    return this.sf.getResolver().getParameterType(this);
  }
}

export class BunestPropertyDeclaration extends BunestNode {
  private readonly decorators: BunestDecorator[];
  private readonly modifiers: BunestNode[];
  private readonly nameNode: BunestNode;
  private readonly questionToken: boolean;
  private readonly exclamationToken: boolean;
  private readonly typeNode?: BunestNode;
  private readonly initializer?: BunestNode;

  constructor(
    raw: RawPropertyDeclaration,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.decorators = raw.decorators.map((d) => {
      const wrapped = new BunestDecorator(d, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    this.modifiers = raw.modifiers.map((m) => new BunestNode(m, sf, this));
    this.nameNode = wrapRawNode(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
    this.questionToken = raw.questionToken;
    this.exclamationToken = raw.exclamationToken;
    if (raw.typeNode) {
      this.typeNode = wrapRawNode(raw.typeNode, sf, this);
      this.childNodes.push(this.typeNode);
    }
    if (raw.initializer) {
      this.initializer = wrapRawNode(raw.initializer, sf, this);
      this.childNodes.push(this.initializer);
    }
  }

  getName(): string {
    return stripQuotes(this.nameNode.getText());
  }

  getNameNode(): BunestNode {
    return this.nameNode;
  }

  getDecorators(): BunestDecorator[] {
    return this.decorators;
  }

  getModifiers(): BunestNode[] {
    return this.modifiers;
  }

  isStatic(): boolean {
    return this.modifiers.some((m) => m.getKind() === SyntaxKind.StaticKeyword);
  }

  isReadonly(): boolean {
    return this.modifiers.some(
      (m) => m.getKind() === SyntaxKind.ReadonlyKeyword,
    );
  }

  hasQuestionToken(): boolean {
    return this.questionToken;
  }

  hasExclamationToken(): boolean {
    return this.exclamationToken;
  }

  hasInitializer(): boolean {
    return this.initializer !== undefined;
  }

  getInitializer(): BunestNode | undefined {
    return this.initializer;
  }

  getTypeNode(): BunestNode | undefined {
    return this.typeNode;
  }

  override getType(): BunestType {
    return this.sf.getResolver().getPropertyType(this);
  }
}

export class BunestMethodDeclaration extends BunestNode {
  private readonly decorators: BunestDecorator[];
  private readonly modifiers: BunestNode[];
  private readonly nameNode: BunestNode;
  private readonly questionToken: boolean;
  private readonly parameters: BunestParameterDeclaration[];
  private readonly returnTypeNode?: BunestNode;
  private readonly body?: BunestNode;

  constructor(
    raw: RawMethodDeclaration,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.decorators = raw.decorators.map((d) => {
      const wrapped = new BunestDecorator(d, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    this.modifiers = raw.modifiers.map((m) => new BunestNode(m, sf, this));
    this.nameNode = wrapRawNode(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
    this.questionToken = raw.questionToken;
    this.parameters = raw.parameters.map((p) => {
      const wrapped = new BunestParameterDeclaration(p, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    if (raw.returnType) {
      this.returnTypeNode = wrapRawNode(raw.returnType, sf, this);
      this.childNodes.push(this.returnTypeNode);
    }
    if (raw.body) {
      this.body = wrapRawNode(raw.body, sf, this);
      this.childNodes.push(this.body);
    }
  }

  getName(): string {
    return stripQuotes(this.nameNode.getText());
  }

  getNameNode(): BunestNode {
    return this.nameNode;
  }

  getDecorators(): BunestDecorator[] {
    return this.decorators;
  }

  getModifiers(): BunestNode[] {
    return this.modifiers;
  }

  isStatic(): boolean {
    return this.modifiers.some((m) => m.getKind() === SyntaxKind.StaticKeyword);
  }

  isAbstract(): boolean {
    return this.modifiers.some(
      (m) => m.getKind() === SyntaxKind.AbstractKeyword,
    );
  }

  isAsync(): boolean {
    return this.modifiers.some((m) => m.getKind() === SyntaxKind.AsyncKeyword);
  }

  hasQuestionToken(): boolean {
    return this.questionToken;
  }

  getParameters(): BunestParameterDeclaration[] {
    return this.parameters;
  }

  getReturnTypeNode(): BunestNode | undefined {
    return this.returnTypeNode;
  }

  getReturnType(): BunestType {
    return this.sf.getResolver().getMethodReturnType(this);
  }

  getBody(): BunestNode | undefined {
    return this.body;
  }
}

export class BunestConstructorDeclaration extends BunestNode {
  private readonly parameters: BunestParameterDeclaration[];
  private readonly body?: BunestNode;

  constructor(
    raw: RawConstructorDeclaration,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.parameters = raw.parameters.map((p) => {
      const wrapped = new BunestParameterDeclaration(p, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    if (raw.body) {
      this.body = wrapRawNode(raw.body, sf, this);
      this.childNodes.push(this.body);
    }
  }

  getParameters(): BunestParameterDeclaration[] {
    return this.parameters;
  }

  getBody(): BunestNode | undefined {
    return this.body;
  }
}

export class BunestClassDeclaration extends BunestNode {
  private readonly decorators: BunestDecorator[];
  private readonly modifiers: BunestNode[];
  private readonly nameNode?: BunestIdentifier;
  private readonly extendsClause?: BunestExpressionWithTypeArguments;
  private readonly properties: BunestPropertyDeclaration[] = [];
  private readonly methods: BunestMethodDeclaration[] = [];
  private readonly constructors: BunestConstructorDeclaration[] = [];

  constructor(
    raw: RawClassDeclaration,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.decorators = raw.decorators.map((d) => {
      const wrapped = new BunestDecorator(d, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    this.modifiers = raw.modifiers.map((m) => new BunestNode(m, sf, this));
    if (raw.name) {
      this.nameNode = new BunestIdentifier(raw.name, sf, this);
      this.childNodes.push(this.nameNode);
    }
    if (raw.extendsClause) {
      this.extendsClause = new BunestExpressionWithTypeArguments(
        raw.extendsClause,
        sf,
        this,
      );
      this.childNodes.push(this.extendsClause);
    }
    for (const mem of raw.members) {
      const wrapped = wrapRawNode(mem, sf, this);
      this.childNodes.push(wrapped);
      if (wrapped instanceof BunestPropertyDeclaration) {
        this.properties.push(wrapped);
      } else if (wrapped instanceof BunestMethodDeclaration) {
        this.methods.push(wrapped);
      } else if (wrapped instanceof BunestConstructorDeclaration) {
        this.constructors.push(wrapped);
      }
    }
  }

  getName(): string | undefined {
    return this.nameNode?.getText();
  }

  getNameNode(): BunestIdentifier | undefined {
    return this.nameNode;
  }

  getDecorators(): BunestDecorator[] {
    return this.decorators;
  }

  getModifiers(): BunestNode[] {
    return this.modifiers;
  }

  hasExportModifier(): boolean {
    return this.modifiers.some((m) => m.getKind() === SyntaxKind.ExportKeyword);
  }

  hasDefaultModifier(): boolean {
    return this.modifiers.some(
      (m) => m.getKind() === SyntaxKind.DefaultKeyword,
    );
  }

  isExported(): boolean {
    if (this.hasExportModifier()) return true;
    const name = this.getName();
    return Boolean(name && this.sf.isLocallyExported(name));
  }

  isAbstract(): boolean {
    return this.modifiers.some(
      (m) => m.getKind() === SyntaxKind.AbstractKeyword,
    );
  }

  getExtends(): BunestExpressionWithTypeArguments | undefined {
    return this.extendsClause;
  }

  getBaseClass(): BunestClassDeclaration | undefined {
    return this.sf.getResolver().resolveBaseClass(this);
  }

  getProperties(): BunestPropertyDeclaration[] {
    return this.properties;
  }

  getMethods(): BunestMethodDeclaration[] {
    return this.methods;
  }

  getMethod(name: string): BunestMethodDeclaration | undefined {
    return this.methods.find((m) => m.getName() === name);
  }

  getConstructors(): BunestConstructorDeclaration[] {
    return this.constructors;
  }
}

export class BunestPropertySignature extends BunestNode {
  private readonly nameNode: BunestNode;
  private readonly questionToken: boolean;
  private readonly typeNode?: BunestNode;

  constructor(
    raw: RawPropertySignature,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.nameNode = wrapRawNode(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
    this.questionToken = raw.questionToken;
    if (raw.typeNode) {
      this.typeNode = wrapRawNode(raw.typeNode, sf, this);
      this.childNodes.push(this.typeNode);
    }
  }

  getName(): string {
    return stripQuotes(this.nameNode.getText());
  }

  hasQuestionToken(): boolean {
    return this.questionToken;
  }

  getTypeNode(): BunestNode | undefined {
    return this.typeNode;
  }
}

export class BunestMethodSignature extends BunestNode {
  private readonly nameNode: BunestNode;
  private readonly questionToken: boolean;
  private readonly parameters: BunestParameterDeclaration[];
  private readonly returnTypeNode?: BunestNode;

  constructor(
    raw: RawMethodSignature,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.nameNode = wrapRawNode(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
    this.questionToken = raw.questionToken;
    this.parameters = raw.parameters.map((p) => {
      const wrapped = new BunestParameterDeclaration(p, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    if (raw.returnType) {
      this.returnTypeNode = wrapRawNode(raw.returnType, sf, this);
      this.childNodes.push(this.returnTypeNode);
    }
  }

  getName(): string {
    return stripQuotes(this.nameNode.getText());
  }

  hasQuestionToken(): boolean {
    return this.questionToken;
  }

  getParameters(): BunestParameterDeclaration[] {
    return this.parameters;
  }

  getReturnTypeNode(): BunestNode | undefined {
    return this.returnTypeNode;
  }
}

export class BunestInterfaceDeclaration extends BunestNode {
  private readonly modifiers: BunestNode[];
  private readonly nameNode: BunestIdentifier;
  private readonly extendsClauses: BunestExpressionWithTypeArguments[];
  private readonly members: BunestNode[];

  constructor(
    raw: RawInterfaceDeclaration,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.modifiers = raw.modifiers.map((m) => new BunestNode(m, sf, this));
    this.nameNode = new BunestIdentifier(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
    this.extendsClauses = raw.extendsClauses.map((e) => {
      const wrapped = new BunestExpressionWithTypeArguments(e, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    this.members = raw.members.map((m) => {
      const wrapped = wrapRawNode(m, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
  }

  getName(): string {
    return this.nameNode.getText();
  }

  hasExportModifier(): boolean {
    return this.modifiers.some((m) => m.getKind() === SyntaxKind.ExportKeyword);
  }

  isExported(): boolean {
    return (
      this.hasExportModifier() || this.sf.isLocallyExported(this.getName())
    );
  }

  getExtends(): BunestExpressionWithTypeArguments[] {
    return this.extendsClauses;
  }

  getMembers(): BunestNode[] {
    return this.members;
  }
}

export class BunestTypeAliasDeclaration extends BunestNode {
  private readonly modifiers: BunestNode[];
  private readonly nameNode: BunestIdentifier;
  private readonly typeNode: BunestNode;

  constructor(
    raw: RawTypeAliasDeclaration,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.modifiers = raw.modifiers.map((m) => new BunestNode(m, sf, this));
    this.nameNode = new BunestIdentifier(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
    this.typeNode = wrapRawNode(raw.typeNode, sf, this);
    this.childNodes.push(this.typeNode);
  }

  getName(): string {
    return this.nameNode.getText();
  }

  hasExportModifier(): boolean {
    return this.modifiers.some((m) => m.getKind() === SyntaxKind.ExportKeyword);
  }

  isExported(): boolean {
    return (
      this.hasExportModifier() || this.sf.isLocallyExported(this.getName())
    );
  }

  getTypeNode(): BunestNode {
    return this.typeNode;
  }
}

export class BunestEnumDeclaration extends BunestNode {
  private readonly modifiers: BunestNode[];
  private readonly nameNode: BunestIdentifier;

  constructor(
    raw: RawEnumDeclaration,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.modifiers = raw.modifiers.map((m) => new BunestNode(m, sf, this));
    this.nameNode = new BunestIdentifier(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
    for (const m of raw.members) {
      if (m.initializer) {
        this.childNodes.push(wrapRawNode(m.initializer, sf, this));
      }
    }
  }

  getName(): string {
    return this.nameNode.getText();
  }

  hasExportModifier(): boolean {
    return this.modifiers.some((m) => m.getKind() === SyntaxKind.ExportKeyword);
  }

  isExported(): boolean {
    return (
      this.hasExportModifier() || this.sf.isLocallyExported(this.getName())
    );
  }
}

export class BunestFunctionDeclaration extends BunestNode {
  private readonly modifiers: BunestNode[];
  private readonly nameNode?: BunestIdentifier;
  private readonly parameters: BunestParameterDeclaration[];
  private readonly returnTypeNode?: BunestNode;
  private readonly body?: BunestNode;

  constructor(
    raw: RawFunctionDeclaration,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.modifiers = raw.modifiers.map((m) => new BunestNode(m, sf, this));
    if (raw.name) {
      this.nameNode = new BunestIdentifier(raw.name, sf, this);
      this.childNodes.push(this.nameNode);
    }
    this.parameters = raw.parameters.map((p) => {
      const wrapped = new BunestParameterDeclaration(p, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    if (raw.returnType) {
      this.returnTypeNode = wrapRawNode(raw.returnType, sf, this);
      this.childNodes.push(this.returnTypeNode);
    }
    if (raw.body) {
      this.body = wrapRawNode(raw.body, sf, this);
      this.childNodes.push(this.body);
    }
  }

  getName(): string | undefined {
    return this.nameNode?.getText();
  }

  hasExportModifier(): boolean {
    return this.modifiers.some((m) => m.getKind() === SyntaxKind.ExportKeyword);
  }

  hasDefaultModifier(): boolean {
    return this.modifiers.some(
      (m) => m.getKind() === SyntaxKind.DefaultKeyword,
    );
  }

  isExported(): boolean {
    if (this.hasExportModifier()) return true;
    const name = this.getName();
    return Boolean(name && this.sf.isLocallyExported(name));
  }

  isAsync(): boolean {
    return this.modifiers.some((m) => m.getKind() === SyntaxKind.AsyncKeyword);
  }

  getParameters(): BunestParameterDeclaration[] {
    return this.parameters;
  }

  getReturnTypeNode(): BunestNode | undefined {
    return this.returnTypeNode;
  }

  getReturnType(): BunestType {
    return this.sf.getResolver().getMethodReturnType(this);
  }

  getBody(): BunestNode | undefined {
    return this.body;
  }
}

export class BunestVariableStatement extends BunestNode {
  private readonly modifiers: BunestNode[];
  private readonly declarations: BunestVariableDeclaration[];

  constructor(
    raw: RawVariableStatement,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.modifiers = raw.modifiers.map((m) => new BunestNode(m, sf, this));
    this.declarations = raw.declarations.map((d) => {
      const wrapped = new BunestVariableDeclaration(d, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
  }

  isExported(): boolean {
    return this.modifiers.some((m) => m.getKind() === SyntaxKind.ExportKeyword);
  }

  getDeclarations(): BunestVariableDeclaration[] {
    return this.declarations;
  }
}

export class BunestVariableDeclaration extends BunestNode {
  private readonly nameNode: BunestNode;
  private readonly typeNode?: BunestNode;
  private readonly initializer?: BunestNode;
  private readonly statement?: BunestVariableStatement;

  constructor(
    raw: RawVariableDeclaration,
    sf: BunestSourceFile,
    parent?: BunestVariableStatement,
  ) {
    super(raw, sf, parent);
    this.statement = parent;
    this.nameNode = wrapRawNode(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
    if (raw.typeNode) {
      this.typeNode = wrapRawNode(raw.typeNode, sf, this);
      this.childNodes.push(this.typeNode);
    }
    if (raw.initializer) {
      this.initializer = wrapRawNode(raw.initializer, sf, this);
      this.childNodes.push(this.initializer);
    }
  }

  getName(): string {
    return this.nameNode.getText();
  }

  getNameNode(): BunestNode {
    return this.nameNode;
  }

  getTypeNode(): BunestNode | undefined {
    return this.typeNode;
  }

  getInitializer(): BunestNode | undefined {
    return this.initializer;
  }

  getVariableStatement(): BunestVariableStatement | undefined {
    return this.statement;
  }
}

// ============================================================================
// Expression Nodes
// ============================================================================

export class BunestObjectLiteralExpression extends BunestNode {
  private readonly properties: BunestNode[];

  constructor(
    raw: RawObjectLiteralExpression,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.properties = raw.properties.map((p) => {
      const wrapped = wrapRawNode(p, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
  }

  getProperties(): BunestNode[] {
    return this.properties;
  }

  getProperty(name: string): BunestNode | undefined {
    return this.properties.find((p) => {
      if (BunestNode.isPropertyAssignment(p)) {
        return stripQuotes(p.getName()) === name;
      }
      if (BunestNode.isShorthandPropertyAssignment(p)) {
        return p.getName() === name;
      }
      if (p instanceof BunestMethodDeclaration) {
        return p.getName() === name;
      }
      return false;
    });
  }
}

export class BunestPropertyAssignment extends BunestNode {
  private readonly nameNode: BunestNode;
  private readonly initializer: BunestNode;

  constructor(
    raw: RawPropertyAssignment,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.nameNode = wrapRawNode(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
    this.initializer = wrapRawNode(raw.initializer, sf, this);
    this.childNodes.push(this.initializer);
  }

  getName(): string {
    return this.nameNode.getText();
  }

  getNameNode(): BunestNode {
    return this.nameNode;
  }

  getInitializer(): BunestNode | undefined {
    return this.initializer;
  }
}

export class BunestShorthandPropertyAssignment extends BunestNode {
  private readonly nameNode: BunestIdentifier;

  constructor(
    raw: RawShorthandPropertyAssignment,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.nameNode = new BunestIdentifier(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
  }

  getName(): string {
    return this.nameNode.getText();
  }

  getNameNode(): BunestIdentifier {
    return this.nameNode;
  }
}

export class BunestArrayLiteralExpression extends BunestNode {
  private readonly elements: BunestNode[];

  constructor(
    raw: RawArrayLiteralExpression,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.elements = raw.elements.map((e) => {
      const wrapped = wrapRawNode(e, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
  }

  getElements(): BunestNode[] {
    return this.elements;
  }
}

export class BunestCallExpression extends BunestNode {
  private readonly expression: BunestNode;
  private readonly typeArguments: BunestNode[];
  private readonly args: BunestNode[];

  constructor(
    raw: RawCallExpression,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.expression = wrapRawNode(raw.expression, sf, this);
    this.childNodes.push(this.expression);
    this.typeArguments = raw.typeArguments.map((t) => {
      const wrapped = wrapRawNode(t, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    this.args = raw.arguments.map((a) => {
      const wrapped = wrapRawNode(a, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
  }

  getExpression(): BunestNode {
    return this.expression;
  }

  getTypeArguments(): BunestNode[] {
    return this.typeArguments;
  }

  getArguments(): BunestNode[] {
    return this.args;
  }
}

export class BunestNewExpression extends BunestNode {
  private readonly expression: BunestNode;
  private readonly typeArguments: BunestNode[];
  private readonly args: BunestNode[];

  constructor(
    raw: RawNewExpression,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.expression = wrapRawNode(raw.expression, sf, this);
    this.childNodes.push(this.expression);
    this.typeArguments = raw.typeArguments.map((t) => {
      const wrapped = wrapRawNode(t, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    this.args = raw.arguments.map((a) => {
      const wrapped = wrapRawNode(a, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
  }

  getExpression(): BunestNode {
    return this.expression;
  }

  getTypeArguments(): BunestNode[] {
    return this.typeArguments;
  }

  getArguments(): BunestNode[] {
    return this.args;
  }
}

export class BunestPropertyAccessExpression extends BunestNode {
  private readonly expression: BunestNode;
  private readonly nameNode: BunestIdentifier;

  constructor(
    raw: RawPropertyAccessExpression,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.expression = wrapRawNode(raw.expression, sf, this);
    this.childNodes.push(this.expression);
    this.nameNode = new BunestIdentifier(raw.name, sf, this);
    this.childNodes.push(this.nameNode);
  }

  getExpression(): BunestNode {
    return this.expression;
  }

  getName(): string {
    return this.nameNode.getText();
  }

  getNameNode(): BunestIdentifier {
    return this.nameNode;
  }
}

export class BunestArrowFunction extends BunestNode {
  private readonly asyncFlag: boolean;
  private readonly parameters: BunestParameterDeclaration[];
  private readonly returnTypeNode?: BunestNode;
  private readonly body: BunestNode;

  constructor(
    raw: RawArrowFunction,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.asyncFlag = raw.isAsync;
    this.parameters = raw.parameters.map((p) => {
      const wrapped = new BunestParameterDeclaration(p, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    if (raw.returnType) {
      this.returnTypeNode = wrapRawNode(raw.returnType, sf, this);
      this.childNodes.push(this.returnTypeNode);
    }
    this.body = wrapRawNode(raw.body, sf, this);
    this.childNodes.push(this.body);
  }

  isAsync(): boolean {
    return this.asyncFlag;
  }

  getParameters(): BunestParameterDeclaration[] {
    return this.parameters;
  }

  getReturnTypeNode(): BunestNode | undefined {
    return this.returnTypeNode;
  }

  getBody(): BunestNode {
    return this.body;
  }
}

export class BunestFunctionExpression extends BunestNode {
  private readonly asyncFlag: boolean;
  private readonly parameters: BunestParameterDeclaration[];
  private readonly returnTypeNode?: BunestNode;
  private readonly body: BunestNode;

  constructor(
    raw: RawFunctionExpression,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.asyncFlag = raw.isAsync;
    this.parameters = raw.parameters.map((p) => {
      const wrapped = new BunestParameterDeclaration(p, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    if (raw.returnType) {
      this.returnTypeNode = wrapRawNode(raw.returnType, sf, this);
      this.childNodes.push(this.returnTypeNode);
    }
    this.body = wrapRawNode(raw.body, sf, this);
    this.childNodes.push(this.body);
  }

  isAsync(): boolean {
    return this.asyncFlag;
  }

  getParameters(): BunestParameterDeclaration[] {
    return this.parameters;
  }

  getReturnTypeNode(): BunestNode | undefined {
    return this.returnTypeNode;
  }

  getBody(): BunestNode {
    return this.body;
  }
}

export class BunestParenthesizedExpression extends BunestNode {
  private readonly expression: BunestNode;

  constructor(
    raw: RawParenthesizedExpression,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.expression = wrapRawNode(raw.expression, sf, this);
    this.childNodes.push(this.expression);
  }

  getExpression(): BunestNode {
    return this.expression;
  }
}

export class BunestAsExpression extends BunestNode {
  private readonly expression: BunestNode;
  private readonly typeNode: BunestNode;

  constructor(raw: RawAsExpression, sf: BunestSourceFile, parent?: BunestNode) {
    super(raw, sf, parent);
    this.expression = wrapRawNode(raw.expression, sf, this);
    this.childNodes.push(this.expression);
    this.typeNode = wrapRawNode(raw.typeNode, sf, this);
    this.childNodes.push(this.typeNode);
  }

  getExpression(): BunestNode {
    return this.expression;
  }

  getTypeNode(): BunestNode {
    return this.typeNode;
  }
}

export class BunestReturnStatement extends BunestNode {
  private readonly expression?: BunestNode;

  constructor(
    raw: RawReturnStatement,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    if (raw.expression) {
      this.expression = wrapRawNode(raw.expression, sf, this);
      this.childNodes.push(this.expression);
    }
  }

  getExpression(): BunestNode | undefined {
    return this.expression;
  }
}

// ============================================================================
// Type Nodes
// ============================================================================

export class BunestUnionTypeNode extends BunestNode {
  private readonly typeNodes: BunestNode[];

  constructor(
    raw: RawUnionOrIntersectionType,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.typeNodes = raw.types.map((t) => {
      const wrapped = wrapRawNode(t, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
  }

  getTypeNodes(): BunestNode[] {
    return this.typeNodes;
  }
}

export class BunestArrayTypeNode extends BunestNode {
  private readonly elementType: BunestNode;

  constructor(raw: RawArrayType, sf: BunestSourceFile, parent?: BunestNode) {
    super(raw, sf, parent);
    this.elementType = wrapRawNode(raw.elementType, sf, this);
    this.childNodes.push(this.elementType);
  }

  getElementTypeNode(): BunestNode {
    return this.elementType;
  }
}

export class BunestTypeReferenceNode extends BunestNode {
  private readonly typeName: BunestNode;
  private readonly typeArguments: BunestNode[];

  constructor(
    raw: RawTypeReference,
    sf: BunestSourceFile,
    parent?: BunestNode,
  ) {
    super(raw, sf, parent);
    this.typeName = wrapRawNode(raw.typeName, sf, this);
    this.childNodes.push(this.typeName);
    this.typeArguments = raw.typeArguments.map((t) => {
      const wrapped = wrapRawNode(t, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
  }

  getTypeName(): BunestNode {
    return this.typeName;
  }

  getTypeArguments(): BunestNode[] {
    return this.typeArguments;
  }
}

export class BunestTypeLiteralNode extends BunestNode {
  private readonly members: BunestNode[];

  constructor(raw: RawTypeLiteral, sf: BunestSourceFile, parent?: BunestNode) {
    super(raw, sf, parent);
    this.members = raw.members.map((m) => {
      const wrapped = wrapRawNode(m, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
  }

  getMembers(): BunestNode[] {
    return this.members;
  }
}

export class BunestFunctionTypeNode extends BunestNode {
  private readonly parameters: BunestParameterDeclaration[];
  private readonly returnType: BunestNode;

  constructor(raw: RawFunctionType, sf: BunestSourceFile, parent?: BunestNode) {
    super(raw, sf, parent);
    this.parameters = raw.parameters.map((p) => {
      const wrapped = new BunestParameterDeclaration(p, sf, this);
      this.childNodes.push(wrapped);
      return wrapped;
    });
    this.returnType = wrapRawNode(raw.returnType, sf, this);
    this.childNodes.push(this.returnType);
  }

  getParameters(): BunestParameterDeclaration[] {
    return this.parameters;
  }

  getReturnTypeNode(): BunestNode {
    return this.returnType;
  }
}

export class BunestTypeOperatorNode extends BunestNode {
  private readonly operator: SyntaxKind;

  constructor(raw: RawTypeOperator, sf: BunestSourceFile, parent?: BunestNode) {
    super(raw, sf, parent);
    this.operator = raw.operator;
    this.childNodes.push(wrapRawNode(raw.typeNode, sf, this));
  }

  getOperator(): SyntaxKind {
    return this.operator;
  }
}

// ============================================================================
// Raw -> Wrapped Node Factory
// ============================================================================

function wrapRawNode(
  raw: RawNode,
  sf: BunestSourceFile,
  parent?: BunestNode,
): BunestNode {
  switch (raw.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
      return new BunestIdentifier(raw as RawIdentifier, sf, parent);
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return new BunestStringLiteral(raw as RawStringLiteral, sf, parent);
    case SyntaxKind.NumericLiteral:
      return new BunestNumericLiteral(raw as RawNumericLiteral, sf, parent);
    case SyntaxKind.Decorator:
      return new BunestDecorator(raw as RawDecorator, sf, parent);
    case SyntaxKind.ImportDeclaration:
      return new BunestImportDeclaration(
        raw as RawImportDeclaration,
        sf,
        parent,
      );
    case SyntaxKind.ImportSpecifier:
      return new BunestImportSpecifier(raw as RawImportSpecifier, sf, parent);
    case SyntaxKind.ExportDeclaration:
      return new BunestExportDeclaration(
        raw as RawExportDeclaration,
        sf,
        parent,
      );
    case SyntaxKind.ExportSpecifier:
      return new BunestExportSpecifier(raw as RawExportSpecifier, sf, parent);
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
      return new BunestClassDeclaration(raw as RawClassDeclaration, sf, parent);
    case SyntaxKind.ExpressionWithTypeArguments:
      return new BunestExpressionWithTypeArguments(
        raw as RawExpressionWithTypeArguments,
        sf,
        parent,
      );
    case SyntaxKind.PropertyDeclaration:
      return new BunestPropertyDeclaration(
        raw as RawPropertyDeclaration,
        sf,
        parent,
      );
    case SyntaxKind.MethodDeclaration:
      return new BunestMethodDeclaration(
        raw as RawMethodDeclaration,
        sf,
        parent,
      );
    case SyntaxKind.Constructor:
      return new BunestConstructorDeclaration(
        raw as RawConstructorDeclaration,
        sf,
        parent,
      );
    case SyntaxKind.Parameter:
      return new BunestParameterDeclaration(raw as RawParameter, sf, parent);
    case SyntaxKind.PropertySignature:
      return new BunestPropertySignature(
        raw as RawPropertySignature,
        sf,
        parent,
      );
    case SyntaxKind.MethodSignature:
      return new BunestMethodSignature(raw as RawMethodSignature, sf, parent);
    case SyntaxKind.InterfaceDeclaration:
      return new BunestInterfaceDeclaration(
        raw as RawInterfaceDeclaration,
        sf,
        parent,
      );
    case SyntaxKind.TypeAliasDeclaration:
      return new BunestTypeAliasDeclaration(
        raw as RawTypeAliasDeclaration,
        sf,
        parent,
      );
    case SyntaxKind.EnumDeclaration:
      return new BunestEnumDeclaration(raw as RawEnumDeclaration, sf, parent);
    case SyntaxKind.FunctionDeclaration:
      return new BunestFunctionDeclaration(
        raw as RawFunctionDeclaration,
        sf,
        parent,
      );
    case SyntaxKind.VariableStatement:
      return new BunestVariableStatement(
        raw as RawVariableStatement,
        sf,
        parent,
      );
    case SyntaxKind.VariableDeclaration:
      return new BunestVariableDeclaration(
        raw as RawVariableDeclaration,
        sf,
        parent instanceof BunestVariableStatement ? parent : undefined,
      );
    case SyntaxKind.ObjectLiteralExpression:
      return new BunestObjectLiteralExpression(
        raw as RawObjectLiteralExpression,
        sf,
        parent,
      );
    case SyntaxKind.PropertyAssignment:
      return new BunestPropertyAssignment(
        raw as RawPropertyAssignment,
        sf,
        parent,
      );
    case SyntaxKind.ShorthandPropertyAssignment:
      return new BunestShorthandPropertyAssignment(
        raw as RawShorthandPropertyAssignment,
        sf,
        parent,
      );
    case SyntaxKind.ArrayLiteralExpression:
      return new BunestArrayLiteralExpression(
        raw as RawArrayLiteralExpression,
        sf,
        parent,
      );
    case SyntaxKind.CallExpression:
      return new BunestCallExpression(raw as RawCallExpression, sf, parent);
    case SyntaxKind.NewExpression:
      return new BunestNewExpression(raw as RawNewExpression, sf, parent);
    case SyntaxKind.PropertyAccessExpression:
      return new BunestPropertyAccessExpression(
        raw as RawPropertyAccessExpression,
        sf,
        parent,
      );
    case SyntaxKind.ArrowFunction:
      return new BunestArrowFunction(raw as RawArrowFunction, sf, parent);
    case SyntaxKind.FunctionExpression:
      return new BunestFunctionExpression(
        raw as RawFunctionExpression,
        sf,
        parent,
      );
    case SyntaxKind.ParenthesizedExpression:
      return new BunestParenthesizedExpression(
        raw as RawParenthesizedExpression,
        sf,
        parent,
      );
    case SyntaxKind.AsExpression:
    case SyntaxKind.SatisfiesExpression:
      return new BunestAsExpression(raw as RawAsExpression, sf, parent);
    case SyntaxKind.ReturnStatement:
      return new BunestReturnStatement(raw as RawReturnStatement, sf, parent);
    case SyntaxKind.UnionType:
    case SyntaxKind.IntersectionType:
      return new BunestUnionTypeNode(
        raw as RawUnionOrIntersectionType,
        sf,
        parent,
      );
    case SyntaxKind.ArrayType:
      return new BunestArrayTypeNode(raw as RawArrayType, sf, parent);
    case SyntaxKind.TypeReference:
      return new BunestTypeReferenceNode(raw as RawTypeReference, sf, parent);
    case SyntaxKind.TypeLiteral:
      return new BunestTypeLiteralNode(raw as RawTypeLiteral, sf, parent);
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructorType:
      return new BunestFunctionTypeNode(raw as RawFunctionType, sf, parent);
    case SyntaxKind.TypeOperator:
      return new BunestTypeOperatorNode(raw as RawTypeOperator, sf, parent);
    case SyntaxKind.Block: {
      const node = new BunestNode(raw, sf, parent);
      for (const s of (raw as RawBlock).statements) {
        node.getChildren().push(wrapRawNode(s, sf, node));
      }
      return node;
    }
    case SyntaxKind.LiteralType: {
      const node = new BunestNode(raw, sf, parent);
      node
        .getChildren()
        .push(wrapRawNode((raw as RawLiteralType).literal, sf, node));
      return node;
    }
    case SyntaxKind.ParenthesizedType: {
      const node = new BunestNode(raw, sf, parent);
      node
        .getChildren()
        .push(wrapRawNode((raw as RawParenthesizedType).typeNode, sf, node));
      return node;
    }
    case SyntaxKind.TupleType: {
      const node = new BunestNode(raw, sf, parent);
      for (const el of (raw as RawTupleType).elements) {
        node.getChildren().push(wrapRawNode(el, sf, node));
      }
      return node;
    }
    case SyntaxKind.ExportAssignment: {
      const node = new BunestNode(raw, sf, parent);
      const expr = (raw as { expression?: RawNode }).expression;
      if (expr) node.getChildren().push(wrapRawNode(expr, sf, node));
      return node;
    }
    case SyntaxKind.ElementAccessExpression: {
      const node = new BunestNode(raw, sf, parent);
      const ea = raw as { expression?: RawNode; argumentExpression?: RawNode };
      if (ea.expression) node.getChildren().push(wrapRawNode(ea.expression, sf, node));
      if (ea.argumentExpression && ea.argumentExpression !== ea.expression) {
        node.getChildren().push(wrapRawNode(ea.argumentExpression, sf, node));
      }
      return node;
    }
    default: {
      const node = new BunestNode(raw, sf, parent);
      if (raw.children) {
        for (const c of raw.children) {
          node.getChildren().push(wrapRawNode(c, sf, node));
        }
      }
      return node;
    }
  }
}

// ============================================================================
// BunestSourceFile
// ============================================================================

export class BunestSourceFile extends BunestNode {
  private readonly filePath: string;
  private readonly project: BunestProject;
  private fullText = "";
  private lineStarts: number[] = [0];
  private classes: BunestClassDeclaration[] = [];
  private imports: BunestImportDeclaration[] = [];
  private exports: BunestExportDeclaration[] = [];
  private interfaces: BunestInterfaceDeclaration[] = [];
  private typeAliases: BunestTypeAliasDeclaration[] = [];
  private enums: BunestEnumDeclaration[] = [];
  private functions: BunestFunctionDeclaration[] = [];
  private variableDecls: BunestVariableDeclaration[] = [];
  private localExportedNames = new Set<string>();

  constructor(filePath: string, text: string, project: BunestProject) {
    super(
      { kind: SyntaxKind.SourceFile, start: 0, end: text.length },
      null as unknown as BunestSourceFile,
      undefined,
    );
    this.sf = this;
    this.filePath = filePath;
    this.project = project;
    this.parseFromText(text);
  }

  private parseFromText(text: string): void {
    this.fullText = text;
    this.end = text.length;
    const raw: RawSourceFile = parseTypeScript(text, this.filePath);
    this.lineStarts = raw.lineStarts;

    this.childNodes.length = 0;
    this.classes = [];
    this.imports = [];
    this.exports = [];
    this.interfaces = [];
    this.typeAliases = [];
    this.enums = [];
    this.functions = [];
    this.variableDecls = [];
    this.localExportedNames.clear();

    for (const stmt of raw.statements) {
      const wrapped = wrapRawNode(stmt, this, this);
      this.childNodes.push(wrapped);
      if (wrapped instanceof BunestClassDeclaration) {
        this.classes.push(wrapped);
      } else if (wrapped instanceof BunestImportDeclaration) {
        this.imports.push(wrapped);
      } else if (wrapped instanceof BunestExportDeclaration) {
        this.exports.push(wrapped);
        if (!wrapped.getModuleSpecifierValue()) {
          for (const spec of wrapped.getNamedExports()) {
            this.localExportedNames.add(spec.getName());
          }
        }
      } else if (wrapped instanceof BunestInterfaceDeclaration) {
        this.interfaces.push(wrapped);
      } else if (wrapped instanceof BunestTypeAliasDeclaration) {
        this.typeAliases.push(wrapped);
      } else if (wrapped instanceof BunestEnumDeclaration) {
        this.enums.push(wrapped);
      } else if (wrapped instanceof BunestFunctionDeclaration) {
        this.functions.push(wrapped);
      } else if (wrapped instanceof BunestVariableStatement) {
        this.variableDecls.push(...wrapped.getDeclarations());
      }
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  getFullText(): string {
    return this.fullText;
  }

  override getText(): string {
    return this.fullText;
  }

  getResolver(): TypeResolver {
    return this.project.getResolver();
  }

  getLineAndColumnAtPos(pos: number): { line: number; column: number } {
    return getLineAndColumnAtPos(this.lineStarts, pos);
  }

  replaceWithText(newText: string): this {
    this.parseFromText(newText);
    this.project.invalidateCaches();
    return this;
  }

  refreshFromFileSystemSync(): void {
    if (!existsSyncPath(this.filePath)) return;
    const text = readTextSync(this.filePath);
    this.replaceWithText(text);
  }

  isLocallyExported(name: string): boolean {
    return this.localExportedNames.has(name);
  }

  getClasses(): BunestClassDeclaration[] {
    return this.classes;
  }

  getClass(name: string): BunestClassDeclaration | undefined {
    return this.classes.find((c) => c.getName() === name);
  }

  getImportDeclarations(): BunestImportDeclaration[] {
    return this.imports;
  }

  getExportDeclarations(): BunestExportDeclaration[] {
    return this.exports;
  }

  getInterfaces(): BunestInterfaceDeclaration[] {
    return this.interfaces;
  }

  getTypeAliases(): BunestTypeAliasDeclaration[] {
    return this.typeAliases;
  }

  getEnums(): BunestEnumDeclaration[] {
    return this.enums;
  }

  getFunctions(): BunestFunctionDeclaration[] {
    return this.functions;
  }

  getVariableDeclarations(): BunestVariableDeclaration[] {
    return this.variableDecls;
  }

  getExportedDeclarations(): Map<string, BunestNode[]> {
    return this.project.getResolver().getExportedDeclarations(this);
  }

  override getDescendantsOfKind(
    kind: SyntaxKind.CallExpression,
  ): BunestCallExpression[];
  override getDescendantsOfKind(
    kind: SyntaxKind.ObjectLiteralExpression,
  ): BunestObjectLiteralExpression[];
  override getDescendantsOfKind(
    kind: SyntaxKind.Decorator,
  ): BunestDecorator[];
  override getDescendantsOfKind(kind: SyntaxKind): BunestNode[];
  override getDescendantsOfKind(kind: SyntaxKind): BunestNode[] {
    return super.getDescendantsOfKind(kind);
  }
}

// ============================================================================
// BunestProject
// ============================================================================

export interface BunestProjectOptions {
  readonly tsConfigFilePath?: string;
  readonly compilerOptions?: Record<string, unknown>;
  readonly skipAddingFilesFromTsConfig?: boolean;
  readonly skipFileDependencyResolution?: boolean;
  readonly useInMemoryFileSystem?: boolean;
}

interface TsConfigPaths {
  readonly baseUrlDir?: string;
  readonly paths: ReadonlyArray<{ readonly pattern: string; readonly targets: readonly string[] }>;
}

function stripJsonComments(raw: string): string {
  let out = "";
  let inStr = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\" && i + 1 < raw.length) {
        out += next!;
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Remove trailing commas before } or ]
  return out.replace(/,\s*([}\]])/g, "$1");
}

function loadTsConfigPaths(tsConfigFilePath?: string): TsConfigPaths {
  if (!tsConfigFilePath || !existsSyncPath(tsConfigFilePath)) {
    return { paths: [] };
  }
  try {
    const raw = readTextSync(tsConfigFilePath);
    const parsed = (
      typeof Bun !== "undefined" && typeof Bun.JSONC?.parse === "function"
        ? Bun.JSONC.parse(raw)
        : JSON.parse(stripJsonComments(raw))
    ) as {
      compilerOptions?: {
        baseUrl?: string;
        paths?: Record<string, string[]>;
      };
    };
    const configDir = dirname(resolve(tsConfigFilePath));
    const baseUrlDir = parsed.compilerOptions?.baseUrl
      ? resolve(configDir, parsed.compilerOptions.baseUrl)
      : configDir;
    const pathsEntries: Array<{ pattern: string; targets: string[] }> = [];
    if (parsed.compilerOptions?.paths) {
      for (const [pattern, targets] of Object.entries(
        parsed.compilerOptions.paths,
      )) {
        if (Array.isArray(targets)) {
          pathsEntries.push({ pattern, targets });
        }
      }
    }
    return { baseUrlDir, paths: pathsEntries };
  } catch {
    return { paths: [] };
  }
}

export class BunestProject implements ResolverProjectHost {
  private readonly sourceFiles = new Map<string, BunestSourceFile>();
  private readonly resolver: TypeResolver;
  private readonly tsConfigPaths: TsConfigPaths;

  constructor(options: BunestProjectOptions = {}) {
    this.tsConfigPaths = loadTsConfigPaths(options.tsConfigFilePath);
    this.resolver = new TypeResolver(this);
  }

  getResolver(): TypeResolver {
    return this.resolver;
  }

  invalidateCaches(): void {
    this.resolver.invalidate();
  }

  getSourceFiles(): BunestSourceFile[] {
    return [...this.sourceFiles.values()];
  }

  getSourceFile(filePath: string): BunestSourceFile | undefined {
    const normalized = resolve(filePath);
    return this.sourceFiles.get(normalized) ?? this.sourceFiles.get(filePath);
  }

  addSourceFileAtPath(filePath: string): BunestSourceFile {
    const abs = resolve(filePath);
    const existing = this.sourceFiles.get(abs);
    if (existing) return existing;
    const content = readTextSync(abs);
    const sf = new BunestSourceFile(abs, content, this);
    this.sourceFiles.set(abs, sf);
    this.resolver.invalidate();
    return sf;
  }

  addSourceFileAtPathIfExists(filePath: string): BunestSourceFile | undefined {
    const abs = resolve(filePath);
    const existing = this.sourceFiles.get(abs);
    if (existing) return existing;
    if (!existsSyncPath(abs)) return undefined;
    try {
      const content = readTextSync(abs);
      const sf = new BunestSourceFile(abs, content, this);
      this.sourceFiles.set(abs, sf);
      this.resolver.invalidate();
      return sf;
    } catch {
      return undefined;
    }
  }

  createSourceFile(
    filePath: string,
    content: string,
    options?: { readonly overwrite?: boolean },
  ): BunestSourceFile {
    const abs = resolve(filePath);
    const existing = this.sourceFiles.get(abs);
    if (existing) {
      if (options?.overwrite) {
        existing.replaceWithText(content);
        return existing;
      }
      throw new Error(`Source file already exists: ${abs}`);
    }
    const sf = new BunestSourceFile(abs, content, this);
    this.sourceFiles.set(abs, sf);
    this.resolver.invalidate();
    return sf;
  }

  removeSourceFile(sf: BunestSourceFile): void {
    this.sourceFiles.delete(resolve(sf.getFilePath()));
    this.sourceFiles.delete(sf.getFilePath());
    this.resolver.invalidate();
  }

  private tryResolveCandidate(base: string): string | undefined {
    const ext = extname(base);
    const candidates: string[] = [];

    if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
      const stem = base.slice(0, -ext.length);
      candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
    }

    if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
      candidates.push(base);
    } else {
      candidates.push(
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.mts`,
        `${base}.cts`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
      );
    }

    for (const c of candidates) {
      const abs = resolve(c);
      if (this.sourceFiles.has(abs) || existsSyncPath(abs)) {
        return abs;
      }
    }
    return undefined;
  }

  resolveModulePath(
    fromFilePath: string,
    specifier: string,
  ): string | undefined {
    if (!specifier) return undefined;

    // 1. Relative imports
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const base = specifier.startsWith("/")
        ? specifier
        : resolve(dirname(fromFilePath), specifier);
      return this.tryResolveCandidate(base);
    }

    // 2. tsconfig.json `paths` aliases
    const { baseUrlDir, paths } = this.tsConfigPaths;
    if (baseUrlDir && paths.length > 0) {
      for (const entry of paths) {
        const starIdx = entry.pattern.indexOf("*");
        if (starIdx === -1) {
          if (specifier === entry.pattern) {
            for (const target of entry.targets) {
              const found = this.tryResolveCandidate(resolve(baseUrlDir, target));
              if (found) return found;
            }
          }
        } else {
          const prefix = entry.pattern.slice(0, starIdx);
          const suffix = entry.pattern.slice(starIdx + 1);
          if (
            specifier.startsWith(prefix) &&
            specifier.endsWith(suffix) &&
            specifier.length >= prefix.length + suffix.length
          ) {
            const matched = specifier.slice(
              prefix.length,
              specifier.length - suffix.length,
            );
            for (const target of entry.targets) {
              const replaced = target.replace("*", matched);
              const found = this.tryResolveCandidate(
                resolve(baseUrlDir, replaced),
              );
              if (found) return found;
            }
          }
        }
      }
    }

    return undefined;
  }
}
