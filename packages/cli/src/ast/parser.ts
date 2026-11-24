import { lexTypeScript, type Token } from "./lexer";
import { SyntaxKind } from "./syntax-kind";

export interface RawNode {
  readonly kind: SyntaxKind;
  readonly start: number;
  readonly end: number;
  readonly text?: string;
  readonly value?: string | number;
  readonly children?: RawNode[];
}

export interface RawIdentifier extends RawNode {
  readonly kind: SyntaxKind.Identifier | SyntaxKind.PrivateIdentifier;
  readonly text: string;
}

export interface RawStringLiteral extends RawNode {
  readonly kind:
    | SyntaxKind.StringLiteral
    | SyntaxKind.NoSubstitutionTemplateLiteral;
  readonly text: string;
  readonly value: string;
}

export interface RawNumericLiteral extends RawNode {
  readonly kind: SyntaxKind.NumericLiteral;
  readonly text: string;
  readonly value: number;
}

export interface RawDecorator extends RawNode {
  readonly kind: SyntaxKind.Decorator;
  readonly expression: RawNode;
}

export interface RawImportSpecifier extends RawNode {
  readonly kind: SyntaxKind.ImportSpecifier;
  readonly isTypeOnly: boolean;
  readonly name: RawIdentifier;
  readonly alias?: RawIdentifier;
}

export interface RawImportDeclaration extends RawNode {
  readonly kind: SyntaxKind.ImportDeclaration;
  readonly isTypeOnly: boolean;
  readonly defaultImport?: RawIdentifier;
  readonly namespaceImport?: RawIdentifier;
  readonly namedImports: RawImportSpecifier[];
  readonly moduleSpecifier: RawStringLiteral;
}

export interface RawExportSpecifier extends RawNode {
  readonly kind: SyntaxKind.ExportSpecifier;
  readonly isTypeOnly: boolean;
  readonly name: RawIdentifier;
  readonly alias?: RawIdentifier;
}

export interface RawExportDeclaration extends RawNode {
  readonly kind: SyntaxKind.ExportDeclaration;
  readonly isTypeOnly: boolean;
  readonly isNamespaceExport: boolean;
  readonly namespaceAlias?: RawIdentifier;
  readonly namedExports: RawExportSpecifier[];
  readonly moduleSpecifier?: RawStringLiteral;
}

export interface RawExportAssignment extends RawNode {
  readonly kind: SyntaxKind.ExportAssignment;
  readonly expression: RawNode;
}

export interface RawModifier extends RawNode {
  readonly text: string;
}

export interface RawParameter extends RawNode {
  readonly kind: SyntaxKind.Parameter;
  readonly decorators: RawDecorator[];
  readonly modifiers: RawModifier[];
  readonly isRest: boolean;
  readonly name: RawNode;
  readonly questionToken: boolean;
  readonly typeNode?: RawNode;
  readonly initializer?: RawNode;
}

export interface RawPropertyDeclaration extends RawNode {
  readonly kind: SyntaxKind.PropertyDeclaration;
  readonly decorators: RawDecorator[];
  readonly modifiers: RawModifier[];
  readonly name: RawNode;
  readonly questionToken: boolean;
  readonly exclamationToken: boolean;
  readonly typeNode?: RawNode;
  readonly initializer?: RawNode;
}

export interface RawMethodDeclaration extends RawNode {
  readonly kind: SyntaxKind.MethodDeclaration;
  readonly decorators: RawDecorator[];
  readonly modifiers: RawModifier[];
  readonly name: RawNode;
  readonly questionToken: boolean;
  readonly parameters: RawParameter[];
  readonly returnType?: RawNode;
  readonly body?: RawNode;
}

export interface RawConstructorDeclaration extends RawNode {
  readonly kind: SyntaxKind.Constructor;
  readonly decorators: RawDecorator[];
  readonly modifiers: RawModifier[];
  readonly parameters: RawParameter[];
  readonly body?: RawNode;
}

export interface RawExpressionWithTypeArguments extends RawNode {
  readonly kind: SyntaxKind.ExpressionWithTypeArguments;
  readonly expression: RawNode;
  readonly typeArguments: RawNode[];
}

export interface RawClassDeclaration extends RawNode {
  readonly kind: SyntaxKind.ClassDeclaration | SyntaxKind.ClassExpression;
  readonly decorators: RawDecorator[];
  readonly modifiers: RawModifier[];
  readonly name?: RawIdentifier;
  readonly extendsClause?: RawExpressionWithTypeArguments;
  readonly implementsClauses: RawExpressionWithTypeArguments[];
  readonly properties: RawPropertyDeclaration[];
  readonly methods: RawMethodDeclaration[];
  readonly constructors: RawConstructorDeclaration[];
  readonly members: RawNode[];
}

export interface RawPropertySignature extends RawNode {
  readonly kind: SyntaxKind.PropertySignature;
  readonly modifiers: RawModifier[];
  readonly name: RawNode;
  readonly questionToken: boolean;
  readonly typeNode?: RawNode;
}

export interface RawMethodSignature extends RawNode {
  readonly kind: SyntaxKind.MethodSignature;
  readonly name: RawNode;
  readonly questionToken: boolean;
  readonly parameters: RawParameter[];
  readonly returnType?: RawNode;
}

export interface RawInterfaceDeclaration extends RawNode {
  readonly kind: SyntaxKind.InterfaceDeclaration;
  readonly modifiers: RawModifier[];
  readonly name: RawIdentifier;
  readonly extendsClauses: RawExpressionWithTypeArguments[];
  readonly members: RawNode[];
}

export interface RawTypeAliasDeclaration extends RawNode {
  readonly kind: SyntaxKind.TypeAliasDeclaration;
  readonly modifiers: RawModifier[];
  readonly name: RawIdentifier;
  readonly typeNode: RawNode;
}

export interface RawEnumMember extends RawNode {
  readonly kind: SyntaxKind.EnumMember;
  readonly name: RawNode;
  readonly initializer?: RawNode;
}

export interface RawEnumDeclaration extends RawNode {
  readonly kind: SyntaxKind.EnumDeclaration;
  readonly modifiers: RawModifier[];
  readonly name: RawIdentifier;
  readonly members: RawEnumMember[];
}

export interface RawFunctionDeclaration extends RawNode {
  readonly kind: SyntaxKind.FunctionDeclaration;
  readonly modifiers: RawModifier[];
  readonly name?: RawIdentifier;
  readonly parameters: RawParameter[];
  readonly returnType?: RawNode;
  readonly body?: RawNode;
}

export interface RawVariableDeclaration extends RawNode {
  readonly kind: SyntaxKind.VariableDeclaration;
  readonly name: RawNode;
  readonly typeNode?: RawNode;
  readonly initializer?: RawNode;
}

export interface RawVariableStatement extends RawNode {
  readonly kind: SyntaxKind.VariableStatement;
  readonly modifiers: RawModifier[];
  readonly keyword: SyntaxKind;
  readonly declarations: RawVariableDeclaration[];
}

export interface RawObjectLiteralExpression extends RawNode {
  readonly kind: SyntaxKind.ObjectLiteralExpression;
  readonly properties: RawNode[];
}

export interface RawPropertyAssignment extends RawNode {
  readonly kind: SyntaxKind.PropertyAssignment;
  readonly name: RawNode;
  readonly initializer: RawNode;
}

export interface RawShorthandPropertyAssignment extends RawNode {
  readonly kind: SyntaxKind.ShorthandPropertyAssignment;
  readonly name: RawIdentifier;
}

export interface RawArrayLiteralExpression extends RawNode {
  readonly kind: SyntaxKind.ArrayLiteralExpression;
  readonly elements: RawNode[];
}

export interface RawCallExpression extends RawNode {
  readonly kind: SyntaxKind.CallExpression;
  readonly expression: RawNode;
  readonly typeArguments: RawNode[];
  readonly arguments: RawNode[];
}

export interface RawNewExpression extends RawNode {
  readonly kind: SyntaxKind.NewExpression;
  readonly expression: RawNode;
  readonly typeArguments: RawNode[];
  readonly arguments: RawNode[];
}

export interface RawPropertyAccessExpression extends RawNode {
  readonly kind: SyntaxKind.PropertyAccessExpression;
  readonly expression: RawNode;
  readonly name: RawIdentifier;
}

export interface RawElementAccessExpression extends RawNode {
  readonly kind: SyntaxKind.ElementAccessExpression;
  readonly expression: RawNode;
  readonly argumentExpression: RawNode;
}

export interface RawArrowFunction extends RawNode {
  readonly kind: SyntaxKind.ArrowFunction;
  readonly isAsync: boolean;
  readonly parameters: RawParameter[];
  readonly returnType?: RawNode;
  readonly body: RawNode;
}

export interface RawFunctionExpression extends RawNode {
  readonly kind: SyntaxKind.FunctionExpression;
  readonly isAsync: boolean;
  readonly name?: RawIdentifier;
  readonly parameters: RawParameter[];
  readonly returnType?: RawNode;
  readonly body: RawNode;
}

export interface RawParenthesizedExpression extends RawNode {
  readonly kind: SyntaxKind.ParenthesizedExpression;
  readonly expression: RawNode;
}

export interface RawAsExpression extends RawNode {
  readonly kind: SyntaxKind.AsExpression | SyntaxKind.SatisfiesExpression;
  readonly expression: RawNode;
  readonly typeNode: RawNode;
}

export interface RawReturnStatement extends RawNode {
  readonly kind: SyntaxKind.ReturnStatement;
  readonly expression?: RawNode;
}

export interface RawBlock extends RawNode {
  readonly kind: SyntaxKind.Block;
  readonly statements: RawNode[];
}

export interface RawUnionOrIntersectionType extends RawNode {
  readonly kind: SyntaxKind.UnionType | SyntaxKind.IntersectionType;
  readonly types: RawNode[];
}

export interface RawArrayType extends RawNode {
  readonly kind: SyntaxKind.ArrayType;
  readonly elementType: RawNode;
}

export interface RawTypeReference extends RawNode {
  readonly kind: SyntaxKind.TypeReference;
  readonly typeName: RawNode;
  readonly typeArguments: RawNode[];
}

export interface RawTypeLiteral extends RawNode {
  readonly kind: SyntaxKind.TypeLiteral;
  readonly members: RawNode[];
}

export interface RawTupleType extends RawNode {
  readonly kind: SyntaxKind.TupleType;
  readonly elements: RawNode[];
}

export interface RawFunctionType extends RawNode {
  readonly kind: SyntaxKind.FunctionType | SyntaxKind.ConstructorType;
  readonly parameters: RawParameter[];
  readonly returnType: RawNode;
}

export interface RawParenthesizedType extends RawNode {
  readonly kind: SyntaxKind.ParenthesizedType;
  readonly typeNode: RawNode;
}

export interface RawTypeOperator extends RawNode {
  readonly kind: SyntaxKind.TypeOperator;
  readonly operator: SyntaxKind;
  readonly typeNode: RawNode;
}

export interface RawTypeQuery extends RawNode {
  readonly kind: SyntaxKind.TypeQuery;
  readonly exprName: RawNode;
}

export interface RawLiteralType extends RawNode {
  readonly kind: SyntaxKind.LiteralType;
  readonly literal: RawNode;
}

export interface RawSourceFile extends RawNode {
  readonly kind: SyntaxKind.SourceFile;
  readonly statements: RawNode[];
  readonly lineStarts: number[];
}

const STATEMENT_MODIFIERS = new Set<SyntaxKind>([
  SyntaxKind.ExportKeyword,
  SyntaxKind.DefaultKeyword,
  SyntaxKind.DeclareKeyword,
  SyntaxKind.AbstractKeyword,
  SyntaxKind.AsyncKeyword,
]);

const MEMBER_MODIFIERS = new Set<SyntaxKind>([
  SyntaxKind.PublicKeyword,
  SyntaxKind.PrivateKeyword,
  SyntaxKind.ProtectedKeyword,
  SyntaxKind.StaticKeyword,
  SyntaxKind.ReadonlyKeyword,
  SyntaxKind.AbstractKeyword,
  SyntaxKind.DeclareKeyword,
  SyntaxKind.OverrideKeyword,
  SyntaxKind.AsyncKeyword,
  SyntaxKind.AccessorKeyword,
]);

const PARAM_MODIFIERS = new Set<SyntaxKind>([
  SyntaxKind.PublicKeyword,
  SyntaxKind.PrivateKeyword,
  SyntaxKind.ProtectedKeyword,
  SyntaxKind.ReadonlyKeyword,
  SyntaxKind.OverrideKeyword,
]);

const HARD_RESERVED_KEYWORDS = new Set<SyntaxKind>([
  SyntaxKind.BreakKeyword,
  SyntaxKind.CaseKeyword,
  SyntaxKind.CatchKeyword,
  SyntaxKind.ClassKeyword,
  SyntaxKind.ConstKeyword,
  SyntaxKind.ContinueKeyword,
  SyntaxKind.DebuggerKeyword,
  SyntaxKind.DefaultKeyword,
  SyntaxKind.DeleteKeyword,
  SyntaxKind.DoKeyword,
  SyntaxKind.ElseKeyword,
  SyntaxKind.EnumKeyword,
  SyntaxKind.ExportKeyword,
  SyntaxKind.ExtendsKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.FinallyKeyword,
  SyntaxKind.ForKeyword,
  SyntaxKind.FunctionKeyword,
  SyntaxKind.IfKeyword,
  SyntaxKind.ImportKeyword,
  SyntaxKind.InKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.NewKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.ReturnKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.SwitchKeyword,
  SyntaxKind.ThisKeyword,
  SyntaxKind.ThrowKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.TryKeyword,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.VarKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.WhileKeyword,
  SyntaxKind.WithKeyword,
]);

function isWordToken(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.Identifier ||
    kind === SyntaxKind.PrivateIdentifier ||
    (kind >= SyntaxKind.TrueKeyword && kind <= SyntaxKind.WithKeyword)
  );
}

function isContextualIdentifier(kind: SyntaxKind): boolean {
  if (kind === SyntaxKind.Identifier) return true;
  if (kind >= SyntaxKind.TrueKeyword && kind <= SyntaxKind.WithKeyword) {
    return !HARD_RESERVED_KEYWORDS.has(kind);
  }
  return false;
}

function getBinaryPrecedence(kind: SyntaxKind): number {
  switch (kind) {
    case SyntaxKind.BarBarToken:
    case SyntaxKind.QuestionQuestionToken:
      return 3;
    case SyntaxKind.AmpersandAmpersandToken:
      return 4;
    case SyntaxKind.BarToken:
      return 5;
    case SyntaxKind.CaretToken:
      return 6;
    case SyntaxKind.AmpersandToken:
      return 7;
    case SyntaxKind.EqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsToken:
    case SyntaxKind.EqualsEqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsEqualsToken:
      return 8;
    case SyntaxKind.LessThanToken:
    case SyntaxKind.GreaterThanToken:
    case SyntaxKind.LessThanEqualsToken:
    case SyntaxKind.GreaterThanEqualsToken:
    case SyntaxKind.InKeyword:
    case SyntaxKind.InstanceOfKeyword:
      return 9;
    case SyntaxKind.LessThanLessThanToken:
    case SyntaxKind.GreaterThanGreaterThanToken:
    case SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return 10;
    case SyntaxKind.PlusToken:
    case SyntaxKind.MinusToken:
      return 11;
    case SyntaxKind.AsteriskToken:
    case SyntaxKind.SlashToken:
    case SyntaxKind.PercentToken:
      return 12;
    case SyntaxKind.AsteriskAsteriskToken:
      return 13;
    default:
      return 0;
  }
}

