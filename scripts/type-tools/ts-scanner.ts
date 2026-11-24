/**
 * ts-scanner.ts
 *
 * Zero-dependency TypeScript type-position & generic-default AST scanner built
 * directly on Bunest's native lexer (`packages/cli/src/ast/lexer.ts`) and Bun
 * file/glob primitives. Powers all `scripts/type-tools/*` scripts with zero
 * external dependencies.
 */

import {
  join,
  normalize,
  readTextSync,
  resolve,
} from "../../packages/core/src/common/index";
import {
  getLineAndColumnAtPos,
  lexTypeScript,
  type Token,
} from "../../packages/cli/src/ast/lexer";
import { SyntaxKind } from "../../packages/cli/src/ast/syntax-kind";

export type KeywordType = "any" | "unknown";

export type SimpleAnyKind =
  | "parameter"
  | "return"
  | "variable"
  | "generic"
  | "generic-default"
  | "index-signature"
  | "other";

export type DetailedAstKind =
  | "double-cast"
  | "type-assertion"
  | "record-value"
  | "index-signature"
  | "rest-args"
  | "array-element"
  | "generic-default"
  | "generic-constraint"
  | "generic-arg"
  | "conditional-extends"
  | "function-type"
  | "constructor-type"
  | "parameter"
  | "return-type"
  | "property"
  | "variable"
  | "catch-clause"
  | "type-alias"
  | "union-or-intersection"
  | "other";

export interface TypeKeywordHit {
  keyword: KeywordType;
  line: number;
  col: number;
  lineStartOffset: number;
  lineText: string;
  simpleKind: SimpleAnyKind;
  astKind: DetailedAstKind;
  isPublicApi: boolean;
  enclosing: string;
  outerType: string;
  containerTypeName?: string;
  symbolName?: string;
  insideRecordAncestor: boolean;
}

export interface GenericDefaultHit {
  line: number;
  typeName: string;
  paramName: string;
  currentDefault: string;
  context: string;
}

export interface FileScanResult {
  hits: TypeKeywordHit[];
  genericDefaults: GenericDefaultHit[];
}

// ─── File Collection (Bun.Glob, zero external deps) ──────────────────────────

