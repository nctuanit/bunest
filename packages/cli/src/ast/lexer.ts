import { KEYWORD_MAP, SyntaxKind } from "./syntax-kind";

export interface Token {
  readonly kind: SyntaxKind;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly value?: string | number;
  readonly lineBreakBefore: boolean;
}

export interface LexResult {
  readonly tokens: Token[];
  readonly lineStarts: number[];
}

export function computeLineStarts(source: string): number[] {
  const starts = [0];
  const len = source.length;
  for (let i = 0; i < len; i++) {
    const ch = source.charCodeAt(i);
    if (ch === 10 /* \n */) {
      starts.push(i + 1);
    } else if (ch === 13 /* \r */) {
      if (i + 1 < len && source.charCodeAt(i + 1) === 10) {
        i++;
      }
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Returns 1-based `{ line, column }` for a 0-based character offset in O(log N).
 */
export function getLineAndColumnAtPos(
  lineStarts: readonly number[],
  pos: number,
): { line: number; column: number } {
  const clamped = Math.max(0, pos);
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= clamped) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return {
    line: lo + 1,
    column: clamped - lineStarts[lo]! + 1,
  };
}

function isIdentStart(code: number): boolean {
  return (
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 36 || // $
    code >= 0x80
  );
}

function isIdentPart(code: number): boolean {
  return isIdentStart(code) || (code >= 48 && code <= 57); // 0-9
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

function isWhitespace(code: number): boolean {
  return (
    code === 32 || // space
    code === 9 || // \t
    code === 11 || // \v
    code === 12 || // \f
    code === 0xa0 ||
    code === 0xfeff
  );
}

function isLineBreak(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

function unescapeChar(
  source: string,
  pos: number,
): { char: string; nextPos: number } {
  const len = source.length;
  if (pos >= len) return { char: "", nextPos: pos };
  const ch = source[pos]!;
  switch (ch) {
    case "n":
      return { char: "\n", nextPos: pos + 1 };
    case "r":
      return { char: "\r", nextPos: pos + 1 };
    case "t":
      return { char: "\t", nextPos: pos + 1 };
    case "b":
      return { char: "\b", nextPos: pos + 1 };
    case "f":
      return { char: "\f", nextPos: pos + 1 };
    case "v":
      return { char: "\v", nextPos: pos + 1 };
    case "0":
      return { char: "\0", nextPos: pos + 1 };
    case "\r":
      return {
        char: "",
        nextPos: pos + (source[pos + 1] === "\n" ? 2 : 1),
      };
    case "\n":
      return { char: "", nextPos: pos + 1 };
    case "x": {
      const hex = source.slice(pos + 1, pos + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        return {
          char: String.fromCharCode(parseInt(hex, 16)),
          nextPos: pos + 3,
        };
      }
      return { char: "x", nextPos: pos + 1 };
    }
    case "u": {
      if (source[pos + 1] === "{") {
        const close = source.indexOf("}", pos + 2);
        if (close !== -1) {
          const hex = source.slice(pos + 2, close);
          if (/^[0-9a-fA-F]+$/.test(hex)) {
            return {
              char: String.fromCodePoint(parseInt(hex, 16)),
              nextPos: close + 1,
            };
          }
        }
      } else {
        const hex = source.slice(pos + 1, pos + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          return {
            char: String.fromCharCode(parseInt(hex, 16)),
            nextPos: pos + 5,
          };
        }
      }
      return { char: "u", nextPos: pos + 1 };
    }
    default:
      return { char: ch, nextPos: pos + 1 };
  }
}

const REGEX_PRECEDING_KEYWORDS = new Set<SyntaxKind>([
  SyntaxKind.ReturnKeyword,
  SyntaxKind.ThrowKeyword,
  SyntaxKind.CaseKeyword,
  SyntaxKind.InKeyword,
  SyntaxKind.OfKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.DeleteKeyword,
  SyntaxKind.AwaitKeyword,
  SyntaxKind.YieldKeyword,
  SyntaxKind.NewKeyword,
  SyntaxKind.ElseKeyword,
  SyntaxKind.DoKeyword,
  SyntaxKind.ExtendsKeyword,
]);

const DIVISION_PRECEDING_TOKENS = new Set<SyntaxKind>([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
]);

const PAREN_STATEMENT_KEYWORDS = new Set<SyntaxKind>([
  SyntaxKind.IfKeyword,
  SyntaxKind.WhileKeyword,
  SyntaxKind.ForKeyword,
  SyntaxKind.WithKeyword,
]);

/**
 * Full TypeScript lexer handling comments, nested template literals,
 * regex-vs-division disambiguation, decorators, private identifiers,
 * numeric separators, and O(log N) line/column lookup.
 */
export function lexTypeScript(source: string): LexResult {
  const tokens: Token[] = [];
  const lineStarts = computeLineStarts(source);
  const len = source.length;
  let pos = 0;

  // Brace stack distinguishes normal `{ ... }` blocks from template `${ ... }` expressions
  const braceStack: Array<"normal" | "template"> = [];
  // Paren stack distinguishes `if (...) /regex/` from `(a + b) / c`
  const parenIsStatementStack: boolean[] = [];
  let lastClosedParenWasStatement = false;

  // Skip optional UTF-8 BOM or hashbang `#!...`
  if (pos < len && source.charCodeAt(pos) === 0xfeff) {
    pos++;
  }
  if (pos + 1 < len && source[pos] === "#" && source[pos + 1] === "!") {
    while (pos < len && !isLineBreak(source.charCodeAt(pos))) {
      pos++;
    }
  }

  const canStartRegex = (slashPos: number): boolean => {
    if (tokens.length === 0) return true;
    const prev = tokens[tokens.length - 1]!;
    // JSX closing tag `</tag>` or `</>` — never a regex literal
    if (prev.kind === SyntaxKind.LessThanToken && prev.end === slashPos) {
      return false;
    }
    if (prev.kind === SyntaxKind.CloseParenToken) {
      return lastClosedParenWasStatement;
    }
    if (prev.kind === SyntaxKind.CloseBraceToken) {
      return true;
    }
    if (DIVISION_PRECEDING_TOKENS.has(prev.kind)) {
      return false;
    }
    if (REGEX_PRECEDING_KEYWORDS.has(prev.kind)) {
      return true;
    }
    // Contextual keywords (e.g. `type`, `get`, `set`, `from`, `string`) behave as identifiers in expressions
    if (prev.kind >= SyntaxKind.TrueKeyword && prev.kind <= SyntaxKind.WithKeyword) {
      return false;
    }
    return true;
  };

  const scanTemplateSegment = (
    startPos: number,
    isHead: boolean,
    lineBreakBefore: boolean,
  ): void => {
    // pos currently sits right after opening `` ` `` or closing `}`
    let val = "";
    while (pos < len) {
      const ch = source[pos]!;
      if (ch === "`") {
        pos++;
        tokens.push({
          kind: isHead
            ? SyntaxKind.NoSubstitutionTemplateLiteral
            : SyntaxKind.TemplateTail,
          start: startPos,
          end: pos,
          text: source.slice(startPos, pos),
          value: val,
          lineBreakBefore,
        });
        return;
      }
      if (ch === "$" && source[pos + 1] === "{") {
        pos += 2;
        braceStack.push("template");
        tokens.push({
          kind: isHead ? SyntaxKind.TemplateHead : SyntaxKind.TemplateMiddle,
          start: startPos,
          end: pos,
          text: source.slice(startPos, pos),
          value: val,
          lineBreakBefore,
        });
        return;
      }
      if (ch === "\\") {
        const res = unescapeChar(source, pos + 1);
        val += res.char;
        pos = res.nextPos;
        continue;
      }
      if (ch === "\r") {
        val += "\n";
        pos += source[pos + 1] === "\n" ? 2 : 1;
        continue;
      }
      val += ch;
      pos++;
    }
    // Unterminated template literal — recover gracefully
    tokens.push({
      kind: isHead
        ? SyntaxKind.NoSubstitutionTemplateLiteral
        : SyntaxKind.TemplateTail,
      start: startPos,
      end: pos,
      text: source.slice(startPos, pos),
      value: val,
      lineBreakBefore,
    });
  };

  while (pos < len) {
    let lineBreakBefore = false;

    // Skip whitespace & comments
    while (pos < len) {
      const code = source.charCodeAt(pos);
      if (isWhitespace(code)) {
        pos++;
        continue;
      }
      if (isLineBreak(code)) {
        lineBreakBefore = true;
        pos++;
        continue;
      }
      if (code === 47 /* / */ && pos + 1 < len) {
        const next = source.charCodeAt(pos + 1);
        if (next === 47 /* // */) {
          pos += 2;
          while (pos < len && !isLineBreak(source.charCodeAt(pos))) {
            pos++;
          }
          continue;
        }
        if (next === 42 /* /* */) {
          pos += 2;
          while (pos < len) {
            const c = source.charCodeAt(pos);
            if (isLineBreak(c)) lineBreakBefore = true;
            if (c === 42 && source.charCodeAt(pos + 1) === 47) {
              pos += 2;
              break;
            }
            pos++;
          }
          continue;
        }
      }
      break;
    }

    if (pos >= len) break;

    const start = pos;
    const ch = source[pos]!;
    const code = source.charCodeAt(pos);

    // String literals
    if (ch === '"' || ch === "'") {
      const quote = ch;
      pos++;
      let val = "";
      while (pos < len) {
        const c = source[pos]!;
        if (c === quote) {
          pos++;
          break;
        }
        if (c === "\\") {
          const res = unescapeChar(source, pos + 1);
          val += res.char;
          pos = res.nextPos;
          continue;
        }
        if (isLineBreak(source.charCodeAt(pos))) {
          break;
        }
        val += c;
        pos++;
      }
      tokens.push({
        kind: SyntaxKind.StringLiteral,
        start,
        end: pos,
        text: source.slice(start, pos),
        value: val,
        lineBreakBefore,
      });
      continue;
    }

    // Template literals
    if (ch === "`") {
      pos++;
      scanTemplateSegment(start, true, lineBreakBefore);
      continue;
    }

    // Numbers (including leading dot `.5`)
    if (
      isDigit(code) ||
      (ch === "." && pos + 1 < len && isDigit(source.charCodeAt(pos + 1)))
    ) {
      let isBigInt = false;
      if (
        ch === "0" &&
        pos + 1 < len &&
        (source[pos + 1] === "x" ||
          source[pos + 1] === "X" ||
          source[pos + 1] === "b" ||
          source[pos + 1] === "B" ||
          source[pos + 1] === "o" ||
          source[pos + 1] === "O")
      ) {
        pos += 2;
        while (
          pos < len &&
          (isHexDigit(source.charCodeAt(pos)) || source[pos] === "_")
        ) {
          pos++;
        }
      } else {
        while (pos < len && (isDigit(source.charCodeAt(pos)) || source[pos] === "_")) {
          pos++;
        }
        if (pos < len && source[pos] === "." && source[pos + 1] !== ".") {
          pos++;
          while (pos < len && (isDigit(source.charCodeAt(pos)) || source[pos] === "_")) {
            pos++;
          }
        }
        if (pos < len && (source[pos] === "e" || source[pos] === "E")) {
          pos++;
          if (pos < len && (source[pos] === "+" || source[pos] === "-")) {
            pos++;
          }
          while (pos < len && (isDigit(source.charCodeAt(pos)) || source[pos] === "_")) {
            pos++;
          }
        }
      }
      if (pos < len && source[pos] === "n") {
        isBigInt = true;
        pos++;
      }
      const rawText = source.slice(start, pos);
      const cleaned = rawText.replace(/_/g, "");
      tokens.push({
        kind: isBigInt ? SyntaxKind.BigIntLiteral : SyntaxKind.NumericLiteral,
        start,
        end: pos,
        text: rawText,
        value: isBigInt ? cleaned : Number(cleaned),
        lineBreakBefore,
      });
      continue;
    }

    // Private identifier `#foo`
    if (ch === "#" && pos + 1 < len && isIdentStart(source.charCodeAt(pos + 1))) {
      pos += 2;
      while (pos < len && isIdentPart(source.charCodeAt(pos))) {
        pos++;
      }
      tokens.push({
        kind: SyntaxKind.PrivateIdentifier,
        start,
        end: pos,
        text: source.slice(start, pos),
        lineBreakBefore,
      });
      continue;
    }

    // Identifiers & Keywords
    if (isIdentStart(code)) {
      pos++;
      while (pos < len && isIdentPart(source.charCodeAt(pos))) {
        pos++;
      }
      const text = source.slice(start, pos);
      const kwKind = Object.prototype.hasOwnProperty.call(KEYWORD_MAP, text)
        ? KEYWORD_MAP[text]!
        : SyntaxKind.Identifier;
      tokens.push({
        kind: kwKind,
        start,
        end: pos,
        text,
        lineBreakBefore,
      });
      continue;
    }

    // Regex literal vs Slash
    if (ch === "/") {
      if (canStartRegex(pos)) {
        let scanPos = pos + 1;
        let inCharClass = false;
        let terminated = false;
        while (scanPos < len) {
          const rc = source[scanPos]!;
          if (isLineBreak(source.charCodeAt(scanPos))) break;
          if (rc === "\\") {
            scanPos += 2;
            continue;
          }
          if (rc === "[") {
            inCharClass = true;
            scanPos++;
            continue;
          }
          if (rc === "]") {
            inCharClass = false;
            scanPos++;
            continue;
          }
          if (rc === "/" && !inCharClass) {
            scanPos++;
            while (scanPos < len && isIdentPart(source.charCodeAt(scanPos))) {
              scanPos++;
            }
            terminated = true;
            break;
          }
          scanPos++;
        }
        if (terminated) {
          pos = scanPos;
          tokens.push({
            kind: SyntaxKind.RegularExpressionLiteral,
            start,
            end: pos,
            text: source.slice(start, pos),
            lineBreakBefore,
          });
          continue;
        }
      }
      if (source[pos + 1] === "=") {
        pos += 2;
        tokens.push({
          kind: SyntaxKind.CompoundAssignmentToken,
          start,
          end: pos,
          text: "/=",
          lineBreakBefore,
        });
      } else {
        pos++;
        tokens.push({
          kind: SyntaxKind.SlashToken,
          start,
          end: pos,
          text: "/",
          lineBreakBefore,
        });
      }
      continue;
    }

    // Braces (coordinate with template literal stack)
    if (ch === "{") {
      pos++;
      braceStack.push("normal");
      tokens.push({
        kind: SyntaxKind.OpenBraceToken,
        start,
        end: pos,
        text: "{",
        lineBreakBefore,
      });
      continue;
    }

    if (ch === "}") {
      pos++;
      const top = braceStack.pop();
      if (top === "template") {
        scanTemplateSegment(start, false, lineBreakBefore);
      } else {
        tokens.push({
          kind: SyntaxKind.CloseBraceToken,
          start,
          end: pos,
          text: "}",
          lineBreakBefore,
        });
      }
      continue;
    }

    // Parens (coordinate with regex disambiguation)
    if (ch === "(") {
      const prevKind = tokens.length > 0 ? tokens[tokens.length - 1]!.kind : SyntaxKind.Unknown;
      parenIsStatementStack.push(PAREN_STATEMENT_KEYWORDS.has(prevKind));
      pos++;
      tokens.push({
        kind: SyntaxKind.OpenParenToken,
        start,
        end: pos,
        text: "(",
        lineBreakBefore,
      });
      continue;
    }

    if (ch === ")") {
      lastClosedParenWasStatement = parenIsStatementStack.pop() ?? false;
      pos++;
      tokens.push({
        kind: SyntaxKind.CloseParenToken,
        start,
        end: pos,
        text: ")",
        lineBreakBefore,
      });
      continue;
    }

    // Multi-char & single-char punctuators
    const c2 = source.slice(pos, pos + 2);
    const c3 = source.slice(pos, pos + 3);
    const c4 = source.slice(pos, pos + 4);

    if (c4 === ">>>=") {
      pos += 4;
      tokens.push({ kind: SyntaxKind.CompoundAssignmentToken, start, end: pos, text: c4, lineBreakBefore });
      continue;
    }

    if (
      c3 === "..." ||
      c3 === "===" ||
      c3 === "!==" ||
      c3 === ">>>" ||
      c3 === "<<=" ||
      c3 === ">>=" ||
      c3 === "**=" ||
      c3 === "&&=" ||
      c3 === "||=" ||
      c3 === "??="
    ) {
      pos += 3;
      const kind =
        c3 === "..."
          ? SyntaxKind.DotDotDotToken
          : c3 === "==="
            ? SyntaxKind.EqualsEqualsEqualsToken
            : c3 === "!=="
              ? SyntaxKind.ExclamationEqualsEqualsToken
              : c3 === ">>>"
                ? SyntaxKind.GreaterThanGreaterThanGreaterThanToken
                : SyntaxKind.CompoundAssignmentToken;
      tokens.push({ kind, start, end: pos, text: c3, lineBreakBefore });
      continue;
    }

    if (
      c2 === "=>" ||
      c2 === "<=" ||
      c2 === ">=" ||
      c2 === "==" ||
      c2 === "!=" ||
      c2 === "++" ||
      c2 === "--" ||
      c2 === "<<" ||
      c2 === ">>" ||
      c2 === "**" ||
      c2 === "&&" ||
      c2 === "||" ||
      c2 === "??" ||
      (c2 === "?." && !(pos + 2 < len && isDigit(source.charCodeAt(pos + 2)))) ||
      c2 === "+=" ||
      c2 === "-=" ||
      c2 === "*=" ||
      c2 === "%=" ||
      c2 === "&=" ||
      c2 === "|=" ||
      c2 === "^="
    ) {
      pos += 2;
      let kind: SyntaxKind;
      switch (c2) {
        case "=>":
          kind = SyntaxKind.EqualsGreaterThanToken;
          break;
        case "<=":
          kind = SyntaxKind.LessThanEqualsToken;
          break;
        case ">=":
          kind = SyntaxKind.GreaterThanEqualsToken;
          break;
        case "==":
          kind = SyntaxKind.EqualsEqualsToken;
          break;
        case "!=":
          kind = SyntaxKind.ExclamationEqualsToken;
          break;
        case "++":
          kind = SyntaxKind.PlusPlusToken;
          break;
        case "--":
          kind = SyntaxKind.MinusMinusToken;
          break;
        case "<<":
          kind = SyntaxKind.LessThanLessThanToken;
          break;
        case ">>":
          kind = SyntaxKind.GreaterThanGreaterThanToken;
          break;
        case "**":
          kind = SyntaxKind.AsteriskAsteriskToken;
          break;
        case "&&":
          kind = SyntaxKind.AmpersandAmpersandToken;
          break;
        case "||":
          kind = SyntaxKind.BarBarToken;
          break;
        case "??":
          kind = SyntaxKind.QuestionQuestionToken;
          break;
        case "?.":
          kind = SyntaxKind.QuestionDotToken;
          break;
        default:
          kind = SyntaxKind.CompoundAssignmentToken;
          break;
      }
      tokens.push({ kind, start, end: pos, text: c2, lineBreakBefore });
      continue;
    }

    // Single-character punctuators
    pos++;
    let kind: SyntaxKind;
    switch (ch) {
      case "[":
        kind = SyntaxKind.OpenBracketToken;
        break;
      case "]":
        kind = SyntaxKind.CloseBracketToken;
        break;
      case ".":
        kind = SyntaxKind.DotToken;
        break;
      case ";":
        kind = SyntaxKind.SemicolonToken;
        break;
      case ",":
        kind = SyntaxKind.CommaToken;
        break;
      case "<":
        kind = SyntaxKind.LessThanToken;
        break;
      case ">":
        kind = SyntaxKind.GreaterThanToken;
        break;
      case "+":
        kind = SyntaxKind.PlusToken;
        break;
      case "-":
        kind = SyntaxKind.MinusToken;
        break;
      case "*":
        kind = SyntaxKind.AsteriskToken;
        break;
      case "%":
        kind = SyntaxKind.PercentToken;
        break;
      case "&":
        kind = SyntaxKind.AmpersandToken;
        break;
      case "|":
        kind = SyntaxKind.BarToken;
        break;
      case "^":
        kind = SyntaxKind.CaretToken;
        break;
      case "!":
        kind = SyntaxKind.ExclamationToken;
        break;
      case "~":
        kind = SyntaxKind.TildeToken;
        break;
      case "?":
        kind = SyntaxKind.QuestionToken;
        break;
      case ":":
        kind = SyntaxKind.ColonToken;
        break;
      case "@":
        kind = SyntaxKind.AtToken;
        break;
      case "=":
        kind = SyntaxKind.EqualsToken;
        break;
      default:
        kind = SyntaxKind.Unknown;
        break;
    }
    tokens.push({ kind, start, end: pos, text: ch, lineBreakBefore });
  }

  tokens.push({
    kind: SyntaxKind.EndOfFileToken,
    start: len,
    end: len,
    text: "",
    lineBreakBefore: false,
  });

  return { tokens, lineStarts };
}