interface ParserState {
  readonly pos: number;
  readonly pending: Token | null;
}

class TypeScriptParser {
  private readonly tokens: readonly Token[];
  private pos = 0;
  private pending: Token | null = null;
  private readonly isTsx: boolean;

  constructor(tokens: readonly Token[], isTsx: boolean) {
    this.tokens = tokens;
    this.isTsx = isTsx;
  }

  private save(): ParserState {
    return { pos: this.pos, pending: this.pending };
  }

  private restore(state: ParserState): void {
    this.pos = state.pos;
    this.pending = state.pending;
  }

  private peek(offset = 0): Token {
    if (offset === 0) {
      return this.pending ?? this.tokens[this.pos]!;
    }
    const idx = this.pending ? this.pos + offset - 1 : this.pos + offset;
    return this.tokens[Math.min(idx, this.tokens.length - 1)]!;
  }

  private advance(): Token {
    if (this.pending) {
      const tok = this.pending;
      this.pending = null;
      return tok;
    }
    const tok = this.tokens[this.pos]!;
    if (tok.kind !== SyntaxKind.EndOfFileToken) {
      this.pos++;
    }
    return tok;
  }

  private match(kind: SyntaxKind): Token | undefined {
    if (this.peek().kind === kind) {
      return this.advance();
    }
    return undefined;
  }

  private atEnd(): boolean {
    return this.peek().kind === SyntaxKind.EndOfFileToken;
  }

  /**
   * Consumes a single `>` in generic type contexts, splitting `>>`, `>>>`, `>=`
   * without mutating the immutable token buffer.
   */
  private consumeGreaterThan(): Token | undefined {
    const tok = this.peek();
    if (tok.kind === SyntaxKind.GreaterThanToken) {
      return this.advance();
    }
    if (tok.kind === SyntaxKind.GreaterThanGreaterThanToken) {
      this.advance();
      this.pending = {
        kind: SyntaxKind.GreaterThanToken,
        start: tok.start + 1,
        end: tok.end,
        text: ">",
        lineBreakBefore: false,
      };
      return {
        kind: SyntaxKind.GreaterThanToken,
        start: tok.start,
        end: tok.start + 1,
        text: ">",
        lineBreakBefore: tok.lineBreakBefore,
      };
    }
    if (tok.kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
      this.advance();
      this.pending = {
        kind: SyntaxKind.GreaterThanGreaterThanToken,
        start: tok.start + 1,
        end: tok.end,
        text: ">>",
        lineBreakBefore: false,
      };
      return {
        kind: SyntaxKind.GreaterThanToken,
        start: tok.start,
        end: tok.start + 1,
        text: ">",
        lineBreakBefore: tok.lineBreakBefore,
      };
    }
    if (tok.kind === SyntaxKind.GreaterThanEqualsToken) {
      this.advance();
      this.pending = {
        kind: SyntaxKind.EqualsToken,
        start: tok.start + 1,
        end: tok.end,
        text: "=",
        lineBreakBefore: false,
      };
      return {
        kind: SyntaxKind.GreaterThanToken,
        start: tok.start,
        end: tok.start + 1,
        text: ">",
        lineBreakBefore: tok.lineBreakBefore,
      };
    }
    return undefined;
  }

  private isGreaterThanLike(): boolean {
    const k = this.peek().kind;
    return (
      k === SyntaxKind.GreaterThanToken ||
      k === SyntaxKind.GreaterThanGreaterThanToken ||
      k === SyntaxKind.GreaterThanGreaterThanGreaterThanToken ||
      k === SyntaxKind.GreaterThanEqualsToken
    );
  }

  private makeIdent(tok: Token): RawIdentifier {
    return {
      kind:
        tok.kind === SyntaxKind.PrivateIdentifier
          ? SyntaxKind.PrivateIdentifier
          : SyntaxKind.Identifier,
      start: tok.start,
      end: tok.end,
      text: tok.text,
    };
  }

  private parseSourceFile(lineStarts: number[], sourceLen: number): RawSourceFile {
    const statements: RawNode[] = [];
    while (!this.atEnd()) {
      const prevPos = this.pos;
      const prevPending = this.pending;
      const stmt = this.parseStatement();
      if (stmt) {
        statements.push(stmt);
      }
      if (this.pos === prevPos && this.pending === prevPending) {
        this.advance();
      }
    }
    return {
      kind: SyntaxKind.SourceFile,
      start: 0,
      end: sourceLen,
      statements,
      lineStarts,
    };
  }

  // ─── Decorators ──────────────────────────────────────────────────────────

  private parseDecorators(): RawDecorator[] {
    const decorators: RawDecorator[] = [];
    while (this.peek().kind === SyntaxKind.AtToken) {
      const atTok = this.advance();
      const expr = this.parseDecoratorExpression();
      decorators.push({
        kind: SyntaxKind.Decorator,
        start: atTok.start,
        end: expr.end,
        expression: expr,
      });
    }
    return decorators;
  }

  private parseDecoratorExpression(): RawNode {
    let expr: RawNode;
    if (this.peek().kind === SyntaxKind.OpenParenToken) {
      const open = this.advance();
      const inner = this.parseExpression();
      const close = this.match(SyntaxKind.CloseParenToken);
      expr = {
        kind: SyntaxKind.ParenthesizedExpression,
        start: open.start,
        end: close ? close.end : inner.end,
        expression: inner,
      } as RawParenthesizedExpression;
    } else if (isWordToken(this.peek().kind)) {
      expr = this.makeIdent(this.advance());
    } else {
      const tok = this.advance();
      expr = this.makeIdent(tok);
    }

    while (!this.atEnd()) {
      if (this.peek().kind === SyntaxKind.DotToken) {
        this.advance();
        if (isWordToken(this.peek().kind)) {
          const name = this.makeIdent(this.advance());
          expr = {
            kind: SyntaxKind.PropertyAccessExpression,
            start: expr.start,
            end: name.end,
            expression: expr,
            name,
          } as RawPropertyAccessExpression;
          continue;
        }
        break;
      }
      if (this.peek().kind === SyntaxKind.LessThanToken) {
        const saved = this.save();
        const typeArgs = this.tryParseTypeArguments();
        if (typeArgs && this.peek().kind === SyntaxKind.OpenParenToken) {
          const { args, end } = this.parseCallArguments();
          expr = {
            kind: SyntaxKind.CallExpression,
            start: expr.start,
            end,
            expression: expr,
            typeArguments: typeArgs,
            arguments: args,
          } as RawCallExpression;
          continue;
        }
        this.restore(saved);
        break;
      }
      if (this.peek().kind === SyntaxKind.OpenParenToken) {
        const { args, end } = this.parseCallArguments();
        expr = {
          kind: SyntaxKind.CallExpression,
          start: expr.start,
          end,
          expression: expr,
          typeArguments: [],
          arguments: args,
        } as RawCallExpression;
        continue;
      }
      break;
    }

    return expr;
  }

  // ─── Statements & Declarations ───────────────────────────────────────────

  private parseStatement(): RawNode | undefined {
    const tok = this.peek();
    if (tok.kind === SyntaxKind.SemicolonToken) {
      this.advance();
      return {
        kind: SyntaxKind.EmptyStatement,
        start: tok.start,
        end: tok.end,
      };
    }

    // Decorated class declaration
    if (tok.kind === SyntaxKind.AtToken) {
      const decorators = this.parseDecorators();
      const modifiers = this.parseModifiers(STATEMENT_MODIFIERS);
      if (this.peek().kind === SyntaxKind.ClassKeyword) {
        return this.parseClassDeclaration(decorators, modifiers);
      }
      return {
        kind: SyntaxKind.UnknownStatement,
        start: decorators[0]!.start,
        end:
          modifiers[modifiers.length - 1]?.end ??
          decorators[decorators.length - 1]!.end,
        children: decorators,
      };
    }

    // Import declaration (distinguish from dynamic `import(...)` and `import.meta`)
    if (
      tok.kind === SyntaxKind.ImportKeyword &&
      this.peek(1).kind !== SyntaxKind.OpenParenToken &&
      this.peek(1).kind !== SyntaxKind.DotToken
    ) {
      return this.parseImportDeclaration();
    }

    // Export declarations / exported statements
    if (tok.kind === SyntaxKind.ExportKeyword) {
      const next = this.peek(1);
      if (
        next.kind === SyntaxKind.OpenBraceToken ||
        next.kind === SyntaxKind.AsteriskToken ||
        (next.kind === SyntaxKind.TypeKeyword &&
          (this.peek(2).kind === SyntaxKind.OpenBraceToken ||
            this.peek(2).kind === SyntaxKind.AsteriskToken))
      ) {
        return this.parseExportDeclaration();
      }
      if (next.kind === SyntaxKind.DefaultKeyword) {
        const afterDefault = this.peek(2);
        if (
          afterDefault.kind === SyntaxKind.ClassKeyword ||
          afterDefault.kind === SyntaxKind.AbstractKeyword ||
          afterDefault.kind === SyntaxKind.FunctionKeyword ||
          (afterDefault.kind === SyntaxKind.AsyncKeyword &&
            this.peek(3).kind === SyntaxKind.FunctionKeyword) ||
          afterDefault.kind === SyntaxKind.InterfaceKeyword
        ) {
          return this.parseDecoratedOrModifiedDeclaration();
        }
        // `export default <expr>;`
        const expTok = this.advance();
        this.advance(); // default
        const expr = this.parseExpression();
        const semi = this.match(SyntaxKind.SemicolonToken);
        return {
          kind: SyntaxKind.ExportAssignment,
          start: expTok.start,
          end: semi ? semi.end : expr.end,
          expression: expr,
        } as RawExportAssignment;
      }
      if (next.kind === SyntaxKind.EqualsToken) {
        const expTok = this.advance();
        this.advance(); // =
        const expr = this.parseExpression();
        const semi = this.match(SyntaxKind.SemicolonToken);
        return {
          kind: SyntaxKind.ExportAssignment,
          start: expTok.start,
          end: semi ? semi.end : expr.end,
          expression: expr,
        } as RawExportAssignment;
      }
      return this.parseDecoratedOrModifiedDeclaration();
    }

    // `declare ...`, `abstract class ...`, `async function ...`
    if (
      tok.kind === SyntaxKind.DeclareKeyword ||
      (tok.kind === SyntaxKind.AbstractKeyword &&
        this.peek(1).kind === SyntaxKind.ClassKeyword) ||
      (tok.kind === SyntaxKind.AsyncKeyword &&
        this.peek(1).kind === SyntaxKind.FunctionKeyword &&
        !this.peek(1).lineBreakBefore)
    ) {
      return this.parseDecoratedOrModifiedDeclaration();
    }

    if (tok.kind === SyntaxKind.ClassKeyword) {
      return this.parseClassDeclaration([], []);
    }
    if (
      tok.kind === SyntaxKind.InterfaceKeyword &&
      isWordToken(this.peek(1).kind) &&
      !this.peek(1).lineBreakBefore
    ) {
      return this.parseInterfaceDeclaration([]);
    }
    if (
      tok.kind === SyntaxKind.TypeKeyword &&
      isWordToken(this.peek(1).kind) &&
      !this.peek(1).lineBreakBefore &&
      (this.peek(2).kind === SyntaxKind.EqualsToken ||
        this.peek(2).kind === SyntaxKind.LessThanToken)
    ) {
      return this.parseTypeAliasDeclaration([]);
    }
    if (
      tok.kind === SyntaxKind.EnumKeyword ||
      (tok.kind === SyntaxKind.ConstKeyword &&
        this.peek(1).kind === SyntaxKind.EnumKeyword)
    ) {
      return this.parseEnumDeclaration([]);
    }
    if (tok.kind === SyntaxKind.FunctionKeyword) {
      return this.parseFunctionDeclaration([]);
    }
    if (
      tok.kind === SyntaxKind.ConstKeyword ||
      tok.kind === SyntaxKind.LetKeyword ||
      tok.kind === SyntaxKind.VarKeyword
    ) {
      return this.parseVariableStatement([]);
    }
    if (
      (tok.kind === SyntaxKind.NamespaceKeyword ||
        tok.kind === SyntaxKind.ModuleKeyword) &&
      (isWordToken(this.peek(1).kind) ||
        this.peek(1).kind === SyntaxKind.StringLiteral) &&
      !this.peek(1).lineBreakBefore
    ) {
      return this.parseModuleDeclaration([]);
    }

    // Control-flow statements
    if (tok.kind === SyntaxKind.OpenBraceToken) {
      return this.parseBlock();
    }
    if (tok.kind === SyntaxKind.ReturnKeyword) {
      return this.parseReturnStatement();
    }
    if (tok.kind === SyntaxKind.ThrowKeyword) {
      const startTok = this.advance();
      const expr = this.parseExpression();
      const semi = this.match(SyntaxKind.SemicolonToken);
      return {
        kind: SyntaxKind.ThrowStatement,
        start: startTok.start,
        end: semi ? semi.end : expr.end,
        children: [expr],
      };
    }
    if (tok.kind === SyntaxKind.IfKeyword) {
      return this.parseIfStatement();
    }
    if (tok.kind === SyntaxKind.ForKeyword) {
      return this.parseForStatement();
    }
    if (tok.kind === SyntaxKind.WhileKeyword) {
      return this.parseWhileStatement();
    }
    if (tok.kind === SyntaxKind.DoKeyword) {
      const startTok = this.advance();
      const body = this.parseStatement();
      this.match(SyntaxKind.WhileKeyword);
      const cond = this.parseParenExpressionOrEmpty();
      const semi = this.match(SyntaxKind.SemicolonToken);
      return {
        kind: SyntaxKind.WhileStatement,
        start: startTok.start,
        end: semi ? semi.end : cond?.end ?? body?.end ?? startTok.end,
        children: [body, cond].filter((x): x is RawNode => Boolean(x)),
      };
    }
    if (tok.kind === SyntaxKind.TryKeyword) {
      return this.parseTryStatement();
    }
    if (tok.kind === SyntaxKind.SwitchKeyword) {
      return this.parseSwitchStatement();
    }
    if (
      tok.kind === SyntaxKind.BreakKeyword ||
      tok.kind === SyntaxKind.ContinueKeyword ||
      tok.kind === SyntaxKind.DebuggerKeyword
    ) {
      const startTok = this.advance();
      let end = startTok.end;
      if (
        tok.kind !== SyntaxKind.DebuggerKeyword &&
        isContextualIdentifier(this.peek().kind) &&
        !this.peek().lineBreakBefore
      ) {
        end = this.advance().end;
      }
      const semi = this.match(SyntaxKind.SemicolonToken);
      return {
        kind: SyntaxKind.UnknownStatement,
        start: startTok.start,
        end: semi ? semi.end : end,
      };
    }

    // Labeled statement `label: stmt`
    if (
      isContextualIdentifier(tok.kind) &&
      this.peek(1).kind === SyntaxKind.ColonToken
    ) {
      this.advance();
      this.advance();
      return this.parseStatement();
    }

    // Expression statement
    const expr = this.parseExpression();
    const semi = this.match(SyntaxKind.SemicolonToken);
    return {
      kind: SyntaxKind.ExpressionStatement,
      start: expr.start,
      end: semi ? semi.end : expr.end,
      children: [expr],
    };
  }