function isExcludedPath(
  relPath: string,
  excludeRules: readonly string[],
  excludeDts: boolean,
): boolean {
  const norm = relPath.replace(/\\/g, "/");
  if (norm.includes("/node_modules/") || norm.startsWith("node_modules/")) {
    return true;
  }
  if (norm.includes("/dist/") || norm.startsWith("dist/")) {
    return true;
  }
  if (excludeDts && norm.endsWith(".d.ts")) {
    return true;
  }
  for (const rule of excludeRules) {
    const clean = rule
      .replace(/^!/, "")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    if (!clean) continue;
    if (clean === "node_modules" || clean === "**/node_modules/**") {
      if (norm.includes("/node_modules/") || norm.startsWith("node_modules/")) {
        return true;
      }
      continue;
    }
    if (clean === "**/dist" || clean === "**/dist/**") {
      if (norm.includes("/dist/") || norm.startsWith("dist/")) return true;
      continue;
    }
    if (clean === "**/*.d.ts") {
      if (norm.endsWith(".d.ts")) return true;
      continue;
    }
    if (clean.includes("*")) {
      const glob = new Bun.Glob(clean);
      if (glob.match(norm)) return true;
    } else if (norm === clean || norm.startsWith(`${clean}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Collects TypeScript source files matching a `tsconfig.json`'s `include`/`exclude`
 * entries using `Bun.Glob`.
 */
export function collectTsConfigFiles(
  rootDir: string,
  tsconfigPath: string,
  options?: { excludeDts?: boolean },
): string[] {
  const raw = readTextSync(tsconfigPath);
  const parsed = JSON.parse(raw) as {
    include?: string[];
    exclude?: string[];
  };
  const includes = parsed.include ?? ["**/*.ts"];
  const excludes = parsed.exclude ?? ["node_modules", "**/dist"];
  const excludeDts = options?.excludeDts ?? false;

  const found = new Set<string>();
  for (const pattern of includes) {
    const glob = new Bun.Glob(pattern);
    for (const rel of glob.scanSync({ cwd: rootDir, onlyFiles: true })) {
      const normRel = rel.replace(/\\/g, "/");
      if (isExcludedPath(normRel, excludes, excludeDts)) continue;
      found.add(normalize(join(rootDir, normRel)));
    }
  }

  return [...found].sort();
}

/**
 * Collects files matching a list of positive and `!`-prefixed negative glob patterns
 * relative to `rootDir`.
 */
export function collectGlobFiles(
  rootDir: string,
  patterns: readonly string[],
): string[] {
  const positives: string[] = [];
  const negatives: string[] = [];

  for (const p of patterns) {
    if (p.startsWith("!")) {
      negatives.push(p.slice(1));
    } else {
      positives.push(p);
    }
  }

  const found = new Set<string>();
  for (const pat of positives) {
    const glob = new Bun.Glob(pat);
    for (const rel of glob.scanSync({ cwd: rootDir, onlyFiles: true })) {
      const normRel = rel.replace(/\\/g, "/");
      if (isExcludedPath(normRel, negatives, false)) continue;
      found.add(resolve(rootDir, normRel));
    }
  }

  return [...found].sort();
}

// ─── Internal AST Node & Scope Models ────────────────────────────────────────

type NodeRole =
  | "AnyKeyword"
  | "UnknownKeyword"
  | "TypeParameter"
  | "TypeParameterConstraint"
  | "TypeParameterDefault"
  | "TypeReference"
  | "ArrayType"
  | "IndexSignature"
  | "FunctionType"
  | "ConstructorType"
  | "Parameter"
  | "ReturnType"
  | "Property"
  | "Variable"
  | "CatchClause"
  | "TypeAlias"
  | "UnionType"
  | "IntersectionType"
  | "AsExpression"
  | "DoubleCast"
  | "TypeAssertionExpression"
  | "ConditionalExtends"
  | "TypeOperator"
  | "ParenthesizedType"
  | "Other";

interface TypeNode {
  role: NodeRole;
  start: number;
  end: number;
  name?: string;
  isRest?: boolean;
  parent?: TypeNode;
  // Captured declaration context for root / leaf nodes
  isPublicApi?: boolean;
  enclosing?: string;
  symbolName?: string;
}

type ScopeKind =
  | "class"
  | "interface"
  | "type"
  | "function"
  | "method"
  | "get"
  | "set"
  | "constructor"
  | "property"
  | "variable"
  | "parameter"
  | "block"
  | "arrow-body"
  | "namespace";

interface ScopeFrame {
  kind: ScopeKind;
  label?: string;
  rawName?: string;
  exported?: boolean;
  nonPublic?: boolean;
  symbolName?: string;
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

const EXPR_PREFIX_ALLOWING_TYPE_ASSERTION = new Set<SyntaxKind>([
  SyntaxKind.EqualsToken,
  SyntaxKind.CompoundAssignmentToken,
  SyntaxKind.OpenParenToken,
  SyntaxKind.OpenBracketToken,
  SyntaxKind.OpenBraceToken,
  SyntaxKind.CommaToken,
  SyntaxKind.ColonToken,
  SyntaxKind.SemicolonToken,
  SyntaxKind.QuestionToken,
  SyntaxKind.EqualsGreaterThanToken,
  SyntaxKind.ReturnKeyword,
  SyntaxKind.ThrowKeyword,
  SyntaxKind.YieldKeyword,
  SyntaxKind.AwaitKeyword,
  SyntaxKind.CaseKeyword,
  SyntaxKind.PlusToken,
  SyntaxKind.MinusToken,
  SyntaxKind.ExclamationToken,
  SyntaxKind.TildeToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.DotDotDotToken,
]);

const INVALID_TYPE_ARG_TOKENS = new Set<SyntaxKind>([
  SyntaxKind.ReturnKeyword,
  SyntaxKind.IfKeyword,
  SyntaxKind.ElseKeyword,
  SyntaxKind.ForKeyword,
  SyntaxKind.WhileKeyword,
  SyntaxKind.DoKeyword,
  SyntaxKind.SwitchKeyword,
  SyntaxKind.CaseKeyword,
  SyntaxKind.BreakKeyword,
  SyntaxKind.ContinueKeyword,
  SyntaxKind.TryKeyword,
  SyntaxKind.CatchKeyword,
  SyntaxKind.FinallyKeyword,
  SyntaxKind.ThrowKeyword,
  SyntaxKind.ConstKeyword,
  SyntaxKind.LetKeyword,
  SyntaxKind.VarKeyword,
  SyntaxKind.ClassKeyword,
  SyntaxKind.InterfaceKeyword,
  SyntaxKind.EnumKeyword,
  SyntaxKind.DebuggerKeyword,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
  SyntaxKind.CompoundAssignmentToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.SemicolonToken,
]);

function isWordLike(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.Identifier ||
    kind === SyntaxKind.PrivateIdentifier ||
    kind >= SyntaxKind.TrueKeyword
  );
}

function isPropertyNameKind(kind: SyntaxKind): boolean {
  return (
    isWordLike(kind) ||
    kind === SyntaxKind.StringLiteral ||
    kind === SyntaxKind.NumericLiteral
  );
}

// ─── Recursive-Descent Type-Aware Scanner ────────────────────────────────────

class TypeScriptScanner {
  private readonly source: string;
  private readonly lines: string[];
  private readonly lineStarts: readonly number[];
  private readonly tokens: Token[];
  private readonly isTsx: boolean;
  private pos = 0;

  private readonly scopes: ScopeFrame[] = [];
  private readonly keywordNodes: TypeNode[] = [];
  private readonly genericDefaults: GenericDefaultHit[] = [];

  constructor(source: string, filePath?: string) {
    this.source = source;
    this.lines = source.split("\n");
    const lexed = lexTypeScript(source);
    this.tokens = lexed.tokens.slice();
    this.lineStarts = lexed.lineStarts;
    this.isTsx = Boolean(filePath && filePath.endsWith(".tsx"));
  }

  private peek(offset = 0): Token {
    const idx = this.pos + offset;
    if (idx >= this.tokens.length) {
      return this.tokens[this.tokens.length - 1]!;
    }
    return this.tokens[idx]!;
  }

  private at(kind: SyntaxKind, offset = 0): boolean {
    return this.peek(offset).kind === kind;
  }

  private next(): Token {
    const tok = this.peek();
    if (tok.kind !== SyntaxKind.EndOfFileToken) {
      this.pos++;
    }
    return tok;
  }

  private match(kind: SyntaxKind): boolean {
    if (this.at(kind)) {
      this.next();
      return true;
    }
    return false;
  }

  private atEof(): boolean {
    return this.peek().kind === SyntaxKind.EndOfFileToken;
  }

  /** Checks if current token starts with `>` (handles `>`, `>>`, `>>>`, `>=`). */
  private atClosingAngle(): boolean {
    const k = this.peek().kind;
    return (
      k === SyntaxKind.GreaterThanToken ||
      k === SyntaxKind.GreaterThanGreaterThanToken ||
      k === SyntaxKind.GreaterThanGreaterThanGreaterThanToken ||
      k === SyntaxKind.GreaterThanEqualsToken
    );
  }

  /** Consumes a single `>` character, splitting `>>`, `>>>`, or `>=` in-place. */
  private consumeClosingAngle(): Token {
    const tok = this.peek();
    if (tok.kind === SyntaxKind.GreaterThanToken) {
      this.pos++;
      return tok;
    }
    if (tok.kind === SyntaxKind.GreaterThanGreaterThanToken) {
      const consumed: Token = {
        kind: SyntaxKind.GreaterThanToken,
        start: tok.start,
        end: tok.start + 1,
        text: ">",
        lineBreakBefore: tok.lineBreakBefore,
      };
      this.tokens[this.pos] = {
        kind: SyntaxKind.GreaterThanToken,
        start: tok.start + 1,
        end: tok.end,
        text: ">",
        lineBreakBefore: false,
      };
      return consumed;
    }
    if (tok.kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
      const consumed: Token = {
        kind: SyntaxKind.GreaterThanToken,
        start: tok.start,
        end: tok.start + 1,
        text: ">",
        lineBreakBefore: tok.lineBreakBefore,
      };
      this.tokens[this.pos] = {
        kind: SyntaxKind.GreaterThanGreaterThanToken,
        start: tok.start + 1,
        end: tok.end,
        text: ">>",
        lineBreakBefore: false,
      };
      return consumed;
    }
    if (tok.kind === SyntaxKind.GreaterThanEqualsToken) {
      const consumed: Token = {
        kind: SyntaxKind.GreaterThanToken,
        start: tok.start,
        end: tok.start + 1,
        text: ">",
        lineBreakBefore: tok.lineBreakBefore,
      };
      this.tokens[this.pos] = {
        kind: SyntaxKind.EqualsToken,
        start: tok.start + 1,
        end: tok.end,
        text: "=",
        lineBreakBefore: false,
      };
      return consumed;
    }
    return this.next();
  }

  /** Splits `<<` into two `<` tokens when expecting a nested `<` in type position. */
  private splitOpeningAngleIfNeeded(): void {
    const tok = this.peek();
    if (tok.kind === SyntaxKind.LessThanLessThanToken) {
      const first: Token = {
        kind: SyntaxKind.LessThanToken,
        start: tok.start,
        end: tok.start + 1,
        text: "<",
        lineBreakBefore: tok.lineBreakBefore,
      };
      const second: Token = {
        kind: SyntaxKind.LessThanToken,
        start: tok.start + 1,
        end: tok.end,
        text: "<",
        lineBreakBefore: false,
      };
      this.tokens.splice(this.pos, 1, first, second);
    }
  }

  private currentContext(): {
    isPublicApi: boolean;
    enclosing: string;
    symbolName?: string;
  } {
    let sawExported = false;
    let isNonPublic = false;
    let insideImpl = false;
    const parts: string[] = [];
    let symbolName: string | undefined;

    for (let i = 0; i < this.scopes.length; i++) {
      const frame = this.scopes[i]!;
      if (frame.kind === "block" || frame.kind === "arrow-body") {
        insideImpl = true;
      }
      if (frame.nonPublic) {
        isNonPublic = true;
      }
      if (frame.exported) {
        sawExported = true;
      }
      if (frame.label) {
        parts.push(frame.label);
      }
    }

    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const frame = this.scopes[i]!;
      if (frame.symbolName) {
        symbolName = frame.symbolName;
        break;
      }
    }

    return {
      isPublicApi: sawExported && !isNonPublic && !insideImpl,
      enclosing: parts.length > 0 ? parts.join(".") : "<top-level>",
      symbolName,
    };
  }

  private makeContextNode(
    role: NodeRole,
    start: number,
    end: number,
    extra?: Partial<TypeNode>,
  ): TypeNode {
    const ctx = this.currentContext();
    return {
      role,
      start,
      end,
      isPublicApi: ctx.isPublicApi,
      enclosing: ctx.enclosing,
      symbolName: extra?.symbolName ?? ctx.symbolName,
      ...extra,
    };
  }

  private nearestGenericOwnerName(): string {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const frame = this.scopes[i]!;
      if (
        frame.kind === "class" ||
        frame.kind === "interface" ||
        frame.kind === "type" ||
        frame.kind === "function" ||
        frame.kind === "method"
      ) {
        return frame.rawName ?? "unknown";
      }
    }
    return "unknown";
  }

  // ─── Top-Level & Statement Scanning ──────────────────────────────────────

  scan(): FileScanResult {
    while (!this.atEof()) {
      const before = this.pos;
      this.scanStatement(false);
      if (this.pos === before) {
        this.pos++;
      }
    }

    const hits = this.buildKeywordHits();
    return {
      hits,
      genericDefaults: this.genericDefaults,
    };
  }

  private scanStatement(inBlock: boolean): void {
    // Skip leading decorators (scan args for `as any`, etc.)
    while (this.at(SyntaxKind.AtToken)) {
      this.scanDecorator();
    }

    if (this.at(SyntaxKind.SemicolonToken)) {
      this.next();
      return;
    }

    if (this.at(SyntaxKind.OpenBraceToken)) {
      this.scanBlock();
      return;
    }

    let isExported = false;
    let isDeclare = false;
    let sawModifier = false;
    const modStart = this.pos;

    while (STATEMENT_MODIFIERS.has(this.peek().kind)) {
      const k = this.peek().kind;
      if (k === SyntaxKind.ExportKeyword) isExported = true;
      if (k === SyntaxKind.DeclareKeyword) isDeclare = true;
      sawModifier = true;
      this.next();
    }

    // Handle `export { ... }`, `export * from ...`, `export type { ... }`, `export default ...`, `export = ...`
    if (isExported) {
      if (
        this.at(SyntaxKind.OpenBraceToken) ||
        this.at(SyntaxKind.AsteriskToken)
      ) {
        this.skipImportOrExportClause();
        return;
      }
      if (
        this.at(SyntaxKind.TypeKeyword) &&
        (this.at(SyntaxKind.OpenBraceToken, 1) ||
          this.at(SyntaxKind.AsteriskToken, 1))
      ) {
        this.next();
        this.skipImportOrExportClause();
        return;
      }
      if (this.at(SyntaxKind.EqualsToken)) {
        this.next();
        this.scanExpressionUntilStatementEnd();
        return;
      }
    }

    const tok = this.peek();

    // Import declarations
    if (tok.kind === SyntaxKind.ImportKeyword && !sawModifier) {
      // Distinguish `import(...)` dynamic import expression vs `import ... from`
      if (
        !this.at(SyntaxKind.OpenParenToken, 1) &&
        !this.at(SyntaxKind.DotToken, 1)
      ) {
        this.skipImportOrExportClause();
        return;
      }
    }

    // `class` declaration
    if (tok.kind === SyntaxKind.ClassKeyword) {
      this.scanClass(isExported);
      return;
    }

    // `interface` declaration
    if (
      tok.kind === SyntaxKind.InterfaceKeyword &&
      isWordLike(this.peek(1).kind)
    ) {
      this.scanInterface(isExported);
      return;
    }

    // `type Foo<...> = ...` declaration
    if (
      tok.kind === SyntaxKind.TypeKeyword &&
      isWordLike(this.peek(1).kind) &&
      (this.at(SyntaxKind.EqualsToken, 2) ||
        this.at(SyntaxKind.LessThanToken, 2) ||
        this.at(SyntaxKind.LessThanLessThanToken, 2))
    ) {
      this.scanTypeAlias(isExported);
      return;
    }

    // `function` declaration
    if (tok.kind === SyntaxKind.FunctionKeyword) {
      this.scanFunction(isExported);
      return;
    }

    // `const` / `let` / `var` (and `const enum`)
    if (
      tok.kind === SyntaxKind.ConstKeyword ||
      tok.kind === SyntaxKind.LetKeyword ||
      tok.kind === SyntaxKind.VarKeyword
    ) {
      if (
        tok.kind === SyntaxKind.ConstKeyword &&
        this.at(SyntaxKind.EnumKeyword, 1)
      ) {
        this.next();
        this.scanEnum(isExported);
        return;
      }
      this.scanVariableStatement(isExported);
      return;
    }

    // `enum` declaration
    if (tok.kind === SyntaxKind.EnumKeyword) {
      this.scanEnum(isExported);
      return;
    }

    // `namespace` / `module` / `declare global`
    if (
      tok.kind === SyntaxKind.NamespaceKeyword ||
      tok.kind === SyntaxKind.ModuleKeyword ||
      (isDeclare && tok.kind === SyntaxKind.GlobalKeyword)
    ) {
      this.scanNamespace(isExported);
      return;
    }

    // Control flow statements
    if (tok.kind === SyntaxKind.TryKeyword) {
      this.scanTryStatement();
      return;
    }
    if (tok.kind === SyntaxKind.IfKeyword) {
      this.next();
      if (this.at(SyntaxKind.OpenParenToken)) this.scanBalancedParensExpr();
      this.scanStatement(inBlock);
      if (this.match(SyntaxKind.ElseKeyword)) {
        this.scanStatement(inBlock);
      }
      return;
    }
    if (tok.kind === SyntaxKind.ForKeyword) {
      this.scanForStatement(inBlock);
      return;
    }
    if (tok.kind === SyntaxKind.WhileKeyword) {
      this.next();
      if (this.at(SyntaxKind.OpenParenToken)) this.scanBalancedParensExpr();
      this.scanStatement(inBlock);
      return;
    }
    if (tok.kind === SyntaxKind.DoKeyword) {
      this.next();
      this.scanStatement(inBlock);
      if (this.match(SyntaxKind.WhileKeyword)) {
        if (this.at(SyntaxKind.OpenParenToken)) this.scanBalancedParensExpr();
      }
      this.match(SyntaxKind.SemicolonToken);
      return;
    }
    if (tok.kind === SyntaxKind.SwitchKeyword) {
      this.scanSwitchStatement();
      return;
    }
    if (
      tok.kind === SyntaxKind.ReturnKeyword ||
      tok.kind === SyntaxKind.ThrowKeyword
    ) {
      this.next();
      if (!this.at(SyntaxKind.SemicolonToken) && !this.peek().lineBreakBefore) {
        this.scanExpressionUntilStatementEnd();
      } else {
        this.match(SyntaxKind.SemicolonToken);
      }
      return;
    }
    if (
      tok.kind === SyntaxKind.BreakKeyword ||
      tok.kind === SyntaxKind.ContinueKeyword ||
      tok.kind === SyntaxKind.DebuggerKeyword
    ) {
      this.next();
      if (
        this.at(SyntaxKind.Identifier) &&
        !this.peek().lineBreakBefore &&
        tok.kind !== SyntaxKind.DebuggerKeyword
      ) {
        this.next();
      }
      this.match(SyntaxKind.SemicolonToken);
      return;
    }

    // `export default <expr>` — rewind if `async` was actually an arrow expr `async () => ...`
    if (
      sawModifier &&
      !isExported &&
      !isDeclare &&
      this.tokens[modStart]?.kind === SyntaxKind.AsyncKeyword
    ) {
      this.pos = modStart;
    }

    // Fallback: expression statement (handles `export default expr`, assignments, calls, etc.)
    this.scanExpressionUntilStatementEnd();
  }

  private skipImportOrExportClause(): void {
    // Skip `import ... from "..."` or `import "side-effect"` or `import x = require(...)`
    // or `export { ... } from "..."` / `export * from "..."`
    let braceDepth = 0;
    let parenDepth = 0;
    while (!this.atEof()) {
      const k = this.peek().kind;
      if (k === SyntaxKind.OpenBraceToken) braceDepth++;
      else if (k === SyntaxKind.CloseBraceToken) {
        if (braceDepth > 0) braceDepth--;
      } else if (k === SyntaxKind.OpenParenToken) parenDepth++;
      else if (k === SyntaxKind.CloseParenToken) {
        if (parenDepth > 0) parenDepth--;
      } else if (
        k === SyntaxKind.SemicolonToken &&
        braceDepth === 0 &&
        parenDepth === 0
      ) {
        this.next();
        return;
      } else if (
        k === SyntaxKind.FromKeyword &&
        braceDepth === 0 &&
        parenDepth === 0
      ) {
        this.next();
        if (this.at(SyntaxKind.StringLiteral)) {
          this.next();
        }
        // Optional `with { type: "json" }` / `assert { ... }`
        if (
          (this.at(SyntaxKind.WithKeyword) ||
            this.peek().text === "assert") &&
          this.at(SyntaxKind.OpenBraceToken, 1)
        ) {
          this.next();
          this.skipBalancedBraces();
        }
        this.match(SyntaxKind.SemicolonToken);
        return;
      } else if (
        braceDepth === 0 &&
        parenDepth === 0 &&
        this.peek().lineBreakBefore &&
        (k === SyntaxKind.ImportKeyword ||
          k === SyntaxKind.ExportKeyword ||
          k === SyntaxKind.ConstKeyword ||
          k === SyntaxKind.LetKeyword ||
          k === SyntaxKind.VarKeyword ||
          k === SyntaxKind.FunctionKeyword ||
          k === SyntaxKind.ClassKeyword ||
          k === SyntaxKind.InterfaceKeyword ||
          k === SyntaxKind.TypeKeyword ||
          k === SyntaxKind.EnumKeyword)
      ) {
        return;
      }
      this.next();
    }
  }

  private scanDecorator(): void {
    if (!this.match(SyntaxKind.AtToken)) return;
    // Scan decorator expression: `@Dec`, `@ns.Dec(args)`, `@(expr)`
    if (this.at(SyntaxKind.OpenParenToken)) {
      this.scanBalancedParensExpr();
      return;
    }
    while (isWordLike(this.peek().kind)) {
      this.next();
      if (!this.match(SyntaxKind.DotToken)) break;
    }
    if (this.at(SyntaxKind.LessThanToken)) {
      if (this.looksLikeGenericCallTypeArgs(this.pos)) {
        this.parseTypeArgumentList(undefined);
      }
    }
    if (this.at(SyntaxKind.OpenParenToken)) {
      this.scanBalancedParensExpr();
    }
  }

  private scanBlock(pushImplScope = true): void {
    if (!this.match(SyntaxKind.OpenBraceToken)) return;
    if (pushImplScope) {
      this.scopes.push({ kind: "block" });
    }
    try {
      while (!this.atEof() && !this.at(SyntaxKind.CloseBraceToken)) {
        const before = this.pos;
        this.scanStatement(true);
        if (this.pos === before) this.pos++;
      }
      this.match(SyntaxKind.CloseBraceToken);
    } finally {
      if (pushImplScope) {
        this.scopes.pop();
      }
    }
  }

  private scanNamespace(isExported: boolean): void {
    this.next(); // namespace / module / global
    let name = "";
    while (
      isWordLike(this.peek().kind) ||
      this.at(SyntaxKind.StringLiteral) ||
      this.at(SyntaxKind.DotToken)
    ) {
      name += this.next().text;
    }
    this.scopes.push({
      kind: "namespace",
      rawName: name || undefined,
      exported: isExported,
    });
    try {
      if (this.at(SyntaxKind.OpenBraceToken)) {
        // ModuleBlock is NOT an implementation Block (declarations inside are signatures)
        this.scanBlock(false);
      } else {
        this.match(SyntaxKind.SemicolonToken);
      }
    } finally {
      this.scopes.pop();
    }
  }

  private scanEnum(isExported: boolean): void {
    this.next(); // enum
    if (isWordLike(this.peek().kind)) this.next();
    if (this.at(SyntaxKind.OpenBraceToken)) {
      // Enum members can contain initializer expressions (rarely `as any`)
      this.scopes.push({ kind: "block", exported: isExported });
      try {
        this.next();
        while (!this.atEof() && !this.at(SyntaxKind.CloseBraceToken)) {
          const before = this.pos;
          if (isPropertyNameKind(this.peek().kind)) this.next();
          if (this.match(SyntaxKind.EqualsToken)) {
            this.scanExpression(true, true);
          }
          this.match(SyntaxKind.CommaToken);
          if (this.pos === before) this.pos++;
        }
        this.match(SyntaxKind.CloseBraceToken);
      } finally {
        this.scopes.pop();
      }
    }
  }

  private scanTypeAlias(isExported: boolean): void {
    const startTok = this.next(); // type
    const name = isWordLike(this.peek().kind) ? this.next().text : "<anon>";
    this.scopes.push({
      kind: "type",
      label: `type ${name}`,
      rawName: name,
      exported: isExported,
    });
    try {
      if (
        this.at(SyntaxKind.LessThanToken) ||
        this.at(SyntaxKind.LessThanLessThanToken)
      ) {
        this.parseTypeParameterList();
      }
      if (this.match(SyntaxKind.EqualsToken)) {
        const aliasNode = this.makeContextNode(
          "TypeAlias",
          startTok.start,
          startTok.end,
          { name },
        );
        const typeNode = this.parseType(aliasNode);
        aliasNode.end = typeNode.end;
      }
      this.match(SyntaxKind.SemicolonToken);
    } finally {
      this.scopes.pop();
    }
  }

  private scanInterface(isExported: boolean): void {
    this.next(); // interface
    const name = isWordLike(this.peek().kind) ? this.next().text : "<anon>";
    this.scopes.push({
      kind: "interface",
      label: `interface ${name}`,
      rawName: name,
      exported: isExported,
    });
    try {
      if (
        this.at(SyntaxKind.LessThanToken) ||
        this.at(SyntaxKind.LessThanLessThanToken)
      ) {
        this.parseTypeParameterList();
      }
      if (this.match(SyntaxKind.ExtendsKeyword)) {
        this.scanHeritageTypes();
      }
      if (this.at(SyntaxKind.OpenBraceToken)) {
        this.scanTypeLiteralMembers(undefined, true);
      }
    } finally {
      this.scopes.pop();
    }
  }

  private scanClass(isExported: boolean): void {
    this.next(); // class
    let name: string | undefined;
    if (
      isWordLike(this.peek().kind) &&
      !this.at(SyntaxKind.ExtendsKeyword) &&
      !this.at(SyntaxKind.ImplementsKeyword)
    ) {
      name = this.next().text;
    }
    this.scopes.push({
      kind: "class",
      label: name ?? "<anon-class>",
      rawName: name ?? "unknown",
      exported: isExported,
    });
    try {
      if (
        this.at(SyntaxKind.LessThanToken) ||
        this.at(SyntaxKind.LessThanLessThanToken)
      ) {
        this.parseTypeParameterList();
      }
      while (
        this.at(SyntaxKind.ExtendsKeyword) ||
        this.at(SyntaxKind.ImplementsKeyword)
      ) {
        const isExtends = this.at(SyntaxKind.ExtendsKeyword);
        this.next();
        if (isExtends) {
          this.scanHeritageClause(true);
        } else {
          this.scanHeritageTypes();
        }
      }
      if (this.match(SyntaxKind.OpenBraceToken)) {
        while (!this.atEof() && !this.at(SyntaxKind.CloseBraceToken)) {
          const before = this.pos;
          this.scanClassMember();
          if (this.pos === before) this.pos++;
        }
        this.match(SyntaxKind.CloseBraceToken);
      }
    } finally {
      this.scopes.pop();
    }
  }

  private scanHeritageClause(allowExpression: boolean): void {
    // Handles `extends Base<T, U>` or `extends Mixin(Base)<T>`
    if (allowExpression) {
      // Consume base expression until `<` (type args), `implements`, `{`, or `,`
      let parenDepth = 0;
      while (!this.atEof()) {
        const k = this.peek().kind;
        if (
          parenDepth === 0 &&
          (k === SyntaxKind.OpenBraceToken ||
            k === SyntaxKind.ImplementsKeyword ||
            k === SyntaxKind.CommaToken)
        ) {
          break;
        }
        if (k === SyntaxKind.OpenParenToken) {
          parenDepth++;
          this.scanBalancedParensExpr();
          parenDepth--;
          continue;
        }
        if (
          parenDepth === 0 &&
          (k === SyntaxKind.LessThanToken ||
            k === SyntaxKind.LessThanLessThanToken)
        ) {
          this.parseTypeArgumentList(undefined);
          continue;
        }
        this.next();
      }
    }
  }

  private scanHeritageTypes(): void {
    while (!this.atEof() && !this.at(SyntaxKind.OpenBraceToken)) {
      const before = this.pos;
      this.parseType(this.makeContextNode("Other", this.peek().start, this.peek().end));
      if (!this.match(SyntaxKind.CommaToken)) break;
      if (this.pos === before) this.pos++;
    }
  }

  private scanClassMember(): void {
    while (this.at(SyntaxKind.AtToken)) {
      this.scanDecorator();
    }
    if (this.match(SyntaxKind.SemicolonToken)) return;

    const memberStart = this.peek().start;
    let isNonPublic = false;
    let isStatic = false;

    while (MEMBER_MODIFIERS.has(this.peek().kind)) {
      const k = this.peek().kind;
      if (k === SyntaxKind.PrivateKeyword || k === SyntaxKind.ProtectedKeyword) {
        isNonPublic = true;
      }
      if (k === SyntaxKind.StaticKeyword) {
        isStatic = true;
      }
      this.next();
    }

    // `static { ... }` static initialization block
    if (isStatic && this.at(SyntaxKind.OpenBraceToken)) {
      this.scanBlock(true);
      return;
    }

    // Index signature: `[key: string]: any;`
    if (
      this.at(SyntaxKind.OpenBracketToken) &&
      this.looksLikeIndexSignature(this.pos)
    ) {
      this.scanIndexSignature(memberStart, isNonPublic);
      return;
    }

    // Accessor `get` / `set` (only if followed by member name, NOT `(` or `:` or `=` or `?` or `;`)
    let accessorKind: "get" | "set" | undefined;
    if (
      (this.at(SyntaxKind.GetKeyword) || this.at(SyntaxKind.SetKeyword)) &&
      (isPropertyNameKind(this.peek(1).kind) ||
        this.at(SyntaxKind.OpenBracketToken, 1))
    ) {
      accessorKind = this.at(SyntaxKind.GetKeyword) ? "get" : "set";
      this.next();
    }

    // Generator `*`
    this.match(SyntaxKind.AsteriskToken);

    // Constructor
    if (
      !accessorKind &&
      this.at(SyntaxKind.ConstructorKeyword) &&
      this.at(SyntaxKind.OpenParenToken, 1)
    ) {
      this.next();
      this.scopes.push({
        kind: "constructor",
        label: "constructor()",
        nonPublic: isNonPublic,
      });
      try {
        this.scanParameterList(undefined);
        if (this.at(SyntaxKind.OpenBraceToken)) {
          this.scanBlock(true);
        } else {
          this.match(SyntaxKind.SemicolonToken);
        }
      } finally {
        this.scopes.pop();
      }
      return;
    }

    // Member name (identifier, string, number, private `#foo`, or computed `[expr]`)
    let memberName = "<computed>";
    if (this.at(SyntaxKind.OpenBracketToken)) {
      this.scanBalancedBracketsExpr();
    } else if (isPropertyNameKind(this.peek().kind)) {
      memberName = this.next().text;
    } else {
      this.next();
      return;
    }

    this.match(SyntaxKind.QuestionToken);
    this.match(SyntaxKind.ExclamationToken);

    // Method / accessor if followed by `<` or `(`
    if (
      accessorKind ||
      this.at(SyntaxKind.OpenParenToken) ||
      this.at(SyntaxKind.LessThanToken) ||
      this.at(SyntaxKind.LessThanLessThanToken)
    ) {
      const scopeKind: ScopeKind = accessorKind ?? "method";
      const label =
        accessorKind === "get"
          ? `get ${memberName}()`
          : accessorKind === "set"
            ? `set ${memberName}()`
            : `${memberName}()`;
      this.scopes.push({
        kind: scopeKind,
        label,
        rawName: memberName,
        nonPublic: isNonPublic,
      });
      try {
        if (
          this.at(SyntaxKind.LessThanToken) ||
          this.at(SyntaxKind.LessThanLessThanToken)
        ) {
          this.parseTypeParameterList();
        }
        if (this.at(SyntaxKind.OpenParenToken)) {
          this.scanParameterList(undefined);
        }
        if (this.match(SyntaxKind.ColonToken)) {
          const retNode = this.makeContextNode(
            "ReturnType",
            memberStart,
            this.peek().end,
            { name: memberName },
          );
          const rt = this.parseReturnType(retNode);
          retNode.end = rt.end;
        }
        if (this.at(SyntaxKind.OpenBraceToken)) {
          this.scanBlock(true);
        } else {
          this.match(SyntaxKind.SemicolonToken);
        }
      } finally {
        this.scopes.pop();
      }
      return;
    }

    // Property declaration
    this.scopes.push({
      kind: "property",
      label: memberName,
      rawName: memberName,
      symbolName: memberName,
      nonPublic: isNonPublic,
    });
    try {
      if (this.match(SyntaxKind.ColonToken)) {
        const propNode = this.makeContextNode(
          "Property",
          memberStart,
          this.peek().end,
          { name: memberName, symbolName: memberName },
        );
        const t = this.parseType(propNode);
        propNode.end = t.end;
      }
      if (this.match(SyntaxKind.EqualsToken)) {
        // Initializer expressions on exported class fields have no Block ancestor
        // (only arrow-body scopes if an arrow function); scan normally.
        this.scanExpressionUntilStatementEnd();
      } else {
        this.match(SyntaxKind.SemicolonToken);
      }
    } finally {
      this.scopes.pop();
    }
  }

  private scanFunction(isExported: boolean, isExpression = false): void {
    const startTok = this.next(); // function
    this.match(SyntaxKind.AsteriskToken);
    let name: string | undefined;
    if (isWordLike(this.peek().kind)) {
      name = this.next().text;
    }
    this.scopes.push({
      kind: "function",
      label: isExpression
        ? undefined
        : `function ${name ?? "<anon>"}()`,
      rawName: name ?? "unknown",
      exported: isExported,
    });
    try {
      if (
        this.at(SyntaxKind.LessThanToken) ||
        this.at(SyntaxKind.LessThanLessThanToken)
      ) {
        this.parseTypeParameterList();
      }
      if (this.at(SyntaxKind.OpenParenToken)) {
        this.scanParameterList(undefined);
      }
      if (this.match(SyntaxKind.ColonToken)) {
        const retNode = this.makeContextNode(
          "ReturnType",
          startTok.start,
          this.peek().end,
          { name },
        );
        const rt = this.parseReturnType(retNode);
        retNode.end = rt.end;
      }
      if (this.at(SyntaxKind.OpenBraceToken)) {
        this.scanBlock(true);
      } else {
        this.match(SyntaxKind.SemicolonToken);
      }
    } finally {
      this.scopes.pop();
    }
  }

  private scanVariableStatement(isExported: boolean): void {
    this.next(); // const / let / var
    while (!this.atEof()) {
      const before = this.pos;
      const declStart = this.peek().start;
      const varName = this.scanBindingName();
      this.match(SyntaxKind.ExclamationToken);

      this.scopes.push({
        kind: "variable",
        label: varName,
        rawName: varName,
        symbolName: varName,
        exported: isExported,
      });
      try {
        if (this.match(SyntaxKind.ColonToken)) {
          const varNode = this.makeContextNode(
            "Variable",
            declStart,
            this.peek().end,
            { name: varName, symbolName: varName },
          );
          const t = this.parseType(varNode);
          varNode.end = t.end;
        }
        if (this.match(SyntaxKind.EqualsToken)) {
          this.scanExpression(true, false);
        }
      } finally {
        this.scopes.pop();
      }

      if (!this.match(SyntaxKind.CommaToken)) break;
      if (this.pos === before) break;
    }
    this.match(SyntaxKind.SemicolonToken);
  }

  private scanBindingName(): string {
    if (this.at(SyntaxKind.OpenBraceToken)) {
      const start = this.peek().start;
      this.skipBalancedBracesWithDefaults();
      const end = this.tokens[Math.max(0, this.pos - 1)]!.end;
      return this.source.slice(start, end).replace(/\s+/g, " ").slice(0, 40);
    }
    if (this.at(SyntaxKind.OpenBracketToken)) {
      const start = this.peek().start;
      this.skipBalancedBracketsWithDefaults();
      const end = this.tokens[Math.max(0, this.pos - 1)]!.end;
      return this.source.slice(start, end).replace(/\s+/g, " ").slice(0, 40);
    }
    if (isWordLike(this.peek().kind)) {
      return this.next().text;
    }
    return "<binding>";
  }

  private skipBalancedBracesWithDefaults(): void {
    if (!this.match(SyntaxKind.OpenBraceToken)) return;
    let depth = 1;
    while (!this.atEof() && depth > 0) {
      const k = this.peek().kind;
      if (k === SyntaxKind.OpenBraceToken) {
        depth++;
        this.next();
      } else if (k === SyntaxKind.CloseBraceToken) {
        depth--;
        this.next();
      } else if (k === SyntaxKind.EqualsToken) {
        this.next();
        this.scanExpression(true, true);
      } else {
        this.next();
      }
    }
  }

  private skipBalancedBracketsWithDefaults(): void {
    if (!this.match(SyntaxKind.OpenBracketToken)) return;
    let depth = 1;
    while (!this.atEof() && depth > 0) {
      const k = this.peek().kind;
      if (k === SyntaxKind.OpenBracketToken) {
        depth++;
        this.next();
      } else if (k === SyntaxKind.CloseBracketToken) {
        depth--;
        this.next();
      } else if (k === SyntaxKind.EqualsToken) {
        this.next();
        this.scanExpression(true, true);
      } else {
        this.next();
      }
    }
  }

  private scanTryStatement(): void {
    this.next(); // try
    if (this.at(SyntaxKind.OpenBraceToken)) {
      this.scanBlock(true);
    }
    if (this.match(SyntaxKind.CatchKeyword)) {
      if (this.match(SyntaxKind.OpenParenToken)) {
        const start = this.peek().start;
        const name = this.scanBindingName();
        if (this.match(SyntaxKind.ColonToken)) {
          const catchNode = this.makeContextNode(
            "CatchClause",
            start,
            this.peek().end,
            { name, symbolName: name },
          );
          const t = this.parseType(catchNode);
          catchNode.end = t.end;
        }
        this.match(SyntaxKind.CloseParenToken);
      }
      if (this.at(SyntaxKind.OpenBraceToken)) {
        this.scanBlock(true);
      }
    }
    if (this.match(SyntaxKind.FinallyKeyword)) {
      if (this.at(SyntaxKind.OpenBraceToken)) {
        this.scanBlock(true);
      }
    }
  }

  private scanForStatement(inBlock: boolean): void {
    this.next(); // for
    this.match(SyntaxKind.AwaitKeyword);
    if (this.match(SyntaxKind.OpenParenToken)) {
      if (
        this.at(SyntaxKind.ConstKeyword) ||
        this.at(SyntaxKind.LetKeyword) ||
        this.at(SyntaxKind.VarKeyword)
      ) {
        this.next();
        const declStart = this.peek().start;
        const varName = this.scanBindingName();
        if (this.match(SyntaxKind.ColonToken)) {
          const varNode = this.makeContextNode(
            "Variable",
            declStart,
            this.peek().end,
            { name: varName, symbolName: varName },
          );
          const t = this.parseType(varNode);
          varNode.end = t.end;
        }
      }
      let parenDepth = 1;
      while (!this.atEof() && parenDepth > 0) {
        const before = this.pos;
        if (this.at(SyntaxKind.OpenParenToken)) {
          parenDepth++;
          this.next();
        } else if (this.at(SyntaxKind.CloseParenToken)) {
          parenDepth--;
          this.next();
        } else {
          this.scanExpressionToken(true);
        }
        if (this.pos === before) this.pos++;
      }
    }
    this.scanStatement(inBlock);
  }

  private scanSwitchStatement(): void {
    this.next(); // switch
    if (this.at(SyntaxKind.OpenParenToken)) {
      this.scanBalancedParensExpr();
    }
    if (this.match(SyntaxKind.OpenBraceToken)) {
      this.scopes.push({ kind: "block" });
      try {
        while (!this.atEof() && !this.at(SyntaxKind.CloseBraceToken)) {
          const before = this.pos;
          if (this.match(SyntaxKind.CaseKeyword)) {
            while (
              !this.atEof() &&
              !this.at(SyntaxKind.ColonToken) &&
              !this.at(SyntaxKind.CloseBraceToken)
            ) {
              const innerBefore = this.pos;
              this.scanExpressionToken(true);
              if (this.pos === innerBefore) this.pos++;
            }
            this.match(SyntaxKind.ColonToken);
          } else if (
            this.at(SyntaxKind.DefaultKeyword) &&
            this.at(SyntaxKind.ColonToken, 1)
          ) {
            this.next();
            this.next();
          } else {
            this.scanStatement(true);
          }
          if (this.pos === before) this.pos++;
        }
        this.match(SyntaxKind.CloseBraceToken);
      } finally {
        this.scopes.pop();
      }
    }
  }

  // ─── Parameter Lists & Index Signatures ──────────────────────────────────

  private scanParameterList(parentFuncType: TypeNode | undefined): void {
    if (!this.match(SyntaxKind.OpenParenToken)) return;

    while (!this.atEof() && !this.at(SyntaxKind.CloseParenToken)) {
      const before = this.pos;
      const paramStart = this.peek().start;

      while (this.at(SyntaxKind.AtToken)) {
        this.scanDecorator();
      }
      while (PARAM_MODIFIERS.has(this.peek().kind)) {
        this.next();
      }

      const isRest = this.match(SyntaxKind.DotDotDotToken);
      const paramName = this.scanBindingName();
      this.match(SyntaxKind.QuestionToken);

      const paramNode = this.makeContextNode(
        "Parameter",
        paramStart,
        this.peek().end,
        {
          name: paramName,
          symbolName: paramName,
          isRest,
          parent: parentFuncType,
        },
      );

      this.scopes.push({
        kind: "parameter",
        symbolName: paramName,
      });
      try {
        if (this.match(SyntaxKind.ColonToken)) {
          const t = this.parseType(paramNode);
          paramNode.end = t.end;
        }
        if (this.match(SyntaxKind.EqualsToken)) {
          // Default parameter initializer
          this.scanExpression(true, true);
          paramNode.end = this.tokens[Math.max(0, this.pos - 1)]!.end;
        }
      } finally {
        this.scopes.pop();
      }

      if (!this.match(SyntaxKind.CommaToken)) {
        if (!this.at(SyntaxKind.CloseParenToken) && this.pos === before) {
          this.pos++;
        }
      }
    }

    this.match(SyntaxKind.CloseParenToken);
  }

  private looksLikeIndexSignature(startIdx: number): boolean {
    if (this.tokens[startIdx]?.kind !== SyntaxKind.OpenBracketToken) {
      return false;
    }
    let i = startIdx + 1;
    // `[key: string]: T`
    if (!isWordLike(this.tokens[i]?.kind ?? SyntaxKind.Unknown)) return false;
    i++;
    if (this.tokens[i]?.kind !== SyntaxKind.ColonToken) return false;
    // Find matching `]` and check `:` right after `]`
    let depth = 1;
    while (i < this.tokens.length && depth > 0) {
      const k = this.tokens[i]!.kind;
      if (k === SyntaxKind.OpenBracketToken) depth++;
      else if (k === SyntaxKind.CloseBracketToken) depth--;
      i++;
    }
    return this.tokens[i]?.kind === SyntaxKind.ColonToken;
  }

  private scanIndexSignature(memberStart: number, isNonPublic: boolean): void {
    this.scopes.push({ kind: "property", nonPublic: isNonPublic });
    try {
      const idxNode = this.makeContextNode(
        "IndexSignature",
        memberStart,
        this.peek().end,
      );
      this.next(); // [
      if (isWordLike(this.peek().kind)) this.next(); // key name
      if (this.match(SyntaxKind.ColonToken)) {
        this.parseType(idxNode);
      }
      this.match(SyntaxKind.CloseBracketToken);
      if (this.match(SyntaxKind.ColonToken)) {
        const valType = this.parseType(idxNode);
        idxNode.end = valType.end;
      }
      this.match(SyntaxKind.SemicolonToken) ||
        this.match(SyntaxKind.CommaToken);
    } finally {
      this.scopes.pop();
    }
  }

  // ─── Type Parameters `<T extends C = D, ...>` ────────────────────────────

  private parseTypeParameterList(): void {
    this.splitOpeningAngleIfNeeded();
    if (!this.match(SyntaxKind.LessThanToken)) return;

    const ownerName = this.nearestGenericOwnerName();

    while (!this.atEof() && !this.atClosingAngle()) {
      const before = this.pos;
      const tpStart = this.peek().start;

      // Optional `const`, `in`, `out` variance modifiers
      while (
        this.at(SyntaxKind.ConstKeyword) ||
        this.at(SyntaxKind.InKeyword) ||
        this.peek().text === "out"
      ) {
        if (
          this.at(SyntaxKind.CommaToken, 1) ||
          this.at(SyntaxKind.ExtendsKeyword, 1) ||
          this.at(SyntaxKind.EqualsToken, 1) ||
          this.peek(1).kind === SyntaxKind.GreaterThanToken ||
          this.peek(1).kind === SyntaxKind.GreaterThanGreaterThanToken
        ) {
          break;
        }
        this.next();
      }

      if (!isWordLike(this.peek().kind)) {
        this.next();
        continue;
      }

      const nameTok = this.next();
      const paramName = nameTok.text;
      const tpNode = this.makeContextNode(
        "TypeParameter",
        tpStart,
        nameTok.end,
        { name: paramName },
      );

      if (this.match(SyntaxKind.ExtendsKeyword)) {
        const constraintNode: TypeNode = {
          role: "TypeParameterConstraint",
          start: tpStart,
          end: this.peek().end,
          name: paramName,
          parent: tpNode,
          isPublicApi: tpNode.isPublicApi,
          enclosing: tpNode.enclosing,
          symbolName: tpNode.symbolName,
        };
        const ct = this.parseType(constraintNode);
        constraintNode.end = ct.end;
        tpNode.end = ct.end;
      }

      if (this.match(SyntaxKind.EqualsToken)) {
        const defaultStartPos = this.peek().start;
        const defaultNode: TypeNode = {
          role: "TypeParameterDefault",
          start: tpStart,
          end: this.peek().end,
          name: paramName,
          parent: tpNode,
          isPublicApi: tpNode.isPublicApi,
          enclosing: tpNode.enclosing,
          symbolName: tpNode.symbolName,
        };
        const dt = this.parseType(defaultNode);
        defaultNode.end = dt.end;
        tpNode.end = dt.end;

        const defaultText = this.source
          .slice(defaultStartPos, dt.end)
          .trim();
        if (defaultText === "any") {
          const { line } = getLineAndColumnAtPos(
            this.lineStarts,
            nameTok.start,
          );
          this.genericDefaults.push({
            line,
            typeName: ownerName,
            paramName,
            currentDefault: "any",
            context: (this.lines[line - 1] ?? "").trim().slice(0, 80),
          });
        }
      }

      if (!this.match(SyntaxKind.CommaToken)) {
        if (!this.atClosingAngle() && this.pos === before) {
          this.pos++;
        }
      }
    }

    if (this.atClosingAngle()) {
      this.consumeClosingAngle();
    }
  }

  // ─── Type Grammar Parser ─────────────────────────────────────────────────

  private parseReturnType(parentNode: TypeNode): TypeNode {
    // Handle `asserts x is T`, `asserts x`, or `x is T` / `this is T`
    if (this.at(SyntaxKind.AssertsKeyword)) {
      const start = this.next().start;
      if (isWordLike(this.peek().kind) || this.at(SyntaxKind.ThisKeyword)) {
        this.next();
      }
      if (this.match(SyntaxKind.IsKeyword)) {
        const predTarget = this.parseType(parentNode);
        return {
          role: "Other",
          start,
          end: predTarget.end,
          parent: parentNode,
        };
      }
      return {
        role: "Other",
        start,
        end: this.tokens[Math.max(0, this.pos - 1)]!.end,
        parent: parentNode,
      };
    }

    if (
      (isWordLike(this.peek().kind) || this.at(SyntaxKind.ThisKeyword)) &&
      this.at(SyntaxKind.IsKeyword, 1)
    ) {
      const start = this.next().start;
      this.next(); // is
      const predTarget = this.parseType(parentNode);
      return {
        role: "Other",
        start,
        end: predTarget.end,
        parent: parentNode,
      };
    }

    return this.parseType(parentNode);
  }

  private parseType(parentNode: TypeNode): TypeNode {
    const startTok = this.peek();

    // Constructor type: `abstract? new <...>(...) => ReturnType`
    if (
      (this.at(SyntaxKind.AbstractKeyword) &&
        this.at(SyntaxKind.NewKeyword, 1)) ||
      this.at(SyntaxKind.NewKeyword)
    ) {
      return this.parseConstructorType(parentNode);
    }

    // Function type: `<...>(...) => ReturnType` or `(...) => ReturnType`
    if (this.looksLikeFunctionType(this.pos)) {
      return this.parseFunctionType(parentNode);
    }

    // Check type (union / intersection)
    const checkType = this.parseUnionOrIntersectionType(parentNode);

    // Conditional type: `CheckType extends ExtendsType ? TrueType : FalseType`
    if (this.at(SyntaxKind.ExtendsKeyword)) {
      const savedPos = this.pos;
      this.next(); // extends

      const condExtNode = this.makeContextNode(
        "ConditionalExtends",
        this.peek().start,
        this.peek().end,
        { parent: parentNode },
      );
      const extType = this.parseUnionOrIntersectionType(condExtNode);
      condExtNode.end = extType.end;

      if (this.match(SyntaxKind.QuestionToken)) {
        this.parseType(parentNode);
        if (this.match(SyntaxKind.ColonToken)) {
          const falseType = this.parseType(parentNode);
          return {
            role: "Other",
            start: startTok.start,
            end: falseType.end,
            parent: parentNode,
          };
        }
        return {
          role: "Other",
          start: startTok.start,
          end: this.tokens[Math.max(0, this.pos - 1)]!.end,
          parent: parentNode,
        };
      } else {
        // Not actually a conditional type (e.g. `extends` keyword in another construct)
        // Rewind would duplicate hits if any were recorded; only happens if malformed.
        this.pos = savedPos;
      }
    }

    return checkType;
  }

  private looksLikeFunctionType(startIdx: number): boolean {
    let i = startIdx;
    // Optional `<...>` generic type parameters
    if (
      this.tokens[i]?.kind === SyntaxKind.LessThanToken ||
      this.tokens[i]?.kind === SyntaxKind.LessThanLessThanToken
    ) {
      let angleDepth = 0;
      let parenDepth = 0;
      let braceDepth = 0;
      let bracketDepth = 0;
      while (i < this.tokens.length) {
        const k = this.tokens[i]!.kind;
        if (k === SyntaxKind.EndOfFileToken) return false;
        if (k === SyntaxKind.OpenParenToken) parenDepth++;
        else if (k === SyntaxKind.CloseParenToken) parenDepth--;
        else if (k === SyntaxKind.OpenBraceToken) braceDepth++;
        else if (k === SyntaxKind.CloseBraceToken) braceDepth--;
        else if (k === SyntaxKind.OpenBracketToken) bracketDepth++;
        else if (k === SyntaxKind.CloseBracketToken) bracketDepth--;
        else if (
          parenDepth === 0 &&
          braceDepth === 0 &&
          bracketDepth === 0
        ) {
          if (k === SyntaxKind.LessThanToken) angleDepth++;
          else if (k === SyntaxKind.LessThanLessThanToken) angleDepth += 2;
          else if (k === SyntaxKind.GreaterThanToken) angleDepth--;
          else if (k === SyntaxKind.GreaterThanGreaterThanToken)
            angleDepth -= 2;
          else if (k === SyntaxKind.GreaterThanGreaterThanGreaterThanToken)
            angleDepth -= 3;
          else if (k === SyntaxKind.GreaterThanEqualsToken) angleDepth--;
          if (angleDepth <= 0) {
            i++;
            break;
          }
        }
        i++;
      }
    }

    if (this.tokens[i]?.kind !== SyntaxKind.OpenParenToken) return false;
    let depth = 0;
    while (i < this.tokens.length) {
      const k = this.tokens[i]!.kind;
      if (k === SyntaxKind.EndOfFileToken) return false;
      if (k === SyntaxKind.OpenParenToken) depth++;
      else if (k === SyntaxKind.CloseParenToken) {
        depth--;
        if (depth === 0) {
          return this.tokens[i + 1]?.kind === SyntaxKind.EqualsGreaterThanToken;
        }
      }
      i++;
    }
    return false;
  }

  private parseConstructorType(parentNode: TypeNode): TypeNode {
    const start = this.peek().start;
    this.match(SyntaxKind.AbstractKeyword);
    this.next(); // new
    const ctorNode = this.makeContextNode(
      "ConstructorType",
      start,
      this.peek().end,
      { parent: parentNode },
    );
    if (
      this.at(SyntaxKind.LessThanToken) ||
      this.at(SyntaxKind.LessThanLessThanToken)
    ) {
      this.parseTypeParameterList();
    }
    if (this.at(SyntaxKind.OpenParenToken)) {
      this.scanParameterList(ctorNode);
    }
    if (this.match(SyntaxKind.EqualsGreaterThanToken)) {
      const ret = this.parseReturnType(ctorNode);
      ctorNode.end = ret.end;
    }
    return ctorNode;
  }

  private parseFunctionType(parentNode: TypeNode): TypeNode {
    const start = this.peek().start;
    const fnNode = this.makeContextNode(
      "FunctionType",
      start,
      this.peek().end,
      { parent: parentNode },
    );
    if (
      this.at(SyntaxKind.LessThanToken) ||
      this.at(SyntaxKind.LessThanLessThanToken)
    ) {
      this.parseTypeParameterList();
    }
    if (this.at(SyntaxKind.OpenParenToken)) {
      this.scanParameterList(fnNode);
    }
    if (this.match(SyntaxKind.EqualsGreaterThanToken)) {
      const ret = this.parseReturnType(fnNode);
      fnNode.end = ret.end;
    }
    return fnNode;
  }

  private parseUnionOrIntersectionType(parentNode: TypeNode): TypeNode {
    // Allow leading `|` or `&`
    const leadingBar = this.match(SyntaxKind.BarToken);
    const leadingAmp = !leadingBar && this.match(SyntaxKind.AmpersandToken);

    const first = this.parseIntersectionOrPrimary(parentNode, leadingAmp);
    if (!this.at(SyntaxKind.BarToken)) {
      return first;
    }

    const parts: TypeNode[] = [first];
    while (this.match(SyntaxKind.BarToken)) {
      parts.push(this.parseIntersectionOrPrimary(parentNode, false));
    }

    const unionNode = this.makeContextNode(
      "UnionType",
      parts[0]!.start,
      parts[parts.length - 1]!.end,
      { parent: parentNode },
    );
    for (const p of parts) {
      p.parent = unionNode;
    }
    return unionNode;
  }

  private parseIntersectionOrPrimary(
    parentNode: TypeNode,
    hadLeadingAmp: boolean,
  ): TypeNode {
    const first = this.parseTypeOperatorOrPostfix(parentNode);
    if (!this.at(SyntaxKind.AmpersandToken) && !hadLeadingAmp) {
      return first;
    }
    if (!this.at(SyntaxKind.AmpersandToken)) {
      return first;
    }

    const parts: TypeNode[] = [first];
    while (this.match(SyntaxKind.AmpersandToken)) {
      parts.push(this.parseTypeOperatorOrPostfix(parentNode));
    }

    const interNode = this.makeContextNode(
      "IntersectionType",
      parts[0]!.start,
      parts[parts.length - 1]!.end,
      { parent: parentNode },
    );
    for (const p of parts) {
      p.parent = interNode;
    }
    return interNode;
  }

  private parseTypeOperatorOrPostfix(parentNode: TypeNode): TypeNode {
    const k = this.peek().kind;

    // `keyof T`, `readonly T`, `unique symbol`
    if (
      k === SyntaxKind.KeyOfKeyword ||
      k === SyntaxKind.ReadonlyKeyword ||
      k === SyntaxKind.UniqueKeyword
    ) {
      const start = this.next().start;
      const opNode = this.makeContextNode(
        "TypeOperator",
        start,
        this.peek().end,
        { parent: parentNode },
      );
      const inner = this.parseTypeOperatorOrPostfix(opNode);
      opNode.end = inner.end;
      return opNode;
    }

    // `infer R` / `infer R extends Constraint`
    if (k === SyntaxKind.InferKeyword) {
      const start = this.next().start;
      if (isWordLike(this.peek().kind)) this.next();
      let end = this.tokens[Math.max(0, this.pos - 1)]!.end;
      if (this.match(SyntaxKind.ExtendsKeyword)) {
        const c = this.parseTypeOperatorOrPostfix(parentNode);
        end = c.end;
      }
      return { role: "Other", start, end, parent: parentNode };
    }

    // `typeof Foo.bar<T>`
    if (k === SyntaxKind.TypeOfKeyword) {
      const start = this.next().start;
      if (this.at(SyntaxKind.ImportKeyword)) {
        this.parseImportType(parentNode);
      } else {
        while (
          isWordLike(this.peek().kind) ||
          this.at(SyntaxKind.ThisKeyword)
        ) {
          this.next();
          if (!this.match(SyntaxKind.DotToken)) break;
        }
      }
      if (
        this.at(SyntaxKind.LessThanToken) ||
        this.at(SyntaxKind.LessThanLessThanToken)
      ) {
        const refNode = this.makeContextNode(
          "TypeReference",
          start,
          this.peek().end,
          { parent: parentNode },
        );
        this.parseTypeArgumentList(refNode);
        refNode.end = this.tokens[Math.max(0, this.pos - 1)]!.end;
      }
      return this.parsePostfixType(
        {
          role: "Other",
          start,
          end: this.tokens[Math.max(0, this.pos - 1)]!.end,
          parent: parentNode,
        },
        parentNode,
      );
    }

    // Function / constructor types inside unions/intersections: `string | ((...args: any[]) => void)`
    if (
      (k === SyntaxKind.AbstractKeyword &&
        this.at(SyntaxKind.NewKeyword, 1)) ||
      k === SyntaxKind.NewKeyword
    ) {
      return this.parseConstructorType(parentNode);
    }
    if (this.looksLikeFunctionType(this.pos)) {
      return this.parseFunctionType(parentNode);
    }

    const primary = this.parsePrimaryType(parentNode);
    return this.parsePostfixType(primary, parentNode);
  }

  private parsePostfixType(
    baseNode: TypeNode,
    parentNode: TypeNode,
  ): TypeNode {
    let current = baseNode;
    while (this.at(SyntaxKind.OpenBracketToken)) {
      // `T[]` ArrayType vs `T[K]` IndexedAccessType
      if (this.at(SyntaxKind.CloseBracketToken, 1)) {
        this.next(); // [
        const closeTok = this.next(); // ]
        const arrNode = this.makeContextNode(
          "ArrayType",
          current.start,
          closeTok.end,
          { parent: parentNode },
        );
        current.parent = arrNode;
        current = arrNode;
      } else {
        this.next(); // [
        const idxContainer = this.makeContextNode(
          "Other",
          current.start,
          this.peek().end,
          { parent: parentNode },
        );
        this.parseType(idxContainer);
        const closeTok = this.match(SyntaxKind.CloseBracketToken)
          ? this.tokens[this.pos - 1]!
          : this.peek();
        idxContainer.end = closeTok.end;
        current = idxContainer;
      }
    }
    return current;
  }

  private parsePrimaryType(parentNode: TypeNode): TypeNode {
    const tok = this.peek();

    // `any` or `unknown` keyword — RECORD!
    if (
      tok.kind === SyntaxKind.AnyKeyword ||
      tok.kind === SyntaxKind.UnknownKeyword
    ) {
      this.next();
      const kwNode = this.makeContextNode(
        tok.kind === SyntaxKind.AnyKeyword ? "AnyKeyword" : "UnknownKeyword",
        tok.start,
        tok.end,
        { parent: parentNode },
      );
      this.keywordNodes.push(kwNode);
      return kwNode;
    }

    // Parenthesized type: `(T)`
    if (tok.kind === SyntaxKind.OpenParenToken) {
      const start = this.next().start;
      const parenNode = this.makeContextNode(
        "ParenthesizedType",
        start,
        start,
        { parent: parentNode },
      );
      if (!this.at(SyntaxKind.CloseParenToken)) {
        this.parseType(parenNode);
      }
      const closeTok = this.match(SyntaxKind.CloseParenToken)
        ? this.tokens[this.pos - 1]!
        : this.peek();
      parenNode.end = closeTok.end;
      return parenNode;
    }

    // Tuple type: `[string, any, ...unknown[]]` / `[name: any, opt?: unknown]`
    if (tok.kind === SyntaxKind.OpenBracketToken) {
      const start = this.next().start;
      const tupleNode = this.makeContextNode("Other", start, start, {
        parent: parentNode,
      });
      while (!this.atEof() && !this.at(SyntaxKind.CloseBracketToken)) {
        const before = this.pos;
        this.match(SyntaxKind.DotDotDotToken);
        // Named tuple member `label?: Type`
        if (
          isWordLike(this.peek().kind) &&
          (this.at(SyntaxKind.ColonToken, 1) ||
            (this.at(SyntaxKind.QuestionToken, 1) &&
              this.at(SyntaxKind.ColonToken, 2)))
        ) {
          this.next();
          this.match(SyntaxKind.QuestionToken);
          this.next(); // :
        }
        this.parseType(tupleNode);
        this.match(SyntaxKind.QuestionToken);
        if (!this.match(SyntaxKind.CommaToken)) {
          if (!this.at(SyntaxKind.CloseBracketToken) && this.pos === before) {
            this.pos++;
          }
        }
      }
      const closeTok = this.match(SyntaxKind.CloseBracketToken)
        ? this.tokens[this.pos - 1]!
        : this.peek();
      tupleNode.end = closeTok.end;
      return tupleNode;
    }

    // Type literal / mapped type: `{ ... }`
    if (tok.kind === SyntaxKind.OpenBraceToken) {
      const start = tok.start;
      const litNode = this.makeContextNode("Other", start, start, {
        parent: parentNode,
      });
      this.scanTypeLiteralMembers(litNode, false);
      litNode.end = this.tokens[Math.max(0, this.pos - 1)]!.end;
      return litNode;
    }

    // `import("mod").Foo<T>`
    if (tok.kind === SyntaxKind.ImportKeyword) {
      return this.parseImportType(parentNode);
    }

    // Template literal type: `` `prefix-${T}` ``
    if (tok.kind === SyntaxKind.TemplateHead) {
      const start = this.next().start;
      while (!this.atEof()) {
        this.parseType(parentNode);
        if (this.at(SyntaxKind.TemplateTail)) {
          const tail = this.next();
          return {
            role: "Other",
            start,
            end: tail.end,
            parent: parentNode,
          };
        }
        if (this.at(SyntaxKind.TemplateMiddle)) {
          this.next();
        } else {
          break;
        }
      }
      return {
        role: "Other",
        start,
        end: this.tokens[Math.max(0, this.pos - 1)]!.end,
        parent: parentNode,
      };
    }

    // Literal types (`"foo"`, `123`, `-1`, `true`, `false`, `null`, `undefined`, template)
    if (
      tok.kind === SyntaxKind.StringLiteral ||
      tok.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
      tok.kind === SyntaxKind.NumericLiteral ||
      tok.kind === SyntaxKind.BigIntLiteral ||
      tok.kind === SyntaxKind.TrueKeyword ||
      tok.kind === SyntaxKind.FalseKeyword ||
      tok.kind === SyntaxKind.NullKeyword ||
      tok.kind === SyntaxKind.UndefinedKeyword ||
      tok.kind === SyntaxKind.VoidKeyword ||
      tok.kind === SyntaxKind.NeverKeyword ||
      tok.kind === SyntaxKind.StringKeyword ||
      tok.kind === SyntaxKind.NumberKeyword ||
      tok.kind === SyntaxKind.BooleanKeyword ||
      tok.kind === SyntaxKind.BigIntKeyword ||
      tok.kind === SyntaxKind.SymbolKeyword ||
      tok.kind === SyntaxKind.ObjectKeyword ||
      tok.kind === SyntaxKind.ThisKeyword
    ) {
      this.next();
      return {
        role: "Other",
        start: tok.start,
        end: tok.end,
        parent: parentNode,
      };
    }

    // Negative numeric literal type `-1`
    if (
      (tok.kind === SyntaxKind.MinusToken ||
        tok.kind === SyntaxKind.PlusToken) &&
      (this.at(SyntaxKind.NumericLiteral, 1) ||
        this.at(SyntaxKind.BigIntLiteral, 1))
    ) {
      this.next();
      const num = this.next();
      return {
        role: "Other",
        start: tok.start,
        end: num.end,
        parent: parentNode,
      };
    }

    // Type reference: `Foo`, `ns.Foo`, `Record<string, any>`, `Promise<unknown>`
    if (isWordLike(tok.kind)) {
      const start = tok.start;
      let name = this.next().text;
      while (
        this.at(SyntaxKind.DotToken) &&
        isWordLike(this.peek(1).kind)
      ) {
        this.next();
        name += "." + this.next().text;
      }
      const endAfterName = this.tokens[Math.max(0, this.pos - 1)]!.end;
      const refNode = this.makeContextNode(
        "TypeReference",
        start,
        endAfterName,
        { name, parent: parentNode },
      );

      if (
        this.at(SyntaxKind.LessThanToken) ||
        this.at(SyntaxKind.LessThanLessThanToken)
      ) {
        this.parseTypeArgumentList(refNode);
        refNode.end = this.tokens[Math.max(0, this.pos - 1)]!.end;
      }
      return refNode;
    }

    // Fallback: don't stall on unexpected token
    return {
      role: "Other",
      start: tok.start,
      end: tok.start,
      parent: parentNode,
    };
  }

  private parseImportType(parentNode: TypeNode): TypeNode {
    const start = this.next().start; // import
    if (this.at(SyntaxKind.OpenParenToken)) {
      this.scanBalancedParensExpr();
    }
    let name = "import";
    while (this.at(SyntaxKind.DotToken) && isWordLike(this.peek(1).kind)) {
      this.next();
      name = this.next().text;
    }
    const refNode = this.makeContextNode(
      "TypeReference",
      start,
      this.tokens[Math.max(0, this.pos - 1)]!.end,
      { name, parent: parentNode },
    );
    if (
      this.at(SyntaxKind.LessThanToken) ||
      this.at(SyntaxKind.LessThanLessThanToken)
    ) {
      this.parseTypeArgumentList(refNode);
      refNode.end = this.tokens[Math.max(0, this.pos - 1)]!.end;
    }
    return refNode;
  }

  private parseTypeArgumentList(parentRef: TypeNode | undefined): void {
    this.splitOpeningAngleIfNeeded();
    if (!this.match(SyntaxKind.LessThanToken)) return;

    const container =
      parentRef ??
      this.makeContextNode("TypeReference", this.peek().start, this.peek().end);

    while (!this.atEof() && !this.atClosingAngle()) {
      const before = this.pos;
      this.parseType(container);
      if (!this.match(SyntaxKind.CommaToken)) {
        if (!this.atClosingAngle() && this.pos === before) {
          this.pos++;
        }
      }
    }

    if (this.atClosingAngle()) {
      const closeTok = this.consumeClosingAngle();
      container.end = closeTok.end;
    }
  }

  private scanTypeLiteralMembers(
    parentLit: TypeNode | undefined,
    isInterfaceBody: boolean,
  ): void {
    if (!this.match(SyntaxKind.OpenBraceToken)) return;

    while (!this.atEof() && !this.at(SyntaxKind.CloseBraceToken)) {
      const before = this.pos;
      if (
        this.match(SyntaxKind.SemicolonToken) ||
        this.match(SyntaxKind.CommaToken)
      ) {
        continue;
      }

      const memberStart = this.peek().start;

      // Mapped type: `[+/-]? readonly? [K in KeyType (as Rename)?][+/-]??: ValueType`
      if (this.looksLikeMappedType(this.pos)) {
        this.scanMappedTypeMember(parentLit);
        continue;
      }

      this.match(SyntaxKind.ReadonlyKeyword);

      // Index signature `[key: string]: any`
      if (
        this.at(SyntaxKind.OpenBracketToken) &&
        this.looksLikeIndexSignature(this.pos)
      ) {
        this.scanIndexSignature(memberStart, false);
        continue;
      }

      // Construct signature `new <...>(...): R`
      if (
        this.at(SyntaxKind.NewKeyword) &&
        (this.at(SyntaxKind.OpenParenToken, 1) ||
          this.at(SyntaxKind.LessThanToken, 1) ||
          this.at(SyntaxKind.LessThanLessThanToken, 1))
      ) {
        this.next();
        if (
          this.at(SyntaxKind.LessThanToken) ||
          this.at(SyntaxKind.LessThanLessThanToken)
        ) {
          this.parseTypeParameterList();
        }
        this.scanParameterList(undefined);
        if (this.match(SyntaxKind.ColonToken)) {
          const retNode = this.makeContextNode(
            "ReturnType",
            memberStart,
            this.peek().end,
          );
          const rt = this.parseReturnType(retNode);
          retNode.end = rt.end;
        }
        this.match(SyntaxKind.SemicolonToken) ||
          this.match(SyntaxKind.CommaToken);
        continue;
      }

      // Call signature `<...>(...): R` or `(...): R`
      if (
        this.at(SyntaxKind.OpenParenToken) ||
        this.at(SyntaxKind.LessThanToken) ||
        this.at(SyntaxKind.LessThanLessThanToken)
      ) {
        if (
          this.at(SyntaxKind.LessThanToken) ||
          this.at(SyntaxKind.LessThanLessThanToken)
        ) {
          this.parseTypeParameterList();
        }
        this.scanParameterList(undefined);
        if (this.match(SyntaxKind.ColonToken)) {
          const retNode = this.makeContextNode(
            "ReturnType",
            memberStart,
            this.peek().end,
          );
          const rt = this.parseReturnType(retNode);
          retNode.end = rt.end;
        }
        this.match(SyntaxKind.SemicolonToken) ||
          this.match(SyntaxKind.CommaToken);
        continue;
      }

      // Optional `get` / `set` accessor signature in interface/type literal
      if (
        (this.at(SyntaxKind.GetKeyword) || this.at(SyntaxKind.SetKeyword)) &&
        isPropertyNameKind(this.peek(1).kind)
      ) {
        this.next();
      }

      // Property or method signature
      let memberName = "<computed>";
      if (this.at(SyntaxKind.OpenBracketToken)) {
        this.scanBalancedBracketsExpr();
      } else if (isPropertyNameKind(this.peek().kind)) {
        memberName = this.next().text;
      } else {
        this.next();
        continue;
      }

      this.match(SyntaxKind.QuestionToken);

      if (
        this.at(SyntaxKind.OpenParenToken) ||
        this.at(SyntaxKind.LessThanToken) ||
        this.at(SyntaxKind.LessThanLessThanToken)
      ) {
        // Method signature
        if (isInterfaceBody) {
          this.scopes.push({
            kind: "method",
            label: `${memberName}()`,
            rawName: memberName,
          });
        }
        try {
          if (
            this.at(SyntaxKind.LessThanToken) ||
            this.at(SyntaxKind.LessThanLessThanToken)
          ) {
            this.parseTypeParameterList();
          }
          if (this.at(SyntaxKind.OpenParenToken)) {
            this.scanParameterList(undefined);
          }
          if (this.match(SyntaxKind.ColonToken)) {
            const retNode = this.makeContextNode(
              "ReturnType",
              memberStart,
              this.peek().end,
              { name: memberName },
            );
            const rt = this.parseReturnType(retNode);
            retNode.end = rt.end;
          }
        } finally {
          if (isInterfaceBody) this.scopes.pop();
        }
      } else if (this.match(SyntaxKind.ColonToken)) {
        // Property signature
        this.scopes.push({
          kind: "property",
          label: isInterfaceBody ? memberName : undefined,
          rawName: memberName,
          symbolName: memberName,
        });
        try {
          const propNode = this.makeContextNode(
            "Property",
            memberStart,
            this.peek().end,
            { name: memberName, symbolName: memberName },
          );
          const t = this.parseType(propNode);
          propNode.end = t.end;
        } finally {
          this.scopes.pop();
        }
      }

      this.match(SyntaxKind.SemicolonToken) ||
        this.match(SyntaxKind.CommaToken);
      if (this.pos === before) this.pos++;
    }

    this.match(SyntaxKind.CloseBraceToken);
  }

  private looksLikeMappedType(startIdx: number): boolean {
    let i = startIdx;
    if (
      this.tokens[i]?.kind === SyntaxKind.PlusToken ||
      this.tokens[i]?.kind === SyntaxKind.MinusToken
    ) {
      i++;
    }
    if (this.tokens[i]?.kind === SyntaxKind.ReadonlyKeyword) {
      i++;
    }
    if (this.tokens[i]?.kind !== SyntaxKind.OpenBracketToken) return false;
    i++;
    if (!isWordLike(this.tokens[i]?.kind ?? SyntaxKind.Unknown)) return false;
    i++;
    return this.tokens[i]?.kind === SyntaxKind.InKeyword;
  }

  private scanMappedTypeMember(parentLit: TypeNode | undefined): void {
    const start = this.peek().start;
    if (this.at(SyntaxKind.PlusToken) || this.at(SyntaxKind.MinusToken)) {
      this.next();
    }
    this.match(SyntaxKind.ReadonlyKeyword);
    this.next(); // [
    if (isWordLike(this.peek().kind)) this.next(); // K
    this.match(SyntaxKind.InKeyword);
    const mapNode = this.makeContextNode("Other", start, this.peek().end, {
      parent: parentLit,
    });
    this.parseType(mapNode);
    if (this.match(SyntaxKind.AsKeyword)) {
      this.parseType(mapNode);
    }
    this.match(SyntaxKind.CloseBracketToken);
    if (this.at(SyntaxKind.PlusToken) || this.at(SyntaxKind.MinusToken)) {
      this.next();
    }
    this.match(SyntaxKind.QuestionToken);
    if (this.match(SyntaxKind.ColonToken)) {
      const vt = this.parseType(mapNode);
      mapNode.end = vt.end;
    }
    this.match(SyntaxKind.SemicolonToken) ||
      this.match(SyntaxKind.CommaToken);
  }

  // ─── Expression Scanning (casts, arrows, generic calls, nested classes/fns) ──

  private scanExpressionUntilStatementEnd(): void {
    this.scanExpression(false, false);
    this.match(SyntaxKind.SemicolonToken);
  }

  private scanExpression(
    stopAtComma: boolean,
    stopAtCloseBracketOrBrace: boolean,
  ): void {
    let prevKind: SyntaxKind = SyntaxKind.SemicolonToken;

    while (!this.atEof()) {
      const tok = this.peek();
      const k = tok.kind;

      if (k === SyntaxKind.SemicolonToken) return;
      if (stopAtComma && k === SyntaxKind.CommaToken) return;
      if (k === SyntaxKind.CloseParenToken) return;
      if (k === SyntaxKind.CloseBraceToken) return;
      if (stopAtCloseBracketOrBrace && k === SyntaxKind.CloseBracketToken) {
        return;
      }

      // ASI: newline before a statement-starting keyword (outside parens/brackets)
      if (
        tok.lineBreakBefore &&
        prevKind !== SyntaxKind.SemicolonToken &&
        prevKind !== SyntaxKind.EqualsToken &&
        prevKind !== SyntaxKind.OpenParenToken &&
        prevKind !== SyntaxKind.OpenBracketToken &&
        prevKind !== SyntaxKind.CommaToken &&
        prevKind !== SyntaxKind.ColonToken &&
        prevKind !== SyntaxKind.QuestionToken &&
        prevKind !== SyntaxKind.EqualsGreaterThanToken &&
        prevKind !== SyntaxKind.PlusToken &&
        prevKind !== SyntaxKind.MinusToken &&
        prevKind !== SyntaxKind.AmpersandAmpersandToken &&
        prevKind !== SyntaxKind.BarBarToken &&
        prevKind !== SyntaxKind.QuestionQuestionToken &&
        prevKind !== SyntaxKind.DotToken &&
        prevKind !== SyntaxKind.QuestionDotToken &&
        (k === SyntaxKind.ExportKeyword ||
          k === SyntaxKind.ImportKeyword ||
          k === SyntaxKind.ConstKeyword ||
          k === SyntaxKind.LetKeyword ||
          k === SyntaxKind.VarKeyword ||
          k === SyntaxKind.InterfaceKeyword ||
          k === SyntaxKind.EnumKeyword ||
          k === SyntaxKind.ReturnKeyword ||
          k === SyntaxKind.IfKeyword ||
          k === SyntaxKind.ForKeyword ||
          k === SyntaxKind.WhileKeyword ||
          k === SyntaxKind.SwitchKeyword ||
          k === SyntaxKind.TryKeyword ||
          k === SyntaxKind.ThrowKeyword ||
          k === SyntaxKind.BreakKeyword ||
          k === SyntaxKind.ContinueKeyword ||
          k === SyntaxKind.AtToken ||
          (k === SyntaxKind.TypeKeyword &&
            isWordLike(this.peek(1).kind) &&
            (this.at(SyntaxKind.EqualsToken, 2) ||
              this.at(SyntaxKind.LessThanToken, 2))))
      ) {
        return;
      }

      const before = this.pos;
      prevKind = this.scanExpressionToken(
        EXPR_PREFIX_ALLOWING_TYPE_ASSERTION.has(prevKind),
      );
      if (this.pos === before) {
        this.pos++;
      }
    }
  }

  private scanExpressionToken(canStartTypeAssertion: boolean): SyntaxKind {
    const tok = this.peek();
    const k = tok.kind;

    // `as <Type>` (including double-cast `expr as unknown as Foo` and `(expr as unknown) as Foo`)
    if (k === SyntaxKind.AsKeyword) {
      this.scanAsOrSatisfies(true);
      return SyntaxKind.Identifier;
    }

    // `satisfies <Type>`
    if (k === SyntaxKind.SatisfiesKeyword) {
      this.scanAsOrSatisfies(false);
      return SyntaxKind.Identifier;
    }

    // `function` expression
    if (k === SyntaxKind.FunctionKeyword) {
      this.scanFunction(false, true);
      return SyntaxKind.CloseBraceToken;
    }

    // `class` expression
    if (k === SyntaxKind.ClassKeyword) {
      this.scanClass(false);
      return SyntaxKind.CloseBraceToken;
    }

    // `async (...) => ...` or `async <T>(...) => ...` or `async function`
    if (k === SyntaxKind.AsyncKeyword) {
      if (this.at(SyntaxKind.FunctionKeyword, 1)) {
        this.next();
        this.scanFunction(false, true);
        return SyntaxKind.CloseBraceToken;
      }
      if (
        (this.at(SyntaxKind.OpenParenToken, 1) ||
          this.at(SyntaxKind.LessThanToken, 1)) &&
        this.looksLikeArrowFunction(this.pos + 1)
      ) {
        this.next();
        this.scanArrowFunction();
        return SyntaxKind.CloseBraceToken;
      }
    }

    // Arrow function `(...): R => ...` or `<T>(...): R => ...`
    if (
      (k === SyntaxKind.OpenParenToken || k === SyntaxKind.LessThanToken) &&
      this.looksLikeArrowFunction(this.pos)
    ) {
      this.scanArrowFunction();
      return SyntaxKind.CloseBraceToken;
    }

    // Angle-bracket type assertion `<any>expr` / `<unknown>expr` in `.ts` (never `.tsx`)
    if (
      !this.isTsx &&
      canStartTypeAssertion &&
      k === SyntaxKind.LessThanToken &&
      this.looksLikeAngleBracketAssertion(this.pos)
    ) {
      this.scanAngleBracketAssertion();
      return SyntaxKind.Identifier;
    }

    // Generic call / instantiation type arguments: `fn<any>(...)`, `new Map<string, unknown>(...)`
    if (
      k === SyntaxKind.LessThanToken &&
      !canStartTypeAssertion &&
      this.looksLikeGenericCallTypeArgs(this.pos)
    ) {
      const containerName = this.getPrecedingIdentName();
      const refNode = this.makeContextNode(
        "TypeReference",
        tok.start,
        tok.end,
        { name: containerName },
      );
      this.parseTypeArgumentList(refNode);
      return SyntaxKind.GreaterThanToken;
    }

    // Parenthesized expression
    if (k === SyntaxKind.OpenParenToken) {
      this.scanBalancedParensExpr();
      return SyntaxKind.CloseParenToken;
    }

    // Array literal or bracket access
    if (k === SyntaxKind.OpenBracketToken) {
      this.scanBalancedBracketsExpr();
      return SyntaxKind.CloseBracketToken;
    }

    // Object literal expression (handles shorthand methods `foo(x: any): any { ... }`)
    if (k === SyntaxKind.OpenBraceToken) {
      this.scanObjectLiteralExpr();
      return SyntaxKind.CloseBraceToken;
    }

    // Template literal with `${expr}` interpolations
    if (k === SyntaxKind.TemplateHead) {
      this.next();
      while (!this.atEof()) {
        this.scanExpression(false, true);
        if (this.at(SyntaxKind.TemplateTail)) {
          this.next();
          break;
        }
        if (this.at(SyntaxKind.TemplateMiddle)) {
          this.next();
        } else {
          break;
        }
      }
      return SyntaxKind.TemplateTail;
    }

    this.next();
    return k;
  }

  private scanAsOrSatisfies(isAs: boolean): void {
    const kwStart = this.peek().start;
    // Capture a short prefix start (the previous token, for readable outerType)
    const exprStart =
      this.pos > 0 ? this.tokens[this.pos - 1]!.start : kwStart;
    this.next(); // as / satisfies

    const castNode = this.makeContextNode(
      isAs ? "AsExpression" : "Other",
      exprStart,
      this.peek().end,
    );
    const t = this.parseType(castNode);
    castNode.end = t.end;

    // Check for double-cast: `(x as unknown) as Foo` or `x as unknown as Foo`
    if (isAs) {
      let look = this.pos;
      while (this.tokens[look]?.kind === SyntaxKind.CloseParenToken) {
        look++;
      }
      if (this.tokens[look]?.kind === SyntaxKind.AsKeyword) {
        castNode.role = "DoubleCast";
        // Extend outerType end slightly past outer `as <NextType>` for display parity
        const outerEnd = this.findSimpleTypeEnd(look + 1);
        if (outerEnd > castNode.end) {
          castNode.end = outerEnd;
        }
      }
    }
  }

  private findSimpleTypeEnd(idx: number): number {
    let i = idx;
    let angle = 0;
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    let end = this.tokens[Math.min(i, this.tokens.length - 1)]?.end ?? 0;
    while (i < this.tokens.length) {
      const tok = this.tokens[i]!;
      const k = tok.kind;
      if (k === SyntaxKind.EndOfFileToken) break;
      if (
        angle === 0 &&
        paren === 0 &&
        bracket === 0 &&
        brace === 0 &&
        (k === SyntaxKind.SemicolonToken ||
          k === SyntaxKind.CommaToken ||
          k === SyntaxKind.CloseParenToken ||
          k === SyntaxKind.CloseBracketToken ||
          k === SyntaxKind.CloseBraceToken ||
          k === SyntaxKind.AsKeyword ||
          (tok.lineBreakBefore && i > idx))
      ) {
        break;
      }
      if (k === SyntaxKind.LessThanToken) angle++;
      else if (k === SyntaxKind.GreaterThanToken && angle > 0) angle--;
      else if (k === SyntaxKind.GreaterThanGreaterThanToken && angle > 0)
        angle = Math.max(0, angle - 2);
      else if (k === SyntaxKind.OpenParenToken) paren++;
      else if (k === SyntaxKind.CloseParenToken && paren > 0) paren--;
      else if (k === SyntaxKind.OpenBracketToken) bracket++;
      else if (k === SyntaxKind.CloseBracketToken && bracket > 0) bracket--;
      else if (k === SyntaxKind.OpenBraceToken) brace++;
      else if (k === SyntaxKind.CloseBraceToken && brace > 0) brace--;
      end = tok.end;
      i++;
    }
    return end;
  }

  private looksLikeAngleBracketAssertion(startIdx: number): boolean {
    if (this.tokens[startIdx]?.kind !== SyntaxKind.LessThanToken) return false;
    let i = startIdx + 1;
    let angleDepth = 1;
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    while (i < this.tokens.length && angleDepth > 0) {
      const k = this.tokens[i]!.kind;
      if (k === SyntaxKind.EndOfFileToken) return false;
      if (
        paren === 0 &&
        brace === 0 &&
        bracket === 0 &&
        INVALID_TYPE_ARG_TOKENS.has(k)
      ) {
        return false;
      }
      if (k === SyntaxKind.OpenParenToken) paren++;
      else if (k === SyntaxKind.CloseParenToken) paren--;
      else if (k === SyntaxKind.OpenBracketToken) bracket++;
      else if (k === SyntaxKind.CloseBracketToken) bracket--;
      else if (k === SyntaxKind.OpenBraceToken) brace++;
      else if (k === SyntaxKind.CloseBraceToken) brace--;
      else if (paren === 0 && brace === 0 && bracket === 0) {
        if (k === SyntaxKind.LessThanToken) angleDepth++;
        else if (k === SyntaxKind.GreaterThanToken) angleDepth--;
        else if (k === SyntaxKind.GreaterThanGreaterThanToken) angleDepth -= 2;
        else if (k === SyntaxKind.GreaterThanGreaterThanGreaterThanToken)
          angleDepth -= 3;
      }
      i++;
    }
    if (angleDepth !== 0) return false;
    const after = this.tokens[i];
    if (!after || after.lineBreakBefore) return false;
    return (
      isWordLike(after.kind) ||
      after.kind === SyntaxKind.OpenParenToken ||
      after.kind === SyntaxKind.OpenBracketToken ||
      after.kind === SyntaxKind.OpenBraceToken ||
      after.kind === SyntaxKind.StringLiteral ||
      after.kind === SyntaxKind.NumericLiteral ||
      after.kind === SyntaxKind.ThisKeyword ||
      after.kind === SyntaxKind.NewKeyword
    );
  }

  private scanAngleBracketAssertion(): void {
    const start = this.next().start; // <
    const assertNode = this.makeContextNode(
      "TypeAssertionExpression",
      start,
      this.peek().end,
    );
    const t = this.parseType(assertNode);
    if (this.atClosingAngle()) {
      const close = this.consumeClosingAngle();
      assertNode.end = close.end;
    } else {
      assertNode.end = t.end;
    }
  }

  private looksLikeArrowFunction(startIdx: number): boolean {
    let i = startIdx;

    // Optional generic `<T, ...>`
    if (this.tokens[i]?.kind === SyntaxKind.LessThanToken) {
      let angleDepth = 1;
      let paren = 0;
      let brace = 0;
      let bracket = 0;
      i++;
      // Must start with identifier or `const`
      if (
        !isWordLike(this.tokens[i]?.kind ?? SyntaxKind.Unknown)
      ) {
        return false;
      }
      while (i < this.tokens.length && angleDepth > 0) {
        const k = this.tokens[i]!.kind;
        if (k === SyntaxKind.EndOfFileToken) return false;
        if (
          paren === 0 &&
          brace === 0 &&
          bracket === 0 &&
          INVALID_TYPE_ARG_TOKENS.has(k)
        ) {
          return false;
        }
        if (k === SyntaxKind.OpenParenToken) paren++;
        else if (k === SyntaxKind.CloseParenToken) paren--;
        else if (k === SyntaxKind.OpenBraceToken) brace++;
        else if (k === SyntaxKind.CloseBraceToken) brace--;
        else if (k === SyntaxKind.OpenBracketToken) bracket++;
        else if (k === SyntaxKind.CloseBracketToken) bracket--;
        else if (paren === 0 && brace === 0 && bracket === 0) {
          if (k === SyntaxKind.LessThanToken) angleDepth++;
          else if (k === SyntaxKind.GreaterThanToken) angleDepth--;
          else if (k === SyntaxKind.GreaterThanGreaterThanToken)
            angleDepth -= 2;
          else if (k === SyntaxKind.GreaterThanGreaterThanGreaterThanToken)
            angleDepth -= 3;
        }
        i++;
      }
      if (angleDepth !== 0) return false;
    }

    if (this.tokens[i]?.kind !== SyntaxKind.OpenParenToken) return false;
    let pDepth = 0;
    while (i < this.tokens.length) {
      const k = this.tokens[i]!.kind;
      if (k === SyntaxKind.EndOfFileToken) return false;
      if (k === SyntaxKind.OpenParenToken) pDepth++;
      else if (k === SyntaxKind.CloseParenToken) {
        pDepth--;
        if (pDepth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    if (pDepth !== 0) return false;

    // Directly `=>`
    if (this.tokens[i]?.kind === SyntaxKind.EqualsGreaterThanToken) return true;

    // Optional return type `: ReturnType =>`
    if (this.tokens[i]?.kind === SyntaxKind.ColonToken) {
      i++;
      let dParen = 0;
      let dBrace = 0;
      let dBracket = 0;
      let dAngle = 0;
      while (i < this.tokens.length) {
        const k = this.tokens[i]!.kind;
        if (k === SyntaxKind.EndOfFileToken) return false;
        if (
          dParen === 0 &&
          dBrace === 0 &&
          dBracket === 0 &&
          dAngle === 0
        ) {
          if (k === SyntaxKind.EqualsGreaterThanToken) return true;
          if (
            k === SyntaxKind.SemicolonToken ||
            k === SyntaxKind.CommaToken ||
            k === SyntaxKind.CloseParenToken ||
            k === SyntaxKind.CloseBracketToken ||
            k === SyntaxKind.CloseBraceToken ||
            k === SyntaxKind.EqualsToken
          ) {
            return false;
          }
        }
        if (k === SyntaxKind.OpenParenToken) dParen++;
        else if (k === SyntaxKind.CloseParenToken) {
          if (dParen === 0) return false;
          dParen--;
        } else if (k === SyntaxKind.OpenBraceToken) dBrace++;
        else if (k === SyntaxKind.CloseBraceToken) {
          if (dBrace === 0) return false;
          dBrace--;
        } else if (k === SyntaxKind.OpenBracketToken) dBracket++;
        else if (k === SyntaxKind.CloseBracketToken) {
          if (dBracket === 0) return false;
          dBracket--;
        } else if (k === SyntaxKind.LessThanToken) dAngle++;
        else if (k === SyntaxKind.GreaterThanToken && dAngle > 0) dAngle--;
        else if (k === SyntaxKind.GreaterThanGreaterThanToken && dAngle > 0)
          dAngle = Math.max(0, dAngle - 2);
        i++;
      }
    }

    return false;
  }

  private scanArrowFunction(): void {
    const start = this.peek().start;
    if (
      this.at(SyntaxKind.LessThanToken) ||
      this.at(SyntaxKind.LessThanLessThanToken)
    ) {
      this.parseTypeParameterList();
    }
    this.scanParameterList(undefined);
    if (this.match(SyntaxKind.ColonToken)) {
      const retNode = this.makeContextNode(
        "ReturnType",
        start,
        this.peek().end,
      );
      const rt = this.parseReturnType(retNode);
      retNode.end = rt.end;
    }
    if (!this.match(SyntaxKind.EqualsGreaterThanToken)) return;

    if (this.at(SyntaxKind.OpenBraceToken)) {
      this.scanBlock(true);
    } else {
      this.scopes.push({ kind: "arrow-body" });
      try {
        this.scanExpression(true, true);
      } finally {
        this.scopes.pop();
      }
    }
  }

  private looksLikeGenericCallTypeArgs(startIdx: number): boolean {
    if (this.tokens[startIdx]?.kind !== SyntaxKind.LessThanToken) return false;
    // Must be preceded by an identifier, `)`, `]`, or `>` (callee expression)
    const prev = startIdx > 0 ? this.tokens[startIdx - 1] : undefined;
    if (!prev) return false;
    if (
      !isWordLike(prev.kind) &&
      prev.kind !== SyntaxKind.CloseParenToken &&
      prev.kind !== SyntaxKind.CloseBracketToken &&
      prev.kind !== SyntaxKind.GreaterThanToken
    ) {
      return false;
    }
    // Reject keywords that are binary/control keywords (e.g. `return <T>` handled separately)
    if (
      prev.kind === SyntaxKind.ReturnKeyword ||
      prev.kind === SyntaxKind.ThrowKeyword ||
      prev.kind === SyntaxKind.YieldKeyword ||
      prev.kind === SyntaxKind.AwaitKeyword ||
      prev.kind === SyntaxKind.CaseKeyword ||
      prev.kind === SyntaxKind.InKeyword ||
      prev.kind === SyntaxKind.OfKeyword ||
      prev.kind === SyntaxKind.InstanceOfKeyword ||
      prev.kind === SyntaxKind.TypeOfKeyword ||
      prev.kind === SyntaxKind.VoidKeyword ||
      prev.kind === SyntaxKind.DeleteKeyword ||
      prev.kind === SyntaxKind.ElseKeyword ||
      prev.kind === SyntaxKind.NewKeyword
    ) {
      return false;
    }

    let i = startIdx + 1;
    let angleDepth = 1;
    let paren = 0;
    let brace = 0;
    let bracket = 0;

    while (i < this.tokens.length && angleDepth > 0) {
      const k = this.tokens[i]!.kind;
      if (k === SyntaxKind.EndOfFileToken) return false;
      if (
        paren === 0 &&
        brace === 0 &&
        bracket === 0 &&
        INVALID_TYPE_ARG_TOKENS.has(k)
      ) {
        return false;
      }
      if (k === SyntaxKind.OpenParenToken) paren++;
      else if (k === SyntaxKind.CloseParenToken) {
        if (paren === 0) return false;
        paren--;
      } else if (k === SyntaxKind.OpenBraceToken) brace++;
      else if (k === SyntaxKind.CloseBraceToken) {
        if (brace === 0) return false;
        brace--;
      } else if (k === SyntaxKind.OpenBracketToken) bracket++;
      else if (k === SyntaxKind.CloseBracketToken) {
        if (bracket === 0) return false;
        bracket--;
      } else if (paren === 0 && brace === 0 && bracket === 0) {
        if (k === SyntaxKind.LessThanToken) angleDepth++;
        else if (k === SyntaxKind.LessThanLessThanToken) angleDepth += 2;
        else if (k === SyntaxKind.GreaterThanToken) angleDepth--;
        else if (k === SyntaxKind.GreaterThanGreaterThanToken) angleDepth -= 2;
        else if (k === SyntaxKind.GreaterThanGreaterThanGreaterThanToken)
          angleDepth -= 3;
      }
      i++;
    }

    if (angleDepth !== 0) return false;
    const after = this.tokens[i]?.kind;
    return (
      after === SyntaxKind.OpenParenToken ||
      after === SyntaxKind.NoSubstitutionTemplateLiteral ||
      after === SyntaxKind.TemplateHead ||
      (after === SyntaxKind.QuestionDotToken &&
        this.tokens[i + 1]?.kind === SyntaxKind.OpenParenToken)
    );
  }

  private getPrecedingIdentName(): string | undefined {
    const prev = this.pos > 0 ? this.tokens[this.pos - 1] : undefined;
    if (prev && isWordLike(prev.kind)) {
      return prev.text;
    }
    return undefined;
  }

  private scanBalancedParensExpr(): void {
    if (!this.match(SyntaxKind.OpenParenToken)) return;
    let prevKind: SyntaxKind = SyntaxKind.OpenParenToken;
    while (!this.atEof() && !this.at(SyntaxKind.CloseParenToken)) {
      const before = this.pos;
      prevKind = this.scanExpressionToken(
        EXPR_PREFIX_ALLOWING_TYPE_ASSERTION.has(prevKind),
      );
      if (this.pos === before) this.pos++;
    }
    this.match(SyntaxKind.CloseParenToken);
  }

  private scanBalancedBracketsExpr(): void {
    if (!this.match(SyntaxKind.OpenBracketToken)) return;
    let prevKind: SyntaxKind = SyntaxKind.OpenBracketToken;
    while (!this.atEof() && !this.at(SyntaxKind.CloseBracketToken)) {
      const before = this.pos;
      prevKind = this.scanExpressionToken(
        EXPR_PREFIX_ALLOWING_TYPE_ASSERTION.has(prevKind),
      );
      if (this.pos === before) this.pos++;
    }
    this.match(SyntaxKind.CloseBracketToken);
  }

  private scanObjectLiteralExpr(): void {
    if (!this.match(SyntaxKind.OpenBraceToken)) return;

    while (!this.atEof() && !this.at(SyntaxKind.CloseBraceToken)) {
      const before = this.pos;
      if (this.match(SyntaxKind.CommaToken)) continue;

      // Spread `{ ...expr }`
      if (this.match(SyntaxKind.DotDotDotToken)) {
        this.scanExpression(true, true);
        continue;
      }

      // Optional `async` / `get` / `set` method modifier in object literal
      let sawMethodPrefix = false;
      if (
        (this.at(SyntaxKind.AsyncKeyword) ||
          this.at(SyntaxKind.GetKeyword) ||
          this.at(SyntaxKind.SetKeyword)) &&
        (isPropertyNameKind(this.peek(1).kind) ||
          this.at(SyntaxKind.OpenBracketToken, 1) ||
          this.at(SyntaxKind.AsteriskToken, 1))
      ) {
        this.next();
        sawMethodPrefix = true;
      }
      if (this.match(SyntaxKind.AsteriskToken)) {
        sawMethodPrefix = true;
      }

      // Property key (ident, string, number, computed `[expr]`)
      if (this.at(SyntaxKind.OpenBracketToken)) {
        this.scanBalancedBracketsExpr();
      } else if (isPropertyNameKind(this.peek().kind)) {
        this.next();
      } else {
        this.scanExpressionToken(true);
        if (this.pos === before) this.pos++;
        continue;
      }

      // Method shorthand `{ foo<T>(x: any): unknown { ... } }`
      if (
        sawMethodPrefix ||
        this.at(SyntaxKind.OpenParenToken) ||
        (this.at(SyntaxKind.LessThanToken) &&
          this.looksLikeObjectMethodTypeParams(this.pos))
      ) {
        const mStart = this.peek().start;
        if (this.at(SyntaxKind.LessThanToken)) {
          this.parseTypeParameterList();
        }
        if (this.at(SyntaxKind.OpenParenToken)) {
          this.scanParameterList(undefined);
        }
        if (this.match(SyntaxKind.ColonToken)) {
          const retNode = this.makeContextNode(
            "ReturnType",
            mStart,
            this.peek().end,
          );
          const rt = this.parseReturnType(retNode);
          retNode.end = rt.end;
        }
        if (this.at(SyntaxKind.OpenBraceToken)) {
          this.scanBlock(true);
        }
        this.match(SyntaxKind.CommaToken);
        continue;
      }

      // Regular property `{ key: valueExpr }`
      if (this.match(SyntaxKind.ColonToken)) {
        this.scanExpression(true, true);
      }

      this.match(SyntaxKind.CommaToken);
      if (this.pos === before) this.pos++;
    }

    this.match(SyntaxKind.CloseBraceToken);
  }

  private looksLikeObjectMethodTypeParams(startIdx: number): boolean {
    if (this.tokens[startIdx]?.kind !== SyntaxKind.LessThanToken) return false;
    let i = startIdx + 1;
    let depth = 1;
    while (i < this.tokens.length && depth > 0) {
      const k = this.tokens[i]!.kind;
      if (k === SyntaxKind.EndOfFileToken) return false;
      if (k === SyntaxKind.LessThanToken) depth++;
      else if (k === SyntaxKind.GreaterThanToken) depth--;
      else if (k === SyntaxKind.GreaterThanGreaterThanToken) depth -= 2;
      i++;
    }
    return depth === 0 && this.tokens[i]?.kind === SyntaxKind.OpenParenToken;
  }

  private skipBalancedBraces(): void {
    if (!this.match(SyntaxKind.OpenBraceToken)) return;
    let depth = 1;
    while (!this.atEof() && depth > 0) {
      const k = this.next().kind;
      if (k === SyntaxKind.OpenBraceToken) depth++;
      else if (k === SyntaxKind.CloseBraceToken) depth--;
    }
  }

  // ─── Post-Pass Classification on Finalized TypeNodes ─────────────────────

  private buildKeywordHits(): TypeKeywordHit[] {
    const hits: TypeKeywordHit[] = [];

    for (const node of this.keywordNodes) {
      const keyword: KeywordType =
        node.role === "AnyKeyword" ? "any" : "unknown";
      const { line, column } = getLineAndColumnAtPos(
        this.lineStarts,
        node.start,
      );
      const lineStartOffset = this.lineStarts[line - 1] ?? 0;
      const lineText = (this.lines[line - 1] ?? "").trim();

      const simpleKind = this.classifySimpleKind(node);
      const astKind = this.classifyDetailedAstKind(node);
      const { outerType, containerTypeName } = this.computeOuterType(node);
      const insideRecordAncestor = this.hasRecordAncestor(node);

      hits.push({
        keyword,
        line,
        col: column,
        lineStartOffset,
        lineText,
        simpleKind,
        astKind,
        isPublicApi: Boolean(node.isPublicApi),
        enclosing: node.enclosing ?? "<top-level>",
        outerType,
        containerTypeName,
        symbolName: node.symbolName,
        insideRecordAncestor,
      });
    }

    hits.sort((a, b) => a.line - b.line || a.col - b.col);
    return hits;
  }

  private classifySimpleKind(node: TypeNode): SimpleAnyKind {
    const parent = node.parent;
    if (!parent) return "other";

    switch (parent.role) {
      case "TypeParameter":
      case "TypeParameterDefault":
      case "TypeParameterConstraint":
        return "generic-default";
      case "Parameter":
        return "parameter";
      case "ReturnType":
        return "return";
      case "Variable":
      case "Property":
        return "variable";
      case "IndexSignature":
        return "index-signature";
      case "TypeReference":
        return "generic";
      default:
        return "other";
    }
  }

  private classifyDetailedAstKind(node: TypeNode): DetailedAstKind {
    // Check ConditionalExtends ancestor first (matches audit-any-unknown.ts priority)
    let anc: TypeNode | undefined = node.parent;
    while (anc) {
      if (anc.role === "ConditionalExtends") {
        return "conditional-extends";
      }
      anc = anc.parent;
    }

    const parent = node.parent;
    if (!parent) return "other";

    if (parent.role === "DoubleCast") return "double-cast";
    if (
      parent.role === "AsExpression" ||
      parent.role === "TypeAssertionExpression"
    ) {
      return "type-assertion";
    }
    if (parent.role === "TypeParameterDefault") return "generic-default";
    if (parent.role === "TypeParameterConstraint") return "generic-constraint";
    if (parent.role === "TypeParameter") return "generic-default";

    if (parent.role === "TypeReference") {
      if (parent.name === "Record") return "record-value";
      if (parent.name === "Array" || parent.name === "ReadonlyArray") {
        return "array-element";
      }
      return "generic-arg";
    }

    if (parent.role === "ArrayType") {
      const gp = parent.parent;
      if (gp?.role === "Parameter" && gp.isRest) {
        const ggp = gp.parent;
        if (ggp?.role === "ConstructorType") return "constructor-type";
        if (ggp?.role === "FunctionType") return "function-type";
        return "rest-args";
      }
      return "array-element";
    }

    if (parent.role === "IndexSignature") return "index-signature";
    if (parent.role === "ConstructorType") return "constructor-type";
    if (parent.role === "FunctionType") return "function-type";

    if (parent.role === "Parameter") {
      if (parent.isRest) return "rest-args";
      const gp = parent.parent;
      if (gp?.role === "ConstructorType") return "constructor-type";
      if (gp?.role === "FunctionType") return "function-type";
      return "parameter";
    }

    if (parent.role === "ReturnType") return "return-type";
    if (parent.role === "Property") return "property";
    if (parent.role === "CatchClause") return "catch-clause";
    if (parent.role === "Variable") return "variable";
    if (parent.role === "TypeAlias") return "type-alias";
    if (parent.role === "UnionType" || parent.role === "IntersectionType") {
      return "union-or-intersection";
    }

    return "other";
  }

  private sliceSnippet(start: number, end: number): string {
    if (end <= start) return "";
    return this.source.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 110);
  }

  private computeOuterType(node: TypeNode): {
    outerType: string;
    containerTypeName?: string;
  } {
    const parent = node.parent;
    if (!parent) {
      return { outerType: this.sliceSnippet(node.start, node.end) };
    }

    if (parent.role === "TypeReference") {
      return {
        outerType: this.sliceSnippet(parent.start, parent.end),
        containerTypeName: parent.name,
      };
    }

    if (parent.role === "ArrayType") {
      const gp = parent.parent;
      if (gp?.role === "Parameter" && gp.isRest) {
        return { outerType: this.sliceSnippet(gp.start, gp.end) };
      }
      if (gp?.role === "TypeReference" || gp?.role === "TypeOperator") {
        return {
          outerType: this.sliceSnippet(gp.start, gp.end),
          containerTypeName:
            gp.role === "TypeReference" ? gp.name : undefined,
        };
      }
      return { outerType: this.sliceSnippet(parent.start, parent.end) };
    }

    if (
      parent.role === "TypeParameterDefault" ||
      parent.role === "TypeParameterConstraint"
    ) {
      const tp = parent.parent ?? parent;
      return { outerType: this.sliceSnippet(tp.start, tp.end) };
    }

    const snippet = this.sliceSnippet(parent.start, parent.end);
    return {
      outerType: snippet || this.sliceSnippet(node.start, node.end),
    };
  }

  private hasRecordAncestor(node: TypeNode): boolean {
    let cur: TypeNode | undefined = node.parent;
    while (cur) {
      if (cur.role === "TypeReference" && cur.name === "Record") {
        return true;
      }
      cur = cur.parent;
    }
    return false;
  }
}

export function scanTypeScriptSource(
  source: string,
  filePath?: string,
): FileScanResult {
  return new TypeScriptScanner(source, filePath).scan();
}