  private parseDecoratedOrModifiedDeclaration(): RawNode {
    const decorators = this.parseDecorators();
    const modifiers = this.parseModifiers(STATEMENT_MODIFIERS);
    const next = this.peek();

    if (next.kind === SyntaxKind.AtToken) {
      // `export @Dec() class Foo` (stage-3 decorator placement)
      const moreDecs = this.parseDecorators();
      const moreMods = this.parseModifiers(STATEMENT_MODIFIERS);
      return this.parseClassDeclaration(
        [...decorators, ...moreDecs],
        [...modifiers, ...moreMods],
      );
    }
    if (next.kind === SyntaxKind.ClassKeyword) {
      return this.parseClassDeclaration(decorators, modifiers);
    }
    if (next.kind === SyntaxKind.InterfaceKeyword) {
      return this.parseInterfaceDeclaration(modifiers);
    }
    if (next.kind === SyntaxKind.TypeKeyword) {
      return this.parseTypeAliasDeclaration(modifiers);
    }
    if (
      next.kind === SyntaxKind.EnumKeyword ||
      (next.kind === SyntaxKind.ConstKeyword &&
        this.peek(1).kind === SyntaxKind.EnumKeyword)
    ) {
      return this.parseEnumDeclaration(modifiers);
    }
    if (next.kind === SyntaxKind.FunctionKeyword) {
      return this.parseFunctionDeclaration(modifiers);
    }
    if (
      next.kind === SyntaxKind.ConstKeyword ||
      next.kind === SyntaxKind.LetKeyword ||
      next.kind === SyntaxKind.VarKeyword
    ) {
      return this.parseVariableStatement(modifiers);
    }
    if (
      next.kind === SyntaxKind.NamespaceKeyword ||
      next.kind === SyntaxKind.ModuleKeyword ||
      next.kind === SyntaxKind.GlobalKeyword
    ) {
      return this.parseModuleDeclaration(modifiers);
    }

    const start =
      decorators[0]?.start ?? modifiers[0]?.start ?? this.peek().start;
    const expr = this.parseExpression();
    const semi = this.match(SyntaxKind.SemicolonToken);
    return {
      kind: SyntaxKind.UnknownStatement,
      start,
      end: semi ? semi.end : expr.end,
      children: [...decorators, expr],
    };
  }

  private parseModifiers(allowed: ReadonlySet<SyntaxKind>): RawModifier[] {
    const mods: RawModifier[] = [];
    while (allowed.has(this.peek().kind)) {
      const tok = this.advance();
      mods.push({
        kind: tok.kind,
        start: tok.start,
        end: tok.end,
        text: tok.text,
      });
    }
    return mods;
  }

  // ─── Import & Export Declarations ────────────────────────────────────────

  private parseImportDeclaration(): RawImportDeclaration {
    const startTok = this.advance(); // import
    let isTypeOnly = false;

    // `import "side-effect";`
    if (this.peek().kind === SyntaxKind.StringLiteral) {
      const mod = this.parseStringLiteral();
      const semi = this.match(SyntaxKind.SemicolonToken);
      return {
        kind: SyntaxKind.ImportDeclaration,
        start: startTok.start,
        end: semi ? semi.end : mod.end,
        isTypeOnly: false,
        namedImports: [],
        moduleSpecifier: mod,
      };
    }

    // `import type ...` (but NOT `import type from "./x"` or `import type, { A } from "./x"`)
    if (
      this.peek().kind === SyntaxKind.TypeKeyword &&
      this.peek(1).kind !== SyntaxKind.FromKeyword &&
      this.peek(1).kind !== SyntaxKind.CommaToken
    ) {
      isTypeOnly = true;
      this.advance();
    }

    let defaultImport: RawIdentifier | undefined;
    let namespaceImport: RawIdentifier | undefined;
    const namedImports: RawImportSpecifier[] = [];

    if (
      isWordToken(this.peek().kind) &&
      this.peek().kind !== SyntaxKind.FromKeyword
    ) {
      defaultImport = this.makeIdent(this.advance());
      this.match(SyntaxKind.CommaToken);
    }

    if (this.match(SyntaxKind.AsteriskToken)) {
      this.match(SyntaxKind.AsKeyword);
      if (isWordToken(this.peek().kind)) {
        namespaceImport = this.makeIdent(this.advance());
      }
    } else if (this.match(SyntaxKind.OpenBraceToken)) {
      while (!this.atEnd() && this.peek().kind !== SyntaxKind.CloseBraceToken) {
        const specStart = this.peek().start;
        let specTypeOnly = false;
        if (
          this.peek().kind === SyntaxKind.TypeKeyword &&
          this.peek(1).kind !== SyntaxKind.CommaToken &&
          this.peek(1).kind !== SyntaxKind.CloseBraceToken &&
          this.peek(1).kind !== SyntaxKind.AsKeyword
        ) {
          specTypeOnly = true;
          this.advance();
        }
        if (
          !isWordToken(this.peek().kind) &&
          this.peek().kind !== SyntaxKind.StringLiteral
        ) {
          this.advance();
          continue;
        }
        const nameTok = this.advance();
        const nameNode: RawIdentifier = {
          kind: SyntaxKind.Identifier,
          start: nameTok.start,
          end: nameTok.end,
          text:
            nameTok.kind === SyntaxKind.StringLiteral
              ? String(nameTok.value ?? "")
              : nameTok.text,
        };
        let aliasNode: RawIdentifier | undefined;
        let specEnd = nameNode.end;
        if (this.match(SyntaxKind.AsKeyword) && isWordToken(this.peek().kind)) {
          aliasNode = this.makeIdent(this.advance());
          specEnd = aliasNode.end;
        }
        namedImports.push({
          kind: SyntaxKind.ImportSpecifier,
          start: specStart,
          end: specEnd,
          isTypeOnly: specTypeOnly,
          name: nameNode,
          alias: aliasNode,
        });
        if (!this.match(SyntaxKind.CommaToken)) break;
      }
      this.match(SyntaxKind.CloseBraceToken);
    }

    this.match(SyntaxKind.FromKeyword);
    const moduleSpecifier =
      this.peek().kind === SyntaxKind.StringLiteral
        ? this.parseStringLiteral()
        : ({
            kind: SyntaxKind.StringLiteral,
            start: this.peek().start,
            end: this.peek().start,
            text: '""',
            value: "",
          } as RawStringLiteral);

    // Optional import attributes `with { type: "json" }` / `assert { ... }`
    let end = moduleSpecifier.end;
    if (
      this.peek().kind === SyntaxKind.WithKeyword ||
      (this.peek().kind === SyntaxKind.Identifier &&
        this.peek().text === "assert")
    ) {
      this.advance();
      if (this.peek().kind === SyntaxKind.OpenBraceToken) {
        const obj = this.parseObjectLiteral();
        end = obj.end;
      }
    }

    const semi = this.match(SyntaxKind.SemicolonToken);
    if (semi) end = semi.end;

    return {
      kind: SyntaxKind.ImportDeclaration,
      start: startTok.start,
      end,
      isTypeOnly,
      defaultImport,
      namespaceImport,
      namedImports,
      moduleSpecifier,
    };
  }

  private parseExportDeclaration(): RawExportDeclaration {
    const startTok = this.advance(); // export
    let isTypeOnly = false;
    if (this.match(SyntaxKind.TypeKeyword)) {
      isTypeOnly = true;
    }

    let isNamespaceExport = false;
    let namespaceAlias: RawIdentifier | undefined;
    const namedExports: RawExportSpecifier[] = [];
    let end = startTok.end;

    if (this.match(SyntaxKind.AsteriskToken)) {
      isNamespaceExport = true;
      end = this.tokens[this.pos - 1]?.end ?? end;
      if (this.match(SyntaxKind.AsKeyword) && isWordToken(this.peek().kind)) {
        namespaceAlias = this.makeIdent(this.advance());
        end = namespaceAlias.end;
      }
    } else if (this.match(SyntaxKind.OpenBraceToken)) {
      while (!this.atEnd() && this.peek().kind !== SyntaxKind.CloseBraceToken) {
        const specStart = this.peek().start;
        let specTypeOnly = false;
        if (
          this.peek().kind === SyntaxKind.TypeKeyword &&
          this.peek(1).kind !== SyntaxKind.CommaToken &&
          this.peek(1).kind !== SyntaxKind.CloseBraceToken &&
          this.peek(1).kind !== SyntaxKind.AsKeyword
        ) {
          specTypeOnly = true;
          this.advance();
        }
        if (!isWordToken(this.peek().kind)) {
          this.advance();
          continue;
        }
        const nameNode = this.makeIdent(this.advance());
        let aliasNode: RawIdentifier | undefined;
        let specEnd = nameNode.end;
        if (this.match(SyntaxKind.AsKeyword) && isWordToken(this.peek().kind)) {
          aliasNode = this.makeIdent(this.advance());
          specEnd = aliasNode.end;
        }
        namedExports.push({
          kind: SyntaxKind.ExportSpecifier,
          start: specStart,
          end: specEnd,
          isTypeOnly: specTypeOnly,
          name: nameNode,
          alias: aliasNode,
        });
        if (!this.match(SyntaxKind.CommaToken)) break;
      }
      const close = this.match(SyntaxKind.CloseBraceToken);
      if (close) end = close.end;
    }

    let moduleSpecifier: RawStringLiteral | undefined;
    if (
      this.match(SyntaxKind.FromKeyword) &&
      this.peek().kind === SyntaxKind.StringLiteral
    ) {
      moduleSpecifier = this.parseStringLiteral();
      end = moduleSpecifier.end;
    }

    const semi = this.match(SyntaxKind.SemicolonToken);
    if (semi) end = semi.end;

    return {
      kind: SyntaxKind.ExportDeclaration,
      start: startTok.start,
      end,
      isTypeOnly,
      isNamespaceExport,
      namespaceAlias,
      namedExports,
      moduleSpecifier,
    };
  }

  // ─── Class Declaration ───────────────────────────────────────────────────

  private parseClassDeclaration(
    decorators: RawDecorator[],
    modifiers: RawModifier[],
    isExpression = false,
  ): RawClassDeclaration {
    const classKw = this.advance(); // class
    const start =
      decorators[0]?.start ?? modifiers[0]?.start ?? classKw.start;

    let name: RawIdentifier | undefined;
    if (
      isWordToken(this.peek().kind) &&
      this.peek().kind !== SyntaxKind.ExtendsKeyword &&
      this.peek().kind !== SyntaxKind.ImplementsKeyword
    ) {
      name = this.makeIdent(this.advance());
    }

    if (this.peek().kind === SyntaxKind.LessThanToken) {
      this.skipTypeParameters();
    }

    let extendsClause: RawExpressionWithTypeArguments | undefined;
    const implementsClauses: RawExpressionWithTypeArguments[] = [];

    if (this.match(SyntaxKind.ExtendsKeyword)) {
      extendsClause = this.parseHeritageExpression();
    }

    if (this.match(SyntaxKind.ImplementsKeyword)) {
      do {
        implementsClauses.push(this.parseHeritageExpression());
      } while (this.match(SyntaxKind.CommaToken));
    }

    const properties: RawPropertyDeclaration[] = [];
    const methods: RawMethodDeclaration[] = [];
    const constructors: RawConstructorDeclaration[] = [];
    const members: RawNode[] = [];

    let end = this.peek().end;
    if (this.match(SyntaxKind.OpenBraceToken)) {
      while (!this.atEnd() && this.peek().kind !== SyntaxKind.CloseBraceToken) {
        if (this.match(SyntaxKind.SemicolonToken)) continue;
        const prevPos = this.pos;
        const prevPending = this.pending;
        const member = this.parseClassMember();
        if (member) {
          members.push(member);
          if (member.kind === SyntaxKind.PropertyDeclaration) {
            properties.push(member as RawPropertyDeclaration);
          } else if (member.kind === SyntaxKind.MethodDeclaration) {
            methods.push(member as RawMethodDeclaration);
          } else if (member.kind === SyntaxKind.Constructor) {
            constructors.push(member as RawConstructorDeclaration);
          }
        }
        if (this.pos === prevPos && this.pending === prevPending) {
          this.advance();
        }
      }
      const close = this.match(SyntaxKind.CloseBraceToken);
      end = close ? close.end : this.peek().end;
    }

    return {
      kind: isExpression
        ? SyntaxKind.ClassExpression
        : SyntaxKind.ClassDeclaration,
      start,
      end,
      decorators,
      modifiers,
      name,
      extendsClause,
      implementsClauses,
      properties,
      methods,
      constructors,
      members,
    };
  }

  private parseHeritageExpression(): RawExpressionWithTypeArguments {
    let expr: RawNode;
    if (isWordToken(this.peek().kind)) {
      expr = this.makeIdent(this.advance());
      while (this.peek().kind === SyntaxKind.DotToken) {
        this.advance();
        if (isWordToken(this.peek().kind)) {
          const prop = this.makeIdent(this.advance());
          expr = {
            kind: SyntaxKind.PropertyAccessExpression,
            start: expr.start,
            end: prop.end,
            expression: expr,
            name: prop,
          } as RawPropertyAccessExpression;
        }
      }
    } else {
      expr = this.parseLeftHandSideExpression();
    }

    let typeArguments: RawNode[] = [];
    let end = expr.end;
    if (this.peek().kind === SyntaxKind.LessThanToken) {
      const parsed = this.parseTypeArguments();
      typeArguments = parsed.args;
      end = parsed.end;
    }

    return {
      kind: SyntaxKind.ExpressionWithTypeArguments,
      start: expr.start,
      end,
      expression: expr,
      typeArguments,
    };
  }

  private parseClassMember(): RawNode | undefined {
    const decorators = this.parseDecorators();
    const modifiers: RawModifier[] = [];

    // Parse member modifiers, being careful not to consume a keyword that IS the member name
    while (MEMBER_MODIFIERS.has(this.peek().kind)) {
      const nextKind = this.peek(1).kind;
      // Static initialization block `static { ... }`
      if (
        this.peek().kind === SyntaxKind.StaticKeyword &&
        nextKind === SyntaxKind.OpenBraceToken
      ) {
        const staticTok = this.advance();
        const block = this.parseBlock();
        return {
          kind: SyntaxKind.Block,
          start: decorators[0]?.start ?? staticTok.start,
          end: block.end,
          statements: block.statements,
        } as RawBlock;
      }
      if (
        nextKind === SyntaxKind.OpenParenToken ||
        nextKind === SyntaxKind.LessThanToken ||
        nextKind === SyntaxKind.ColonToken ||
        nextKind === SyntaxKind.EqualsToken ||
        nextKind === SyntaxKind.QuestionToken ||
        nextKind === SyntaxKind.ExclamationToken ||
        nextKind === SyntaxKind.SemicolonToken ||
        nextKind === SyntaxKind.CloseBraceToken
      ) {
        break;
      }
      const modTok = this.advance();
      modifiers.push({
        kind: modTok.kind,
        start: modTok.start,
        end: modTok.end,
        text: modTok.text,
      });
    }

    const memberStart =
      decorators[0]?.start ?? modifiers[0]?.start ?? this.peek().start;

    // Index signature `[key: string]: T;`
    if (
      this.peek().kind === SyntaxKind.OpenBracketToken &&
      isWordToken(this.peek(1).kind) &&
      this.peek(2).kind === SyntaxKind.ColonToken
    ) {
      return this.parseIndexSignature(memberStart);
    }

    // Getter / Setter (`get foo() {}` / `set foo(v) {}`)
    if (
      (this.peek().kind === SyntaxKind.GetKeyword ||
        this.peek().kind === SyntaxKind.SetKeyword) &&
      this.peek(1).kind !== SyntaxKind.OpenParenToken &&
      this.peek(1).kind !== SyntaxKind.LessThanToken &&
      this.peek(1).kind !== SyntaxKind.ColonToken &&
      this.peek(1).kind !== SyntaxKind.EqualsToken &&
      this.peek(1).kind !== SyntaxKind.QuestionToken &&
      this.peek(1).kind !== SyntaxKind.ExclamationToken &&
      this.peek(1).kind !== SyntaxKind.SemicolonToken
    ) {
      const accTok = this.advance();
      const nameNode = this.parseMemberName();
      const parameters = this.parseParameterList();
      let returnType: RawNode | undefined;
      if (this.match(SyntaxKind.ColonToken)) {
        returnType = this.parseType();
      }
      let body: RawNode | undefined;
      let end = returnType?.end ?? nameNode.end;
      if (this.peek().kind === SyntaxKind.OpenBraceToken) {
        body = this.parseBlock();
        end = body.end;
      } else {
        const semi = this.match(SyntaxKind.SemicolonToken);
        if (semi) end = semi.end;
      }
      return {
        kind:
          accTok.kind === SyntaxKind.GetKeyword
            ? SyntaxKind.GetAccessor
            : SyntaxKind.SetAccessor,
        start: memberStart,
        end,
        children: [
          ...decorators,
          nameNode,
          ...parameters,
          ...(returnType ? [returnType] : []),
          ...(body ? [body] : []),
        ],
      };
    }

    // Generator method `*foo()`
    this.match(SyntaxKind.AsteriskToken);

    // Constructor
    if (
      this.peek().kind === SyntaxKind.ConstructorKeyword &&
      this.peek(1).kind === SyntaxKind.OpenParenToken
    ) {
      const ctorTok = this.advance();
      const parameters = this.parseParameterList();
      let body: RawNode | undefined;
      let end = this.tokens[this.pos - 1]?.end ?? ctorTok.end;
      if (this.peek().kind === SyntaxKind.OpenBraceToken) {
        body = this.parseBlock();
        end = body.end;
      } else {
        const semi = this.match(SyntaxKind.SemicolonToken);
        if (semi) end = semi.end;
      }
      return {
        kind: SyntaxKind.Constructor,
        start: memberStart,
        end,
        decorators,
        modifiers,
        parameters,
        body,
      } as RawConstructorDeclaration;
    }

    const nameNode = this.parseMemberName();
    const questionToken = Boolean(this.match(SyntaxKind.QuestionToken));
    const exclamationToken =
      !questionToken && Boolean(this.match(SyntaxKind.ExclamationToken));

    // Method declaration: `name<T>(params): Ret { ... }` or `abstract name(...): Ret;`
    if (
      this.peek().kind === SyntaxKind.OpenParenToken ||
      this.peek().kind === SyntaxKind.LessThanToken
    ) {
      if (this.peek().kind === SyntaxKind.LessThanToken) {
        this.skipTypeParameters();
      }
      const parameters = this.parseParameterList();
      let end = this.tokens[this.pos - 1]?.end ?? nameNode.end;
      let returnType: RawNode | undefined;
      if (this.match(SyntaxKind.ColonToken)) {
        returnType = this.parseType();
        end = returnType.end;
      }
      let body: RawNode | undefined;
      if (this.peek().kind === SyntaxKind.OpenBraceToken) {
        body = this.parseBlock();
        end = body.end;
      } else {
        const semi = this.match(SyntaxKind.SemicolonToken);
        if (semi) end = semi.end;
      }
      return {
        kind: SyntaxKind.MethodDeclaration,
        start: memberStart,
        end,
        decorators,
        modifiers,
        name: nameNode,
        questionToken,
        parameters,
        returnType,
        body,
      } as RawMethodDeclaration;
    }

    // Property declaration
    let end = this.tokens[this.pos - 1]?.end ?? nameNode.end;
    let typeNode: RawNode | undefined;
    if (this.match(SyntaxKind.ColonToken)) {
      typeNode = this.parseType();
      end = typeNode.end;
    }
    let initializer: RawNode | undefined;
    if (this.match(SyntaxKind.EqualsToken)) {
      if (!this.looksLikeNextClassMemberAfterNewline()) {
        initializer = this.parseAssignmentExpression();
        end = initializer.end;
      }
    }
    const semi = this.match(SyntaxKind.SemicolonToken);
    if (semi) end = semi.end;

    return {
      kind: SyntaxKind.PropertyDeclaration,
      start: memberStart,
      end,
      decorators,
      modifiers,
      name: nameNode,
      questionToken,
      exclamationToken,
      typeNode,
      initializer,
    } as RawPropertyDeclaration;
  }

  private looksLikeNextClassMemberAfterNewline(): boolean {
    const tok = this.peek();
    if (!tok.lineBreakBefore) return false;
    if (
      tok.kind === SyntaxKind.AtToken ||
      tok.kind === SyntaxKind.CloseBraceToken ||
      tok.kind === SyntaxKind.EndOfFileToken ||
      MEMBER_MODIFIERS.has(tok.kind)
    ) {
      return true;
    }
    if (!isWordToken(tok.kind)) return false;
    const saved = this.save();
    this.advance(); // member name
    this.match(SyntaxKind.QuestionToken);
    if (this.peek().kind === SyntaxKind.LessThanToken) {
      if (!this.trySkipTypeParameters()) {
        this.restore(saved);
        return false;
      }
    }
    if (this.peek().kind === SyntaxKind.OpenParenToken) {
      this.parseParameterList();
      const after = this.peek().kind;
      this.restore(saved);
      return (
        after === SyntaxKind.ColonToken || after === SyntaxKind.OpenBraceToken
      );
    }
    this.restore(saved);
    return false;
  }

  private parseMemberName(): RawNode {
    const tok = this.peek();
    if (tok.kind === SyntaxKind.StringLiteral) {
      return this.parseStringLiteral();
    }
    if (tok.kind === SyntaxKind.NumericLiteral) {
      return this.parseNumericLiteral();
    }
    if (tok.kind === SyntaxKind.OpenBracketToken) {
      const open = this.advance();
      const expr = this.parseExpression();
      const close = this.match(SyntaxKind.CloseBracketToken);
      return {
        kind: SyntaxKind.ElementAccessExpression,
        start: open.start,
        end: close ? close.end : expr.end,
        expression: expr,
        argumentExpression: expr,
      } as RawElementAccessExpression;
    }
    if (isWordToken(tok.kind)) {
      return this.makeIdent(this.advance());
    }
    return this.makeIdent(this.advance());
  }

  private parseIndexSignature(start: number): RawNode {
    this.match(SyntaxKind.OpenBracketToken);
    let depth = 1;
    while (!this.atEnd() && depth > 0) {
      const t = this.advance();
      if (t.kind === SyntaxKind.OpenBracketToken) depth++;
      else if (t.kind === SyntaxKind.CloseBracketToken) depth--;
    }
    // Mapped types may have optional `+`/`-` and `?` modifiers before `:`
    if (
      this.peek().kind === SyntaxKind.PlusToken ||
      this.peek().kind === SyntaxKind.MinusToken
    ) {
      if (this.peek(1).kind === SyntaxKind.QuestionToken) {
        this.advance();
        this.advance();
      }
    } else {
      this.match(SyntaxKind.QuestionToken);
    }
    let end = this.tokens[this.pos - 1]?.end ?? start;
    if (this.match(SyntaxKind.ColonToken)) {
      const t = this.parseType();
      end = t.end;
    }
    const semi =
      this.match(SyntaxKind.SemicolonToken) ?? this.match(SyntaxKind.CommaToken);
    if (semi) end = semi.end;
    return {
      kind: SyntaxKind.IndexSignature,
      start,
      end,
    };
  }

  private parseParameterList(): RawParameter[] {
    const params: RawParameter[] = [];
    if (!this.match(SyntaxKind.OpenParenToken)) return params;

    while (!this.atEnd() && this.peek().kind !== SyntaxKind.CloseParenToken) {
      const prevPos = this.pos;
      const decorators = this.parseDecorators();
      const modifiers: RawModifier[] = [];
      while (PARAM_MODIFIERS.has(this.peek().kind)) {
        const nextKind = this.peek(1).kind;
        if (
          nextKind === SyntaxKind.ColonToken ||
          nextKind === SyntaxKind.QuestionToken ||
          nextKind === SyntaxKind.EqualsToken ||
          nextKind === SyntaxKind.CommaToken ||
          nextKind === SyntaxKind.CloseParenToken
        ) {
          break;
        }
        const m = this.advance();
        modifiers.push({ kind: m.kind, start: m.start, end: m.end, text: m.text });
      }

      const start =
        decorators[0]?.start ?? modifiers[0]?.start ?? this.peek().start;
      const isRest = Boolean(this.match(SyntaxKind.DotDotDotToken));
      const name = this.parseBindingPattern();
      const questionToken = Boolean(this.match(SyntaxKind.QuestionToken));
      let end = this.tokens[this.pos - 1]?.end ?? name.end;
      let typeNode: RawNode | undefined;
      if (this.match(SyntaxKind.ColonToken)) {
        typeNode = this.parseType();
        end = typeNode.end;
      }
      let initializer: RawNode | undefined;
      if (this.match(SyntaxKind.EqualsToken)) {
        initializer = this.parseAssignmentExpression();
        end = initializer.end;
      }
      params.push({
        kind: SyntaxKind.Parameter,
        start,
        end,
        decorators,
        modifiers,
        isRest,
        name,
        questionToken,
        typeNode,
        initializer,
      });

      if (!this.match(SyntaxKind.CommaToken)) break;
      if (this.pos === prevPos) this.advance();
    }

    this.match(SyntaxKind.CloseParenToken);
    return params;
  }

  private parseBindingPattern(): RawNode {
    const tok = this.peek();
    if (tok.kind === SyntaxKind.OpenBraceToken) {
      const open = this.advance();
      let depth = 1;
      let end = open.end;
      while (!this.atEnd() && depth > 0) {
        const t = this.advance();
        end = t.end;
        if (t.kind === SyntaxKind.OpenBraceToken) depth++;
        else if (t.kind === SyntaxKind.CloseBraceToken) depth--;
      }
      return { kind: SyntaxKind.Identifier, start: open.start, end, text: "{...}" };
    }
    if (tok.kind === SyntaxKind.OpenBracketToken) {
      const open = this.advance();
      let depth = 1;
      let end = open.end;
      while (!this.atEnd() && depth > 0) {
        const t = this.advance();
        end = t.end;
        if (t.kind === SyntaxKind.OpenBracketToken) depth++;
        else if (t.kind === SyntaxKind.CloseBracketToken) depth--;
      }
      return { kind: SyntaxKind.Identifier, start: open.start, end, text: "[...]" };
    }
    return this.makeIdent(this.advance());
  }

  // ─── Interface / Type Alias / Enum / Function / Variable / Module ────────

  private parseInterfaceDeclaration(
    modifiers: RawModifier[],
  ): RawInterfaceDeclaration {
    const kw = this.advance(); // interface
    const start = modifiers[0]?.start ?? kw.start;
    const name = this.makeIdent(this.advance());
    if (this.peek().kind === SyntaxKind.LessThanToken) {
      this.skipTypeParameters();
    }
    const extendsClauses: RawExpressionWithTypeArguments[] = [];
    if (this.match(SyntaxKind.ExtendsKeyword)) {
      do {
        extendsClauses.push(this.parseHeritageExpression());
      } while (this.match(SyntaxKind.CommaToken));
    }
    const { members, end } = this.parseTypeMemberBlock();
    return {
      kind: SyntaxKind.InterfaceDeclaration,
      start,
      end,
      modifiers,
      name,
      extendsClauses,
      members,
    };
  }

  private parseTypeMemberBlock(): { members: RawNode[]; end: number } {
    const members: RawNode[] = [];
    let end = this.peek().end;
    if (!this.match(SyntaxKind.OpenBraceToken)) return { members, end };

    while (!this.atEnd() && this.peek().kind !== SyntaxKind.CloseBraceToken) {
      if (
        this.match(SyntaxKind.SemicolonToken) ||
        this.match(SyntaxKind.CommaToken)
      ) {
        continue;
      }
      const prevPos = this.pos;
      const prevPending = this.pending;
      const mem = this.parseTypeMember();
      if (mem) members.push(mem);
      if (this.pos === prevPos && this.pending === prevPending) {
        this.advance();
      }
    }
    const close = this.match(SyntaxKind.CloseBraceToken);
    end = close ? close.end : this.peek().end;
    return { members, end };
  }

  private parseTypeMember(): RawNode | undefined {
    const start = this.peek().start;
    const modifiers: RawModifier[] = [];

    if (
      this.peek().kind === SyntaxKind.ReadonlyKeyword &&
      this.peek(1).kind !== SyntaxKind.ColonToken &&
      this.peek(1).kind !== SyntaxKind.QuestionToken &&
      this.peek(1).kind !== SyntaxKind.OpenParenToken
    ) {
      const m = this.advance();
      modifiers.push({ kind: m.kind, start: m.start, end: m.end, text: m.text });
    }

    // Call signature `(x: number): string` or `<T>(x: T): T`
    if (
      this.peek().kind === SyntaxKind.OpenParenToken ||
      this.peek().kind === SyntaxKind.LessThanToken
    ) {
      if (this.peek().kind === SyntaxKind.LessThanToken) {
        this.skipTypeParameters();
      }
      const params = this.parseParameterList();
      let ret: RawNode | undefined;
      let end = this.tokens[this.pos - 1]?.end ?? start;
      if (this.match(SyntaxKind.ColonToken)) {
        ret = this.parseType();
        end = ret.end;
      }
      const sep =
        this.match(SyntaxKind.SemicolonToken) ?? this.match(SyntaxKind.CommaToken);
      if (sep) end = sep.end;
      return {
        kind: SyntaxKind.CallSignature,
        start,
        end,
        children: [...params, ...(ret ? [ret] : [])],
      };
    }

    // Construct signature `new (...) : T`
    if (
      this.peek().kind === SyntaxKind.NewKeyword &&
      (this.peek(1).kind === SyntaxKind.OpenParenToken ||
        this.peek(1).kind === SyntaxKind.LessThanToken)
    ) {
      this.advance();
      if (this.peek().kind === SyntaxKind.LessThanToken) {
        this.skipTypeParameters();
      }
      const params = this.parseParameterList();
      let ret: RawNode | undefined;
      let end = this.tokens[this.pos - 1]?.end ?? start;
      if (this.match(SyntaxKind.ColonToken)) {
        ret = this.parseType();
        end = ret.end;
      }
      const sep =
        this.match(SyntaxKind.SemicolonToken) ?? this.match(SyntaxKind.CommaToken);
      if (sep) end = sep.end;
      return {
        kind: SyntaxKind.ConstructSignature,
        start,
        end,
        children: [...params, ...(ret ? [ret] : [])],
      };
    }

    // Index signature `[k: string]: T` or mapped type `[K in keyof T]: T[K]`
    if (
      this.peek().kind === SyntaxKind.OpenBracketToken &&
      isWordToken(this.peek(1).kind) &&
      (this.peek(2).kind === SyntaxKind.ColonToken ||
        this.peek(2).kind === SyntaxKind.InKeyword)
    ) {
      return this.parseIndexSignature(start);
    }

    // Optional `get` / `set` accessor in type literal
    if (
      (this.peek().kind === SyntaxKind.GetKeyword ||
        this.peek().kind === SyntaxKind.SetKeyword) &&
      isWordToken(this.peek(1).kind) &&
      this.peek(2).kind === SyntaxKind.OpenParenToken
    ) {
      this.advance();
    }

    const name = this.parseMemberName();
    const questionToken = Boolean(this.match(SyntaxKind.QuestionToken));

    if (
      this.peek().kind === SyntaxKind.OpenParenToken ||
      this.peek().kind === SyntaxKind.LessThanToken
    ) {
      if (this.peek().kind === SyntaxKind.LessThanToken) {
        this.skipTypeParameters();
      }
      const parameters = this.parseParameterList();
      let returnType: RawNode | undefined;
      let end = this.tokens[this.pos - 1]?.end ?? name.end;
      if (this.match(SyntaxKind.ColonToken)) {
        returnType = this.parseType();
        end = returnType.end;
      }
      const sep =
        this.match(SyntaxKind.SemicolonToken) ?? this.match(SyntaxKind.CommaToken);
      if (sep) end = sep.end;
      return {
        kind: SyntaxKind.MethodSignature,
        start,
        end,
        name,
        questionToken,
        parameters,
        returnType,
      } as RawMethodSignature;
    }

    let typeNode: RawNode | undefined;
    let end = this.tokens[this.pos - 1]?.end ?? name.end;
    if (this.match(SyntaxKind.ColonToken)) {
      typeNode = this.parseType();
      end = typeNode.end;
    }
    const sep =
      this.match(SyntaxKind.SemicolonToken) ?? this.match(SyntaxKind.CommaToken);
    if (sep) end = sep.end;

    return {
      kind: SyntaxKind.PropertySignature,
      start,
      end,
      modifiers,
      name,
      questionToken,
      typeNode,
    } as RawPropertySignature;
  }

  private parseTypeAliasDeclaration(
    modifiers: RawModifier[],
  ): RawTypeAliasDeclaration {
    const kw = this.advance(); // type
    const start = modifiers[0]?.start ?? kw.start;
    const name = this.makeIdent(this.advance());
    if (this.peek().kind === SyntaxKind.LessThanToken) {
      this.skipTypeParameters();
    }
    this.match(SyntaxKind.EqualsToken);
    const typeNode = this.parseType();
    const semi = this.match(SyntaxKind.SemicolonToken);
    return {
      kind: SyntaxKind.TypeAliasDeclaration,
      start,
      end: semi ? semi.end : typeNode.end,
      modifiers,
      name,
      typeNode,
    };
  }

  private parseEnumDeclaration(modifiers: RawModifier[]): RawEnumDeclaration {
    const start = modifiers[0]?.start ?? this.peek().start;
    if (this.peek().kind === SyntaxKind.ConstKeyword) {
      const m = this.advance();
      modifiers.push({ kind: m.kind, start: m.start, end: m.end, text: m.text });
    }
    this.match(SyntaxKind.EnumKeyword);
    const name = this.makeIdent(this.advance());
    const members: RawEnumMember[] = [];
    let end = name.end;
    if (this.match(SyntaxKind.OpenBraceToken)) {
      while (!this.atEnd() && this.peek().kind !== SyntaxKind.CloseBraceToken) {
        const mName = this.parseMemberName();
        let init: RawNode | undefined;
        let mEnd = mName.end;
        if (this.match(SyntaxKind.EqualsToken)) {
          init = this.parseAssignmentExpression();
          mEnd = init.end;
        }
        members.push({
          kind: SyntaxKind.EnumMember,
          start: mName.start,
          end: mEnd,
          name: mName,
          initializer: init,
        });
        if (!this.match(SyntaxKind.CommaToken)) break;
      }
      const close = this.match(SyntaxKind.CloseBraceToken);
      if (close) end = close.end;
    }
    return {
      kind: SyntaxKind.EnumDeclaration,
      start,
      end,
      modifiers,
      name,
      members,
    };
  }

  private parseFunctionDeclaration(
    modifiers: RawModifier[],
  ): RawFunctionDeclaration {
    const kw = this.advance(); // function
    const start = modifiers[0]?.start ?? kw.start;
    this.match(SyntaxKind.AsteriskToken);
    let name: RawIdentifier | undefined;
    if (isWordToken(this.peek().kind)) {
      name = this.makeIdent(this.advance());
    }
    if (this.peek().kind === SyntaxKind.LessThanToken) {
      this.skipTypeParameters();
    }
    const parameters = this.parseParameterList();
    let end = this.tokens[this.pos - 1]?.end ?? kw.end;
    let returnType: RawNode | undefined;
    if (this.match(SyntaxKind.ColonToken)) {
      returnType = this.parseType();
      end = returnType.end;
    }
    let body: RawNode | undefined;
    if (this.peek().kind === SyntaxKind.OpenBraceToken) {
      body = this.parseBlock();
      end = body.end;
    } else {
      const semi = this.match(SyntaxKind.SemicolonToken);
      if (semi) end = semi.end;
    }
    return {
      kind: SyntaxKind.FunctionDeclaration,
      start,
      end,
      modifiers,
      name,
      parameters,
      returnType,
      body,
    };
  }

  private parseVariableStatement(
    modifiers: RawModifier[],
  ): RawVariableStatement {
    const kw = this.advance(); // const | let | var
    const start = modifiers[0]?.start ?? kw.start;
    const declarations: RawVariableDeclaration[] = [];

    do {
      const name = this.parseBindingPattern();
      this.match(SyntaxKind.ExclamationToken);
      let end = name.end;
      let typeNode: RawNode | undefined;
      if (this.match(SyntaxKind.ColonToken)) {
        typeNode = this.parseType();
        end = typeNode.end;
      }
      let initializer: RawNode | undefined;
      if (this.match(SyntaxKind.EqualsToken)) {
        initializer = this.parseAssignmentExpression();
        end = initializer.end;
      }
      declarations.push({
        kind: SyntaxKind.VariableDeclaration,
        start: name.start,
        end,
        name,
        typeNode,
        initializer,
      });
    } while (this.match(SyntaxKind.CommaToken));

    const semi = this.match(SyntaxKind.SemicolonToken);
    const lastEnd = declarations[declarations.length - 1]?.end ?? kw.end;
    return {
      kind: SyntaxKind.VariableStatement,
      start,
      end: semi ? semi.end : lastEnd,
      modifiers,
      keyword: kw.kind,
      declarations,
    };
  }

  private parseModuleDeclaration(modifiers: RawModifier[]): RawNode {
    const kw = this.advance(); // namespace | module | global
    const start = modifiers[0]?.start ?? kw.start;
    while (
      !this.atEnd() &&
      this.peek().kind !== SyntaxKind.OpenBraceToken &&
      this.peek().kind !== SyntaxKind.SemicolonToken
    ) {
      this.advance();
    }
    let body: RawNode | undefined;
    let end = this.tokens[this.pos - 1]?.end ?? kw.end;
    if (this.peek().kind === SyntaxKind.OpenBraceToken) {
      body = this.parseBlock();
      end = body.end;
    } else {
      const semi = this.match(SyntaxKind.SemicolonToken);
      if (semi) end = semi.end;
    }
    return {
      kind: SyntaxKind.ModuleDeclaration,
      start,
      end,
      children: body ? [body] : [],
    };
  }

  // ─── Blocks & Control Flow ───────────────────────────────────────────────

  private parseBlock(): RawBlock {
    const open = this.advance(); // {
    const statements: RawNode[] = [];
    while (!this.atEnd() && this.peek().kind !== SyntaxKind.CloseBraceToken) {
      const prevPos = this.pos;
      const prevPending = this.pending;
      const stmt = this.parseStatement();
      if (stmt) statements.push(stmt);
      if (this.pos === prevPos && this.pending === prevPending) {
        this.advance();
      }
    }
    const close = this.match(SyntaxKind.CloseBraceToken);
    return {
      kind: SyntaxKind.Block,
      start: open.start,
      end: close ? close.end : this.peek().end,
      statements,
    };
  }

  private parseReturnStatement(): RawReturnStatement {
    const kw = this.advance(); // return
    let expression: RawNode | undefined;
    if (
      !this.atEnd() &&
      !this.peek().lineBreakBefore &&
      this.peek().kind !== SyntaxKind.SemicolonToken &&
      this.peek().kind !== SyntaxKind.CloseBraceToken
    ) {
      expression = this.parseExpression();
    }
    const semi = this.match(SyntaxKind.SemicolonToken);
    return {
      kind: SyntaxKind.ReturnStatement,
      start: kw.start,
      end: semi ? semi.end : expression?.end ?? kw.end,
      expression,
    };
  }

  private parseParenExpressionOrEmpty(): RawNode | undefined {
    if (!this.match(SyntaxKind.OpenParenToken)) return undefined;
    const expr =
      this.peek().kind !== SyntaxKind.CloseParenToken
        ? this.parseExpression()
        : undefined;
    this.match(SyntaxKind.CloseParenToken);
    return expr;
  }

  private parseIfStatement(): RawNode {
    const kw = this.advance();
    const cond = this.parseParenExpressionOrEmpty();
    const thenBranch = this.parseStatement();
    let elseBranch: RawNode | undefined;
    if (this.match(SyntaxKind.ElseKeyword)) {
      elseBranch = this.parseStatement();
    }
    const end = elseBranch?.end ?? thenBranch?.end ?? cond?.end ?? kw.end;
    return {
      kind: SyntaxKind.IfStatement,
      start: kw.start,
      end,
      children: [cond, thenBranch, elseBranch].filter((x): x is RawNode =>
        Boolean(x),
      ),
    };
  }

  private parseForStatement(): RawNode {
    const kw = this.advance();
    this.match(SyntaxKind.AwaitKeyword);
    const children: RawNode[] = [];
    if (this.match(SyntaxKind.OpenParenToken)) {
      while (!this.atEnd() && this.peek().kind !== SyntaxKind.CloseParenToken) {
        const prevPos = this.pos;
        if (
          this.peek().kind === SyntaxKind.ConstKeyword ||
          this.peek().kind === SyntaxKind.LetKeyword ||
          this.peek().kind === SyntaxKind.VarKeyword
        ) {
          this.advance();
          const binding = this.parseBindingPattern();
          if (this.match(SyntaxKind.ColonToken)) {
            this.parseType();
          }
          if (this.match(SyntaxKind.EqualsToken)) {
            children.push(this.parseAssignmentExpression());
          }
          while (this.match(SyntaxKind.CommaToken)) {
            this.parseBindingPattern();
            if (this.match(SyntaxKind.EqualsToken)) {
              children.push(this.parseAssignmentExpression());
            }
          }
          if (
            this.match(SyntaxKind.InKeyword) ||
            this.match(SyntaxKind.OfKeyword)
          ) {
            children.push(this.parseExpression());
            break;
          }
          void binding;
          this.match(SyntaxKind.SemicolonToken);
          continue;
        }
        if (this.match(SyntaxKind.SemicolonToken)) continue;
        children.push(this.parseExpression());
        if (
          this.match(SyntaxKind.InKeyword) ||
          this.match(SyntaxKind.OfKeyword)
        ) {
          children.push(this.parseExpression());
          break;
        }
        this.match(SyntaxKind.SemicolonToken);
        if (this.pos === prevPos) this.advance();
      }
      this.match(SyntaxKind.CloseParenToken);
    }
    const body = this.parseStatement();
    if (body) children.push(body);
    return {
      kind: SyntaxKind.ForStatement,
      start: kw.start,
      end: body?.end ?? this.tokens[this.pos - 1]?.end ?? kw.end,
      children,
    };
  }

  private parseWhileStatement(): RawNode {
    const kw = this.advance();
    const cond = this.parseParenExpressionOrEmpty();
    const body = this.parseStatement();
    return {
      kind: SyntaxKind.WhileStatement,
      start: kw.start,
      end: body?.end ?? cond?.end ?? kw.end,
      children: [cond, body].filter((x): x is RawNode => Boolean(x)),
    };
  }

  private parseTryStatement(): RawNode {
    const kw = this.advance();
    const children: RawNode[] = [];
    if (this.peek().kind === SyntaxKind.OpenBraceToken) {
      children.push(this.parseBlock());
    }
    if (this.match(SyntaxKind.CatchKeyword)) {
      if (this.match(SyntaxKind.OpenParenToken)) {
        if (this.peek().kind !== SyntaxKind.CloseParenToken) {
          this.parseBindingPattern();
          if (this.match(SyntaxKind.ColonToken)) this.parseType();
        }
        this.match(SyntaxKind.CloseParenToken);
      }
      if (this.peek().kind === SyntaxKind.OpenBraceToken) {
        children.push(this.parseBlock());
      }
    }
    if (this.match(SyntaxKind.FinallyKeyword)) {
      if (this.peek().kind === SyntaxKind.OpenBraceToken) {
        children.push(this.parseBlock());
      }
    }
    return {
      kind: SyntaxKind.TryStatement,
      start: kw.start,
      end: children[children.length - 1]?.end ?? kw.end,
      children,
    };
  }

  private parseSwitchStatement(): RawNode {
    const kw = this.advance();
    const children: RawNode[] = [];
    const disc = this.parseParenExpressionOrEmpty();
    if (disc) children.push(disc);
    let end = disc?.end ?? kw.end;
    if (this.match(SyntaxKind.OpenBraceToken)) {
      while (!this.atEnd() && this.peek().kind !== SyntaxKind.CloseBraceToken) {
        const prevPos = this.pos;
        if (this.match(SyntaxKind.CaseKeyword)) {
          children.push(this.parseExpression());
          this.match(SyntaxKind.ColonToken);
        } else if (this.match(SyntaxKind.DefaultKeyword)) {
          this.match(SyntaxKind.ColonToken);
        } else {
          const stmt = this.parseStatement();
          if (stmt) children.push(stmt);
        }
        if (this.pos === prevPos) this.advance();
      }
      const close = this.match(SyntaxKind.CloseBraceToken);
      if (close) end = close.end;
    }
    return {
      kind: SyntaxKind.SwitchStatement,
      start: kw.start,
      end,
      children,
    };
  }

  // ─── Expressions ─────────────────────────────────────────────────────────

  private parseExpression(): RawNode {
    let expr = this.parseAssignmentExpression();
    while (this.match(SyntaxKind.CommaToken)) {
      const right = this.parseAssignmentExpression();
      expr = {
        kind: SyntaxKind.BinaryExpression,
        start: expr.start,
        end: right.end,
        children: [expr, right],
      };
    }
    return expr;
  }

  private parseAssignmentExpression(): RawNode {
    if (this.peek().kind === SyntaxKind.YieldKeyword) {
      const kw = this.advance();
      this.match(SyntaxKind.AsteriskToken);
      let expr: RawNode | undefined;
      if (
        !this.atEnd() &&
        !this.peek().lineBreakBefore &&
        this.peek().kind !== SyntaxKind.SemicolonToken &&
        this.peek().kind !== SyntaxKind.CloseBraceToken &&
        this.peek().kind !== SyntaxKind.CloseParenToken &&
        this.peek().kind !== SyntaxKind.CommaToken
      ) {
        expr = this.parseAssignmentExpression();
      }
      return {
        kind: SyntaxKind.YieldExpression,
        start: kw.start,
        end: expr?.end ?? kw.end,
        children: expr ? [expr] : [],
      };
    }

    // Speculative arrow function check (`(...) =>`, `async (...) =>`, `x =>`, `async x =>`, `<T>(...) =>`)
    const arrow = this.tryParseArrowFunction();
    if (arrow) return arrow;

    const left = this.parseConditionalExpression();
    const op = this.peek().kind;
    if (
      op === SyntaxKind.EqualsToken ||
      op === SyntaxKind.CompoundAssignmentToken
    ) {
      this.advance();
      const right = this.parseAssignmentExpression();
      return {
        kind: SyntaxKind.BinaryExpression,
        start: left.start,
        end: right.end,
        children: [left, right],
      };
    }
    return left;
  }

  private tryParseArrowFunction(): RawArrowFunction | undefined {
    const tok = this.peek();
    const saved = this.save();

    let isAsync = false;
    let start = tok.start;
    if (
      tok.kind === SyntaxKind.AsyncKeyword &&
      !this.peek(1).lineBreakBefore &&
      (this.peek(1).kind === SyntaxKind.OpenParenToken ||
        this.peek(1).kind === SyntaxKind.LessThanToken ||
        isContextualIdentifier(this.peek(1).kind))
    ) {
      isAsync = true;
      this.advance();
    }

    // Single-identifier arrow: `x => ...`
    if (
      isContextualIdentifier(this.peek().kind) &&
      this.peek(1).kind === SyntaxKind.EqualsGreaterThanToken &&
      !this.peek(1).lineBreakBefore
    ) {
      const idTok = this.advance();
      this.advance(); // =>
      const param: RawParameter = {
        kind: SyntaxKind.Parameter,
        start: idTok.start,
        end: idTok.end,
        decorators: [],
        modifiers: [],
        isRest: false,
        name: this.makeIdent(idTok),
        questionToken: false,
      };
      const body =
        this.peek().kind === SyntaxKind.OpenBraceToken
          ? this.parseBlock()
          : this.parseAssignmentExpression();
      return {
        kind: SyntaxKind.ArrowFunction,
        start,
        end: body.end,
        isAsync,
        parameters: [param],
        body,
      };
    }

    // Generic / parenthesized arrow: `<T>(...) : Ret => ...` or `(...) => ...`
    if (
      this.peek().kind === SyntaxKind.LessThanToken ||
      this.peek().kind === SyntaxKind.OpenParenToken
    ) {
      if (this.peek().kind === SyntaxKind.LessThanToken) {
        if (!this.trySkipTypeParameters()) {
          this.restore(saved);
          return undefined;
        }
      }
      if (this.peek().kind !== SyntaxKind.OpenParenToken) {
        this.restore(saved);
        return undefined;
      }
      // Quick bailout: verify matching `)` is followed by `=>` or `:` before full param parse
      const parameters = this.parseParameterList();
      let returnType: RawNode | undefined;
      if (this.match(SyntaxKind.ColonToken)) {
        returnType = this.parseType();
      }
      if (
        this.peek().kind === SyntaxKind.EqualsGreaterThanToken &&
        !this.peek().lineBreakBefore
      ) {
        this.advance(); // =>
        const body =
          this.peek().kind === SyntaxKind.OpenBraceToken
            ? this.parseBlock()
            : this.parseAssignmentExpression();
        return {
          kind: SyntaxKind.ArrowFunction,
          start,
          end: body.end,
          isAsync,
          parameters,
          returnType,
          body,
        };
      }
    }

    this.restore(saved);
    return undefined;
  }

  private parseConditionalExpression(): RawNode {
    const cond = this.parseBinaryExpression(1);
    if (this.match(SyntaxKind.QuestionToken)) {
      const whenTrue = this.parseAssignmentExpression();
      this.match(SyntaxKind.ColonToken);
      const whenFalse = this.parseAssignmentExpression();
      return {
        kind: SyntaxKind.ConditionalExpression,
        start: cond.start,
        end: whenFalse.end,
        children: [cond, whenTrue, whenFalse],
      };
    }
    return cond;
  }

  private parseBinaryExpression(minPrec: number): RawNode {
    let left = this.parseUnaryExpression();

    while (!this.atEnd()) {
      const tok = this.peek();

      // `expr as Type` / `expr satisfies Type` (higher precedence than relational)
      if (
        !tok.lineBreakBefore &&
        (tok.kind === SyntaxKind.AsKeyword ||
          tok.kind === SyntaxKind.SatisfiesKeyword)
      ) {
        this.advance();
        const typeNode = this.parseType();
        left = {
          kind:
            tok.kind === SyntaxKind.AsKeyword
              ? SyntaxKind.AsExpression
              : SyntaxKind.SatisfiesExpression,
          start: left.start,
          end: typeNode.end,
          expression: left,
          typeNode,
        } as RawAsExpression;
        continue;
      }

      const prec = getBinaryPrecedence(tok.kind);
      if (prec < minPrec) break;

      this.advance();
      const nextMin =
        tok.kind === SyntaxKind.AsteriskAsteriskToken ? prec : prec + 1;
      const right = this.parseBinaryExpression(nextMin);
      left = {
        kind: SyntaxKind.BinaryExpression,
        start: left.start,
        end: right.end,
        text: tok.text,
        children: [left, right],
      };
    }

    return left;
  }

  private parseUnaryExpression(): RawNode {
    const tok = this.peek();
    switch (tok.kind) {
      case SyntaxKind.AwaitKeyword: {
        this.advance();
        const operand = this.parseUnaryExpression();
        return {
          kind: SyntaxKind.AwaitExpression,
          start: tok.start,
          end: operand.end,
          children: [operand],
        };
      }
      case SyntaxKind.TypeOfKeyword: {
        this.advance();
        const operand = this.parseUnaryExpression();
        return {
          kind: SyntaxKind.TypeOfExpression,
          start: tok.start,
          end: operand.end,
          children: [operand],
        };
      }
      case SyntaxKind.VoidKeyword: {
        this.advance();
        const operand = this.parseUnaryExpression();
        return {
          kind: SyntaxKind.VoidExpression,
          start: tok.start,
          end: operand.end,
          children: [operand],
        };
      }
      case SyntaxKind.DeleteKeyword: {
        this.advance();
        const operand = this.parseUnaryExpression();
        return {
          kind: SyntaxKind.DeleteExpression,
          start: tok.start,
          end: operand.end,
          children: [operand],
        };
      }
      case SyntaxKind.PlusToken:
      case SyntaxKind.MinusToken:
      case SyntaxKind.TildeToken:
      case SyntaxKind.ExclamationToken:
      case SyntaxKind.PlusPlusToken:
      case SyntaxKind.MinusMinusToken: {
        this.advance();
        const operand = this.parseUnaryExpression();
        return {
          kind: SyntaxKind.PrefixUnaryExpression,
          start: tok.start,
          end: operand.end,
          text: tok.text,
          children: [operand],
        };
      }
      default:
        return this.parsePostfixExpression();
    }
  }

  private parsePostfixExpression(): RawNode {
    let expr = this.parseLeftHandSideExpression();
    while (!this.atEnd() && !this.peek().lineBreakBefore) {
      const k = this.peek().kind;
      if (k === SyntaxKind.PlusPlusToken || k === SyntaxKind.MinusMinusToken) {
        const op = this.advance();
        expr = {
          kind: SyntaxKind.PostfixUnaryExpression,
          start: expr.start,
          end: op.end,
          text: op.text,
          children: [expr],
        };
      } else if (k === SyntaxKind.ExclamationToken) {
        const op = this.advance();
        expr = {
          kind: SyntaxKind.NonNullExpression,
          start: expr.start,
          end: op.end,
          children: [expr],
        };
      } else {
        break;
      }
    }
    return expr;
  }

  private parseLeftHandSideExpression(): RawNode {
    let expr: RawNode;
    if (this.peek().kind === SyntaxKind.NewKeyword) {
      expr = this.parseNewExpression();
    } else {
      expr = this.parsePrimaryExpression();
    }

    return this.parseMemberAndCallSuffixes(expr, true);
  }

  private parseNewExpression(): RawNode {
    const kw = this.advance(); // new
    // `new.target`
    if (this.peek().kind === SyntaxKind.DotToken) {
      this.advance();
      const prop = this.makeIdent(this.advance());
      return {
        kind: SyntaxKind.PropertyAccessExpression,
        start: kw.start,
        end: prop.end,
        expression: this.makeIdent(kw),
        name: prop,
      } as RawPropertyAccessExpression;
    }

    let callee: RawNode;
    if (this.peek().kind === SyntaxKind.NewKeyword) {
      callee = this.parseNewExpression();
    } else {
      callee = this.parseMemberAndCallSuffixes(
        this.parsePrimaryExpression(),
        false,
      );
    }

    let typeArguments: RawNode[] = [];
    let end = callee.end;
    if (this.peek().kind === SyntaxKind.LessThanToken) {
      const saved = this.save();
      const parsed = this.tryParseTypeArguments();
      if (parsed && this.peek().kind === SyntaxKind.OpenParenToken) {
        typeArguments = parsed;
      } else {
        this.restore(saved);
      }
    }

    let args: RawNode[] = [];
    if (this.peek().kind === SyntaxKind.OpenParenToken) {
      const res = this.parseCallArguments();
      args = res.args;
      end = res.end;
    }

    return {
      kind: SyntaxKind.NewExpression,
      start: kw.start,
      end,
      expression: callee,
      typeArguments,
      arguments: args,
    } as RawNewExpression;
  }

  private parseMemberAndCallSuffixes(
    base: RawNode,
    allowCall: boolean,
  ): RawNode {
    let expr = base;
    while (!this.atEnd()) {
      const tok = this.peek();

      // `.prop` or `?.prop`
      if (
        tok.kind === SyntaxKind.DotToken ||
        (tok.kind === SyntaxKind.QuestionDotToken &&
          this.peek(1).kind !== SyntaxKind.OpenParenToken &&
          this.peek(1).kind !== SyntaxKind.OpenBracketToken &&
          this.peek(1).kind !== SyntaxKind.LessThanToken)
      ) {
        this.advance();
        if (isWordToken(this.peek().kind)) {
          const name = this.makeIdent(this.advance());
          expr = {
            kind: SyntaxKind.PropertyAccessExpression,
            start: expr.start,
            end: name.end,
            expression: expr,
            name,
          } as RawPropertyAccessExpression;
          continue;
        }
        break;
      }

      // `?.[` or `[`
      if (
        tok.kind === SyntaxKind.OpenBracketToken ||
        (tok.kind === SyntaxKind.QuestionDotToken &&
          this.peek(1).kind === SyntaxKind.OpenBracketToken)
      ) {
        if (tok.kind === SyntaxKind.QuestionDotToken) this.advance();
        this.advance(); // [
        const indexExpr = this.parseExpression();
        const close = this.match(SyntaxKind.CloseBracketToken);
        expr = {
          kind: SyntaxKind.ElementAccessExpression,
          start: expr.start,
          end: close ? close.end : indexExpr.end,
          expression: expr,
          argumentExpression: indexExpr,
        } as RawElementAccessExpression;
        continue;
      }

      // `?.(` or `(`
      if (
        allowCall &&
        (tok.kind === SyntaxKind.OpenParenToken ||
          (tok.kind === SyntaxKind.QuestionDotToken &&
            this.peek(1).kind === SyntaxKind.OpenParenToken))
      ) {
        if (tok.kind === SyntaxKind.QuestionDotToken) this.advance();
        const { args, end } = this.parseCallArguments();
        expr = {
          kind: SyntaxKind.CallExpression,
          start: expr.start,
          end,
          expression: expr,
          typeArguments: [],
          arguments: args,
        } as RawCallExpression;
        continue;
      }

      // Generic call `foo<T>(args)` or `foo?.<T>(args)`
      if (
        allowCall &&
        (tok.kind === SyntaxKind.LessThanToken ||
          (tok.kind === SyntaxKind.QuestionDotToken &&
            this.peek(1).kind === SyntaxKind.LessThanToken))
      ) {
        const saved = this.save();
        if (tok.kind === SyntaxKind.QuestionDotToken) this.advance();
        const typeArgs = this.tryParseTypeArguments();
        if (
          typeArgs &&
          (this.peek().kind === SyntaxKind.OpenParenToken ||
            this.peek().kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
            this.peek().kind === SyntaxKind.TemplateHead)
        ) {
          if (this.peek().kind === SyntaxKind.OpenParenToken) {
            const { args, end } = this.parseCallArguments();
            expr = {
              kind: SyntaxKind.CallExpression,
              start: expr.start,
              end,
              expression: expr,
              typeArguments: typeArgs,
              arguments: args,
            } as RawCallExpression;
          } else {
            const tmpl = this.parseTemplateExpression();
            expr = {
              kind: SyntaxKind.TaggedTemplateExpression,
              start: expr.start,
              end: tmpl.end,
              children: [expr, tmpl],
            };
          }
          continue;
        }
        this.restore(saved);
        break;
      }

      // Tagged template literal `` tag`...` ``
      if (
        allowCall &&
        !tok.lineBreakBefore &&
        (tok.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
          tok.kind === SyntaxKind.TemplateHead)
      ) {
        const tmpl = this.parseTemplateExpression();
        expr = {
          kind: SyntaxKind.TaggedTemplateExpression,
          start: expr.start,
          end: tmpl.end,
          children: [expr, tmpl],
        };
        continue;
      }

      break;
    }
    return expr;
  }

  private parseCallArguments(): { args: RawNode[]; end: number } {
    this.match(SyntaxKind.OpenParenToken);
    const args: RawNode[] = [];
    while (!this.atEnd() && this.peek().kind !== SyntaxKind.CloseParenToken) {
      const prevPos = this.pos;
      if (this.peek().kind === SyntaxKind.DotDotDotToken) {
        const spreadTok = this.advance();
        const inner = this.parseAssignmentExpression();
        args.push({
          kind: SyntaxKind.SpreadElement,
          start: spreadTok.start,
          end: inner.end,
          children: [inner],
        });
      } else {
        args.push(this.parseAssignmentExpression());
      }
      if (!this.match(SyntaxKind.CommaToken)) break;
      if (this.pos === prevPos) this.advance();
    }
    const close = this.match(SyntaxKind.CloseParenToken);
    const end = close
      ? close.end
      : args[args.length - 1]?.end ?? this.peek().start;
    return { args, end };
  }

  private parsePrimaryExpression(): RawNode {
    const tok = this.peek();

    switch (tok.kind) {
      case SyntaxKind.StringLiteral:
        return this.parseStringLiteral();
      case SyntaxKind.NoSubstitutionTemplateLiteral: {
        this.advance();
        return {
          kind: SyntaxKind.NoSubstitutionTemplateLiteral,
          start: tok.start,
          end: tok.end,
          text: tok.text,
          value: String(tok.value ?? ""),
        } as RawStringLiteral;
      }
      case SyntaxKind.TemplateHead:
        return this.parseTemplateExpression();
      case SyntaxKind.NumericLiteral:
        return this.parseNumericLiteral();
      case SyntaxKind.BigIntLiteral:
      case SyntaxKind.RegularExpressionLiteral:
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
      case SyntaxKind.NullKeyword:
      case SyntaxKind.UndefinedKeyword:
      case SyntaxKind.ThisKeyword:
      case SyntaxKind.SuperKeyword: {
        this.advance();
        return {
          kind: tok.kind,
          start: tok.start,
          end: tok.end,
          text: tok.text,
          value: tok.value,
        };
      }
      case SyntaxKind.OpenParenToken: {
        const open = this.advance();
        const inner = this.parseExpression();
        const close = this.match(SyntaxKind.CloseParenToken);
        return {
          kind: SyntaxKind.ParenthesizedExpression,
          start: open.start,
          end: close ? close.end : inner.end,
          expression: inner,
        } as RawParenthesizedExpression;
      }
      case SyntaxKind.OpenBracketToken:
        return this.parseArrayLiteral();
      case SyntaxKind.OpenBraceToken:
        return this.parseObjectLiteral();
      case SyntaxKind.FunctionKeyword:
        return this.parseFunctionExpression(false);
      case SyntaxKind.AsyncKeyword: {
        if (
          this.peek(1).kind === SyntaxKind.FunctionKeyword &&
          !this.peek(1).lineBreakBefore
        ) {
          this.advance();
          return this.parseFunctionExpression(true);
        }
        return this.makeIdent(this.advance());
      }
      case SyntaxKind.ClassKeyword:
        return this.parseClassDeclaration([], [], true);
      case SyntaxKind.ImportKeyword: {
        // Dynamic `import(...)` or `import.meta`
        return this.makeIdent(this.advance());
      }
      case SyntaxKind.LessThanToken: {
        // Either JSX element (`<Tag>...</Tag>` / `<>...</>`) or legacy `<Type>expr` assertion
        if (this.isTsx || this.peek(1).kind === SyntaxKind.GreaterThanToken) {
          return this.parseJsxElement();
        }
        const saved = this.save();
        this.advance(); // <
        const typeNode = this.parseType();
        if (this.consumeGreaterThan()) {
          const expr = this.parseUnaryExpression();
          return {
            kind: SyntaxKind.TypeAssertionExpression,
            start: tok.start,
            end: expr.end,
            children: [typeNode, expr],
          };
        }
        this.restore(saved);
        return this.parseJsxElement();
      }
      default: {
        if (isWordToken(tok.kind)) {
          return this.makeIdent(this.advance());
        }
        // Recovery
        this.advance();
        return {
          kind: tok.kind,
          start: tok.start,
          end: tok.end,
          text: tok.text,
        };
      }
    }
  }

  private parseStringLiteral(): RawStringLiteral {
    const tok = this.advance();
    return {
      kind: SyntaxKind.StringLiteral,
      start: tok.start,
      end: tok.end,
      text: tok.text,
      value: String(tok.value ?? ""),
    };
  }

  private parseNumericLiteral(): RawNumericLiteral {
    const tok = this.advance();
    return {
      kind: SyntaxKind.NumericLiteral,
      start: tok.start,
      end: tok.end,
      text: tok.text,
      value: Number(tok.value ?? 0),
    };
  }

  private parseTemplateExpression(): RawNode {
    const head = this.advance();
    if (head.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
      return {
        kind: SyntaxKind.NoSubstitutionTemplateLiteral,
        start: head.start,
        end: head.end,
        text: head.text,
        value: String(head.value ?? ""),
      } as RawStringLiteral;
    }
    const children: RawNode[] = [];
    let end = head.end;
    while (!this.atEnd()) {
      const expr = this.parseExpression();
      children.push(expr);
      end = expr.end;
      const next = this.peek();
      if (next.kind === SyntaxKind.TemplateTail) {
        end = this.advance().end;
        break;
      }
      if (next.kind === SyntaxKind.TemplateMiddle) {
        end = this.advance().end;
        continue;
      }
      break;
    }
    return {
      kind: SyntaxKind.TemplateExpression,
      start: head.start,
      end,
      children,
    };
  }

  private parseArrayLiteral(): RawArrayLiteralExpression {
    const open = this.advance(); // [
    const elements: RawNode[] = [];
    while (!this.atEnd() && this.peek().kind !== SyntaxKind.CloseBracketToken) {
      if (this.match(SyntaxKind.CommaToken)) {
        // Elision
        continue;
      }
      const prevPos = this.pos;
      if (this.peek().kind === SyntaxKind.DotDotDotToken) {
        const spreadTok = this.advance();
        const inner = this.parseAssignmentExpression();
        elements.push({
          kind: SyntaxKind.SpreadElement,
          start: spreadTok.start,
          end: inner.end,
          children: [inner],
        });
      } else {
        elements.push(this.parseAssignmentExpression());
      }
      if (!this.match(SyntaxKind.CommaToken)) break;
      if (this.pos === prevPos) this.advance();
    }
    const close = this.match(SyntaxKind.CloseBracketToken);
    return {
      kind: SyntaxKind.ArrayLiteralExpression,
      start: open.start,
      end: close ? close.end : this.peek().end,
      elements,
    };
  }

  private parseObjectLiteral(): RawObjectLiteralExpression {
    const open = this.advance(); // {
    const properties: RawNode[] = [];

    while (!this.atEnd() && this.peek().kind !== SyntaxKind.CloseBraceToken) {
      const prevPos = this.pos;

      // Spread `{ ...other }`
      if (this.peek().kind === SyntaxKind.DotDotDotToken) {
        const sp = this.advance();
        const inner = this.parseAssignmentExpression();
        properties.push({
          kind: SyntaxKind.SpreadAssignment,
          start: sp.start,
          end: inner.end,
          children: [inner],
        });
        if (!this.match(SyntaxKind.CommaToken)) break;
        continue;
      }

      const propStart = this.peek().start;

      // Method / accessor modifiers inside object literal (`async m() {}`, `get x() {}`, `set x(v) {}`, `*gen() {}`)
      let isAsyncOrAcc = false;
      if (
        (this.peek().kind === SyntaxKind.AsyncKeyword ||
          this.peek().kind === SyntaxKind.GetKeyword ||
          this.peek().kind === SyntaxKind.SetKeyword) &&
        this.peek(1).kind !== SyntaxKind.ColonToken &&
        this.peek(1).kind !== SyntaxKind.CommaToken &&
        this.peek(1).kind !== SyntaxKind.CloseBraceToken &&
        this.peek(1).kind !== SyntaxKind.OpenParenToken &&
        this.peek(1).kind !== SyntaxKind.EqualsToken
      ) {
        isAsyncOrAcc = true;
        this.advance();
      }
      if (this.match(SyntaxKind.AsteriskToken)) {
        isAsyncOrAcc = true;
      }

      const name = this.parseMemberName();

      // Method in object literal: `foo(a, b) { ... }`
      if (
        this.peek().kind === SyntaxKind.OpenParenToken ||
        this.peek().kind === SyntaxKind.LessThanToken ||
        isAsyncOrAcc
      ) {
        if (this.peek().kind === SyntaxKind.LessThanToken) {
          this.skipTypeParameters();
        }
        const parameters = this.parseParameterList();
        let returnType: RawNode | undefined;
        if (this.match(SyntaxKind.ColonToken)) {
          returnType = this.parseType();
        }
        const body =
          this.peek().kind === SyntaxKind.OpenBraceToken
            ? this.parseBlock()
            : undefined;
        const end = body?.end ?? returnType?.end ?? name.end;
        properties.push({
          kind: SyntaxKind.MethodDeclaration,
          start: propStart,
          end,
          decorators: [],
          modifiers: [],
          name,
          questionToken: false,
          parameters,
          returnType,
          body,
        } as RawMethodDeclaration);
      } else if (this.match(SyntaxKind.ColonToken)) {
        const initializer = this.parseAssignmentExpression();
        properties.push({
          kind: SyntaxKind.PropertyAssignment,
          start: propStart,
          end: initializer.end,
          name,
          initializer,
        } as RawPropertyAssignment);
      } else {
        // Shorthand property `{ foo }` or destructuring default `{ foo = 1 }`
        let end = name.end;
        if (this.match(SyntaxKind.EqualsToken)) {
          const def = this.parseAssignmentExpression();
          end = def.end;
        }
        properties.push({
          kind: SyntaxKind.ShorthandPropertyAssignment,
          start: propStart,
          end,
          name:
            name.kind === SyntaxKind.Identifier
              ? (name as RawIdentifier)
              : {
                  kind: SyntaxKind.Identifier,
                  start: name.start,
                  end: name.end,
                  text: name.text ?? "",
                },
        } as RawShorthandPropertyAssignment);
      }

      if (!this.match(SyntaxKind.CommaToken)) break;
      if (this.pos === prevPos) this.advance();
    }

    const close = this.match(SyntaxKind.CloseBraceToken);
    return {
      kind: SyntaxKind.ObjectLiteralExpression,
      start: open.start,
      end: close ? close.end : this.peek().end,
      properties,
    };
  }

  private parseFunctionExpression(isAsync: boolean): RawFunctionExpression {
    const kw = this.advance(); // function
    this.match(SyntaxKind.AsteriskToken);
    let name: RawIdentifier | undefined;
    if (isWordToken(this.peek().kind)) {
      name = this.makeIdent(this.advance());
    }
    if (this.peek().kind === SyntaxKind.LessThanToken) {
      this.skipTypeParameters();
    }
    const parameters = this.parseParameterList();
    let returnType: RawNode | undefined;
    if (this.match(SyntaxKind.ColonToken)) {
      returnType = this.parseType();
    }
    const body =
      this.peek().kind === SyntaxKind.OpenBraceToken
        ? this.parseBlock()
        : ({
            kind: SyntaxKind.Block,
            start: this.peek().start,
            end: this.peek().start,
            statements: [],
          } as RawBlock);
    return {
      kind: SyntaxKind.FunctionExpression,
      start: kw.start,
      end: body.end,
      isAsync,
      name,
      parameters,
      returnType,
      body,
    };
  }

  /**
   * Minimal balanced JSX element/fragment parser so `.tsx` files parse cleanly
   * and nested `{expression}` interpolations stay in the AST.
   */
  private parseJsxElement(): RawNode {
    const startTok = this.advance(); // <
    const children: RawNode[] = [];
    let end = startTok.end;

    // Opening tag attributes until `>` or `/>`
    let selfClosing = false;
    while (!this.atEnd()) {
      const t = this.peek();
      if (t.kind === SyntaxKind.SlashToken && this.peek(1).kind === SyntaxKind.GreaterThanToken) {
        this.advance();
        end = this.advance().end;
        selfClosing = true;
        break;
      }
      if (t.kind === SyntaxKind.GreaterThanToken) {
        end = this.advance().end;
        break;
      }
      if (t.kind === SyntaxKind.OpenBraceToken) {
        this.advance();
        if (this.peek().kind !== SyntaxKind.CloseBraceToken) {
          children.push(this.parseExpression());
        }
        const close = this.match(SyntaxKind.CloseBraceToken);
        if (close) end = close.end;
        continue;
      }
      end = this.advance().end;
    }

    if (selfClosing) {
      return {
        kind: SyntaxKind.JsxExpression,
        start: startTok.start,
        end,
        children,
      };
    }

    // JSX body until matching `</...>`
    let depth = 1;
    while (!this.atEnd() && depth > 0) {
      const t = this.peek();
      if (t.kind === SyntaxKind.OpenBraceToken) {
        this.advance();
        if (this.peek().kind !== SyntaxKind.CloseBraceToken) {
          children.push(this.parseExpression());
        }
        const close = this.match(SyntaxKind.CloseBraceToken);
        if (close) end = close.end;
        continue;
      }
      if (
        t.kind === SyntaxKind.LessThanToken &&
        this.peek(1).kind === SyntaxKind.SlashToken
      ) {
        this.advance(); // <
        this.advance(); // /
        while (!this.atEnd() && this.peek().kind !== SyntaxKind.GreaterThanToken) {
          this.advance();
        }
        const gt = this.match(SyntaxKind.GreaterThanToken);
        if (gt) end = gt.end;
        depth--;
        continue;
      }
      if (
        t.kind === SyntaxKind.LessThanToken &&
        (isWordToken(this.peek(1).kind) ||
          this.peek(1).kind === SyntaxKind.GreaterThanToken)
      ) {
        const nested = this.parseJsxElement();
        children.push(nested);
        end = nested.end;
        continue;
      }
      end = this.advance().end;
    }

    return {
      kind: SyntaxKind.JsxExpression,
      start: startTok.start,
      end,
      children,
    };
  }

  // ─── Type Grammar ────────────────────────────────────────────────────────

  private skipTypeParameters(): void {
    this.trySkipTypeParameters();
  }

  private trySkipTypeParameters(): boolean {
    if (this.peek().kind !== SyntaxKind.LessThanToken) return false;
    this.advance(); // <
    let depth = 1;
    while (!this.atEnd() && depth > 0) {
      const k = this.peek().kind;
      if (k === SyntaxKind.LessThanToken) {
        depth++;
        this.advance();
      } else if (this.isGreaterThanLike()) {
        this.consumeGreaterThan();
        depth--;
      } else if (
        k === SyntaxKind.SemicolonToken ||
        k === SyntaxKind.OpenBraceToken && depth === 1 && !this.isInsideTypeConstraint()
      ) {
        return false;
      } else {
        this.advance();
      }
    }
    return depth === 0;
  }

  private isInsideTypeConstraint(): boolean {
    // Allow `{ ... }` object type constraints inside `<T extends { a: string }>`
    return true;
  }

  private parseTypeArguments(): { args: RawNode[]; end: number } {
    const args: RawNode[] = [];
    this.match(SyntaxKind.LessThanToken);
    let end = this.tokens[this.pos - 1]?.end ?? 0;
    while (!this.atEnd() && !this.isGreaterThanLike()) {
      const prevPos = this.pos;
      const prevPending = this.pending;
      args.push(this.parseType());
      if (!this.match(SyntaxKind.CommaToken)) break;
      if (this.pos === prevPos && this.pending === prevPending) break;
    }
    const gt = this.consumeGreaterThan();
    if (gt) end = gt.end;
    return { args, end };
  }

  private tryParseTypeArguments(): RawNode[] | undefined {
    if (this.peek().kind !== SyntaxKind.LessThanToken) return undefined;
    const saved = this.save();
    this.advance(); // <
    const args: RawNode[] = [];
    while (!this.atEnd() && !this.isGreaterThanLike()) {
      const prevPos = this.pos;
      const prevPending = this.pending;
      const t = this.parseType();
      args.push(t);
      if (this.match(SyntaxKind.CommaToken)) continue;
      if (this.pos === prevPos && this.pending === prevPending) {
        this.restore(saved);
        return undefined;
      }
      break;
    }
    if (!this.consumeGreaterThan()) {
      this.restore(saved);
      return undefined;
    }
    return args;
  }

  private parseType(): RawNode {
    // `asserts x is T` / `asserts x`
    if (
      this.peek().kind === SyntaxKind.AssertsKeyword &&
      (isWordToken(this.peek(1).kind) ||
        this.peek(1).kind === SyntaxKind.ThisKeyword)
    ) {
      const startTok = this.advance();
      const target = this.advance();
      let end = target.end;
      const children: RawNode[] = [this.makeIdent(target)];
      if (this.match(SyntaxKind.IsKeyword)) {
        const pred = this.parseType();
        children.push(pred);
        end = pred.end;
      }
      return {
        kind: SyntaxKind.TypePredicate,
        start: startTok.start,
        end,
        children,
      };
    }

    // Function or constructor type: `new (...) => R`, `<T>(...) => R`, `(...) => R`
    const fnType = this.tryParseFunctionOrConstructorType();
    if (fnType) return fnType;

    // Conditional type: `Check extends Extends ? True : False`
    let type = this.parseUnionType();

    // Type predicate `x is T`
    if (
      this.peek().kind === SyntaxKind.IsKeyword &&
      !this.peek().lineBreakBefore &&
      (type.kind === SyntaxKind.TypeReference ||
        type.kind === SyntaxKind.ThisKeyword)
    ) {
      this.advance();
      const pred = this.parseType();
      return {
        kind: SyntaxKind.TypePredicate,
        start: type.start,
        end: pred.end,
        children: [type, pred],
      };
    }

    if (
      this.peek().kind === SyntaxKind.ExtendsKeyword &&
      !this.peek().lineBreakBefore
    ) {
      this.advance();
      const extendsType = this.parseType();
      if (this.match(SyntaxKind.QuestionToken)) {
        const trueType = this.parseType();
        this.match(SyntaxKind.ColonToken);
        const falseType = this.parseType();
        return {
          kind: SyntaxKind.ConditionalType,
          start: type.start,
          end: falseType.end,
          children: [type, extendsType, trueType, falseType],
        };
      }
    }

    return type;
  }

  private tryParseFunctionOrConstructorType(): RawFunctionType | undefined {
    const tok = this.peek();
    const saved = this.save();
    let isCtor = false;
    const start = tok.start;

    if (
      tok.kind === SyntaxKind.AbstractKeyword &&
      this.peek(1).kind === SyntaxKind.NewKeyword
    ) {
      this.advance();
    }
    if (this.peek().kind === SyntaxKind.NewKeyword) {
      isCtor = true;
      this.advance();
    }

    if (
      this.peek().kind !== SyntaxKind.OpenParenToken &&
      this.peek().kind !== SyntaxKind.LessThanToken
    ) {
      this.restore(saved);
      return undefined;
    }

    if (this.peek().kind === SyntaxKind.LessThanToken) {
      if (!this.trySkipTypeParameters()) {
        this.restore(saved);
        return undefined;
      }
    }
    if (this.peek().kind !== SyntaxKind.OpenParenToken) {
      this.restore(saved);
      return undefined;
    }

    const parameters = this.parseParameterList();
    if (this.match(SyntaxKind.EqualsGreaterThanToken)) {
      const returnType = this.parseType();
      return {
        kind: isCtor ? SyntaxKind.ConstructorType : SyntaxKind.FunctionType,
        start,
        end: returnType.end,
        parameters,
        returnType,
      };
    }

    this.restore(saved);
    return undefined;
  }

  private parseUnionType(): RawNode {
    const leadingBar = this.match(SyntaxKind.BarToken);
    const first = this.parseIntersectionType();
    if (this.peek().kind !== SyntaxKind.BarToken) {
      return first;
    }
    const types: RawNode[] = [first];
    while (this.match(SyntaxKind.BarToken)) {
      types.push(this.parseIntersectionType());
    }
    return {
      kind: SyntaxKind.UnionType,
      start: leadingBar ? leadingBar.start : types[0]!.start,
      end: types[types.length - 1]!.end,
      types,
    } as RawUnionOrIntersectionType;
  }

  private parseIntersectionType(): RawNode {
    const leadingAmp = this.match(SyntaxKind.AmpersandToken);
    const first = this.parseTypeOperator();
    if (this.peek().kind !== SyntaxKind.AmpersandToken) {
      return first;
    }
    const types: RawNode[] = [first];
    while (this.match(SyntaxKind.AmpersandToken)) {
      types.push(this.parseTypeOperator());
    }
    return {
      kind: SyntaxKind.IntersectionType,
      start: leadingAmp ? leadingAmp.start : types[0]!.start,
      end: types[types.length - 1]!.end,
      types,
    } as RawUnionOrIntersectionType;
  }

  private parseTypeOperator(): RawNode {
    const tok = this.peek();
    if (
      tok.kind === SyntaxKind.ReadonlyKeyword ||
      tok.kind === SyntaxKind.KeyOfKeyword ||
      tok.kind === SyntaxKind.UniqueKeyword
    ) {
      this.advance();
      const inner = this.parseTypeOperator();
      return {
        kind: SyntaxKind.TypeOperator,
        start: tok.start,
        end: inner.end,
        operator: tok.kind,
        typeNode: inner,
      } as RawTypeOperator;
    }
    if (tok.kind === SyntaxKind.InferKeyword) {
      this.advance();
      const name = this.makeIdent(this.advance());
      let end = name.end;
      if (this.match(SyntaxKind.ExtendsKeyword)) {
        const constraint = this.parseTypeOperator();
        end = constraint.end;
      }
      return {
        kind: SyntaxKind.TypeOperator,
        start: tok.start,
        end,
        operator: tok.kind,
        typeNode: name,
      } as RawTypeOperator;
    }
    return this.parsePostfixType();
  }

  private parsePostfixType(): RawNode {
    let type = this.parsePrimaryType();
    while (!this.atEnd() && !this.peek().lineBreakBefore) {
      if (this.peek().kind === SyntaxKind.OpenBracketToken) {
        this.advance();
        if (this.peek().kind === SyntaxKind.CloseBracketToken) {
          const close = this.advance();
          type = {
            kind: SyntaxKind.ArrayType,
            start: type.start,
            end: close.end,
            elementType: type,
          } as RawArrayType;
        } else {
          const indexType = this.parseType();
          const close = this.match(SyntaxKind.CloseBracketToken);
          type = {
            kind: SyntaxKind.IndexedAccessType,
            start: type.start,
            end: close ? close.end : indexType.end,
            children: [type, indexType],
          };
        }
      } else {
        break;
      }
    }
    return type;
  }

  private parsePrimaryType(): RawNode {
    const tok = this.peek();

    // Primitive keyword types
    switch (tok.kind) {
      case SyntaxKind.StringKeyword:
      case SyntaxKind.NumberKeyword:
      case SyntaxKind.BooleanKeyword:
      case SyntaxKind.BigIntKeyword:
      case SyntaxKind.SymbolKeyword:
      case SyntaxKind.VoidKeyword:
      case SyntaxKind.UndefinedKeyword:
      case SyntaxKind.NullKeyword:
      case SyntaxKind.NeverKeyword:
      case SyntaxKind.AnyKeyword:
      case SyntaxKind.UnknownKeyword:
      case SyntaxKind.ObjectKeyword:
      case SyntaxKind.ThisKeyword:
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword: {
        this.advance();
        return {
          kind: tok.kind,
          start: tok.start,
          end: tok.end,
          text: tok.text,
        };
      }
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral: {
        const lit = this.parseStringLiteral();
        return {
          kind: SyntaxKind.LiteralType,
          start: lit.start,
          end: lit.end,
          literal: lit,
        } as RawLiteralType;
      }
      case SyntaxKind.TemplateHead: {
        const start = this.advance().start;
        const children: RawNode[] = [];
        let end = tok.end;
        while (!this.atEnd()) {
          children.push(this.parseType());
          const next = this.peek();
          if (next.kind === SyntaxKind.TemplateTail) {
            end = this.advance().end;
            break;
          }
          if (next.kind === SyntaxKind.TemplateMiddle) {
            end = this.advance().end;
            continue;
          }
          break;
        }
        return {
          kind: SyntaxKind.TemplateLiteralType,
          start,
          end,
          children,
        };
      }
      case SyntaxKind.NumericLiteral: {
        const lit = this.parseNumericLiteral();
        return {
          kind: SyntaxKind.LiteralType,
          start: lit.start,
          end: lit.end,
          literal: lit,
        } as RawLiteralType;
      }
      case SyntaxKind.MinusToken: {
        this.advance();
        const lit = this.parseNumericLiteral();
        return {
          kind: SyntaxKind.LiteralType,
          start: tok.start,
          end: lit.end,
          literal: {
            ...lit,
            start: tok.start,
            text: `-${lit.text}`,
            value: -lit.value,
          },
        } as RawLiteralType;
      }
      case SyntaxKind.TypeOfKeyword: {
        this.advance();
        let name: RawNode = this.makeIdent(this.advance());
        while (this.peek().kind === SyntaxKind.DotToken) {
          this.advance();
          const right = this.makeIdent(this.advance());
          name = {
            kind: SyntaxKind.QualifiedName,
            start: name.start,
            end: right.end,
            children: [name, right],
          };
        }
        let end = name.end;
        if (this.peek().kind === SyntaxKind.LessThanToken) {
          end = this.parseTypeArguments().end;
        }
        return {
          kind: SyntaxKind.TypeQuery,
          start: tok.start,
          end,
          exprName: name,
        } as RawTypeQuery;
      }
      case SyntaxKind.ImportKeyword: {
        this.advance();
        this.match(SyntaxKind.OpenParenToken);
        const modSpec =
          this.peek().kind === SyntaxKind.StringLiteral
            ? this.parseStringLiteral()
            : undefined;
        let end = this.match(SyntaxKind.CloseParenToken)?.end ?? tok.end;
        while (this.match(SyntaxKind.DotToken)) {
          end = this.advance().end;
        }
        if (this.peek().kind === SyntaxKind.LessThanToken) {
          end = this.parseTypeArguments().end;
        }
        return {
          kind: SyntaxKind.ImportType,
          start: tok.start,
          end,
          children: modSpec ? [modSpec] : [],
        };
      }
      case SyntaxKind.OpenParenToken: {
        const open = this.advance();
        const inner = this.parseType();
        const close = this.match(SyntaxKind.CloseParenToken);
        return {
          kind: SyntaxKind.ParenthesizedType,
          start: open.start,
          end: close ? close.end : inner.end,
          typeNode: inner,
        } as RawParenthesizedType;
      }
      case SyntaxKind.OpenBracketToken: {
        const open = this.advance();
        const elements: RawNode[] = [];
        while (!this.atEnd() && this.peek().kind !== SyntaxKind.CloseBracketToken) {
          const prevPos = this.pos;
          const prevPending = this.pending;
          const isRest = Boolean(this.match(SyntaxKind.DotDotDotToken));
          // Named tuple member: `name: Type` or `name?: Type`
          if (
            isWordToken(this.peek().kind) &&
            (this.peek(1).kind === SyntaxKind.ColonToken ||
              (this.peek(1).kind === SyntaxKind.QuestionToken &&
                this.peek(2).kind === SyntaxKind.ColonToken))
          ) {
            const label = this.advance();
            this.match(SyntaxKind.QuestionToken);
            this.match(SyntaxKind.ColonToken);
            const t = this.parseType();
            elements.push({
              kind: SyntaxKind.NamedTupleMember,
              start: label.start,
              end: t.end,
              children: [t],
            });
          } else {
            const t = this.parseType();
            this.match(SyntaxKind.QuestionToken);
            elements.push(
              isRest
                ? { kind: SyntaxKind.RestType, start: t.start, end: t.end, children: [t] }
                : t,
            );
          }
          if (!this.match(SyntaxKind.CommaToken)) break;
          if (this.pos === prevPos && this.pending === prevPending) break;
        }
        const close = this.match(SyntaxKind.CloseBracketToken);
        return {
          kind: SyntaxKind.TupleType,
          start: open.start,
          end: close ? close.end : this.peek().end,
          elements,
        } as RawTupleType;
      }
      case SyntaxKind.OpenBraceToken: {
        const startPos = tok.start;
        const { members, end } = this.parseTypeMemberBlock();
        return {
          kind: SyntaxKind.TypeLiteral,
          start: startPos,
          end,
          members,
        } as RawTypeLiteral;
      }
      default: {
        // TypeReference: `Foo`, `Ns.Foo`, `Promise<OrderResult | null>`
        let typeName: RawNode = this.makeIdent(this.advance());
        while (this.peek().kind === SyntaxKind.DotToken) {
          this.advance();
          const right = this.makeIdent(this.advance());
          typeName = {
            kind: SyntaxKind.QualifiedName,
            start: typeName.start,
            end: right.end,
            children: [typeName, right],
          };
        }
        let typeArguments: RawNode[] = [];
        let end = typeName.end;
        if (this.peek().kind === SyntaxKind.LessThanToken) {
          const parsed = this.parseTypeArguments();
          typeArguments = parsed.args;
          end = parsed.end;
        }
        return {
          kind: SyntaxKind.TypeReference,
          start: typeName.start,
          end,
          typeName,
          typeArguments,
        } as RawTypeReference;
      }
    }
  }
}

export function parseTypeScript(
  source: string,
  filePath = "anonymous.ts",
): RawSourceFile {
  const { tokens, lineStarts } = lexTypeScript(source);
  const isTsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");
  const parser = new TypeScriptParser(tokens, isTsx);
  return parser["parseSourceFile"](lineStarts, source.length);
}
