/**
 * GraphQL October 2021 Spec Lexer.
 * Supports Unicode BOM, comments, single-line & block strings (with Spec dedent),
 * Unicode variable-width escapes `\u{...}`, Int/Float, Names, Punctuators, and exact locations.
 * Zero external dependencies.
 */

import { type Source, Token, TokenKind } from "./ast";
import { syntaxError } from "./error";

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57; // 0-9
}

function isNameStart(code: number): boolean {
  return (
    code === 95 || // _
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) // a-z
  );
}

function isNameContinue(code: number): boolean {
  return isNameStart(code) || isDigit(code);
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

function isUnicodeScalarValue(code: number): boolean {
  return (code >= 0 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0x10ffff);
}

function printCharCode(code: number): string {
  if (Number.isNaN(code)) {
    return TokenKind.EOF;
  }
  return code < 0x007f
    ? JSON.stringify(String.fromCharCode(code))
    : `"\\u${code.toString(16).toUpperCase().padStart(4, "0")}"`;
}

/**
 * GraphQL October 2021 Spec `BlockStringValue(rawValue)` algorithm.
 */
export function dedentBlockStringLines(
  lines: readonly string[],
): string[] {
  let commonIndent = Number.MAX_SAFE_INTEGER;
  let firstNonEmptyLine: number | null = null;
  let lastNonEmptyLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const indent = leadingWhitespace(line);
    if (indent === line.length) {
      continue; // blank line
    }
    if (firstNonEmptyLine === null) {
      firstNonEmptyLine = i;
    }
    lastNonEmptyLine = i;
    if (i !== 0 && indent < commonIndent) {
      commonIndent = indent;
    }
  }

  const out = lines.map((line, i) =>
    i === 0 || commonIndent === Number.MAX_SAFE_INTEGER
      ? line
      : line.slice(commonIndent),
  );

  let start = 0;
  while (start < out.length && isBlankLine(out[start]!)) {
    start++;
  }
  let end = out.length;
  while (end > start && isBlankLine(out[end - 1]!)) {
    end--;
  }
  return out.slice(start, end);
}

function leadingWhitespace(str: string): number {
  let i = 0;
  while (i < str.length && (str.charCodeAt(i) === 32 || str.charCodeAt(i) === 9)) {
    i++;
  }
  return i;
}

function isBlankLine(str: string): boolean {
  return leadingWhitespace(str) === str.length;
}

export class Lexer {
  readonly source: Source;
  lastToken: Token;
  token: Token;
  line: number;
  lineStart: number;

  constructor(source: Source) {
    const startOfFileToken = new Token(TokenKind.SOF, 0, 0, 0, 0);
    this.source = source;
    this.lastToken = startOfFileToken;
    this.token = startOfFileToken;
    this.line = 1;
    this.lineStart = 0;
  }

  advance(): Token {
    this.lastToken = this.token;
    this.token = this.lookahead();
    return this.token;
  }

  lookahead(): Token {
    let token = this.token;
    if (token.kind !== TokenKind.EOF) {
      do {
        if (token.next) {
          token = token.next;
        } else {
          const nextToken = this.readNextToken(token.end, token);
          token.next = nextToken;
          token = nextToken;
        }
      } while (token.kind === TokenKind.COMMENT);
    }
    return token;
  }

  private readNextToken(start: number, prev: Token): Token {
    const body = this.source.body;
    const bodyLength = body.length;
    let position = start;

    while (position < bodyLength) {
      const code = body.charCodeAt(position);
      switch (code) {
        case 0xfeff: // BOM
        case 0x0009: // Tab
        case 0x0020: // Space
        case 0x002c: // Comma
          position++;
          continue;
        case 0x000a: // LF
          position++;
          this.line++;
          this.lineStart = position;
          continue;
        case 0x000d: // CR / CRLF
          if (body.charCodeAt(position + 1) === 0x000a) {
            position += 2;
          } else {
            position++;
          }
          this.line++;
          this.lineStart = position;
          continue;
        case 0x0023: // # Comment
          return this.readComment(position, prev);
        case 0x0021: // !
          return this.createToken(TokenKind.BANG, position, position + 1, "!", prev);
        case 0x0024: // $
          return this.createToken(TokenKind.DOLLAR, position, position + 1, "$", prev);
        case 0x0026: // &
          return this.createToken(TokenKind.AMP, position, position + 1, "&", prev);
        case 0x0028: // (
          return this.createToken(TokenKind.PAREN_L, position, position + 1, "(", prev);
        case 0x0029: // )
          return this.createToken(TokenKind.PAREN_R, position, position + 1, ")", prev);
        case 0x002e: // .
          if (
            body.charCodeAt(position + 1) === 0x002e &&
            body.charCodeAt(position + 2) === 0x002e
          ) {
            return this.createToken(
              TokenKind.SPREAD,
              position,
              position + 3,
              "...",
              prev,
            );
          }
          throw syntaxError(
            this.source,
            position,
            `Unexpected character ".".`,
          );
        case 0x003a: // :
          return this.createToken(TokenKind.COLON, position, position + 1, ":", prev);
        case 0x003d: // =
          return this.createToken(TokenKind.EQUALS, position, position + 1, "=", prev);
        case 0x0040: // @
          return this.createToken(TokenKind.AT, position, position + 1, "@", prev);
        case 0x005b: // [
          return this.createToken(TokenKind.BRACKET_L, position, position + 1, "[", prev);
        case 0x005d: // ]
          return this.createToken(TokenKind.BRACKET_R, position, position + 1, "]", prev);
        case 0x007b: // {
          return this.createToken(TokenKind.BRACE_L, position, position + 1, "{", prev);
        case 0x007c: // |
          return this.createToken(TokenKind.PIPE, position, position + 1, "|", prev);
        case 0x007d: // }
          return this.createToken(TokenKind.BRACE_R, position, position + 1, "}", prev);
        case 0x0022: // "
          if (
            body.charCodeAt(position + 1) === 0x0022 &&
            body.charCodeAt(position + 2) === 0x0022
          ) {
            return this.readBlockString(position, prev);
          }
          return this.readString(position, prev);
        default:
          if (code === 0x002d || isDigit(code)) {
            return this.readNumber(position, code, prev);
          }
          if (isNameStart(code)) {
            return this.readName(position, prev);
          }
          throw syntaxError(
            this.source,
            position,
            code === 0x0027
              ? `Unexpected single quote character ('), did you mean to use a double quote (")?`
              : `Unexpected character: ${printCharCode(code)}.`,
          );
      }
    }

    return this.createToken(TokenKind.EOF, bodyLength, bodyLength, "", prev);
  }

  private createToken(
    kind: (typeof TokenKind)[keyof typeof TokenKind],
    start: number,
    end: number,
    value: string,
    prev: Token,
  ): Token {
    const line = this.line;
    const col = start - this.lineStart + 1;
    return new Token(kind, start, end, line, col, value, prev);
  }

  private readComment(start: number, prev: Token): Token {
    const body = this.source.body;
    const bodyLength = body.length;
    let position = start + 1;
    while (position < bodyLength) {
      const code = body.charCodeAt(position);
      if (code === 0x000a || code === 0x000d) {
        break;
      }
      position++;
    }
    return this.createToken(
      TokenKind.COMMENT,
      start,
      position,
      body.slice(start + 1, position),
      prev,
    );
  }

  private readNumber(start: number, firstCode: number, prev: Token): Token {
    const body = this.source.body;
    let position = start;
    let code = firstCode;
    let isFloat = false;

    if (code === 0x002d) {
      // -
      code = body.charCodeAt(++position);
    }

    if (code === 0x0030) {
      // 0
      code = body.charCodeAt(++position);
      if (isDigit(code)) {
        throw syntaxError(
          this.source,
          position,
          `Invalid number, unexpected digit after 0: ${printCharCode(code)}.`,
        );
      }
    } else {
      position = this.readDigits(position, code);
      code = body.charCodeAt(position);
    }

    if (code === 0x002e) {
      // .
      isFloat = true;
      code = body.charCodeAt(++position);
      position = this.readDigits(position, code);
      code = body.charCodeAt(position);
    }

    if (code === 0x0045 || code === 0x0065) {
      // E or e
      isFloat = true;
      code = body.charCodeAt(++position);
      if (code === 0x002b || code === 0x002d) {
        code = body.charCodeAt(++position);
      }
      position = this.readDigits(position, code);
      code = body.charCodeAt(position);
    }

    if (code === 0x002e || isNameStart(code)) {
      throw syntaxError(
        this.source,
        position,
        `Invalid number, expected digit but got: ${printCharCode(code)}.`,
      );
    }

    return this.createToken(
      isFloat ? TokenKind.FLOAT : TokenKind.INT,
      start,
      position,
      body.slice(start, position),
      prev,
    );
  }

  private readDigits(start: number, firstCode: number): number {
    const body = this.source.body;
    if (!isDigit(firstCode)) {
      throw syntaxError(
        this.source,
        start,
        `Invalid number, expected digit but got: ${printCharCode(firstCode)}.`,
      );
    }
    let position = start + 1;
    while (isDigit(body.charCodeAt(position))) {
      position++;
    }
    return position;
  }

  private readName(start: number, prev: Token): Token {
    const body = this.source.body;
    const bodyLength = body.length;
    let position = start + 1;
    while (position < bodyLength && isNameContinue(body.charCodeAt(position))) {
      position++;
    }
    return this.createToken(
      TokenKind.NAME,
      start,
      position,
      body.slice(start, position),
      prev,
    );
  }

  private readString(start: number, prev: Token): Token {
    const body = this.source.body;
    const bodyLength = body.length;
    let position = start + 1;
    let chunkStart = position;
    let value = "";

    while (position < bodyLength) {
      const code = body.charCodeAt(position);
      if (code === 0x0022) {
        // Closing "
        value += body.slice(chunkStart, position);
        return this.createToken(
          TokenKind.STRING,
          start,
          position + 1,
          value,
          prev,
        );
      }
      if (code === 0x000a || code === 0x000d) {
        break;
      }
      if (code === 0x005c) {
        // Backslash escape
        value += body.slice(chunkStart, position);
        const escCode = body.charCodeAt(position + 1);
        switch (escCode) {
          case 0x0022:
            value += '"';
            position += 2;
            break;
          case 0x005c:
            value += "\\";
            position += 2;
            break;
          case 0x002f:
            value += "/";
            position += 2;
            break;
          case 0x0062:
            value += "\b";
            position += 2;
            break;
          case 0x0066:
            value += "\f";
            position += 2;
            break;
          case 0x006e:
            value += "\n";
            position += 2;
            break;
          case 0x0072:
            value += "\r";
            position += 2;
            break;
          case 0x0074:
            value += "\t";
            position += 2;
            break;
          case 0x0075: {
            // \uXXXX or \u{...}
            if (body.charCodeAt(position + 2) === 0x007b) {
              // Variable-width Unicode escape \u{...}
              let hexEnd = position + 3;
              while (hexEnd < bodyLength && body.charCodeAt(hexEnd) !== 0x007d) {
                if (!isHexDigit(body.charCodeAt(hexEnd))) {
                  throw syntaxError(
                    this.source,
                    position,
                    `Invalid Unicode escape sequence.`,
                  );
                }
                hexEnd++;
              }
              if (
                hexEnd >= bodyLength ||
                hexEnd === position + 3
              ) {
                throw syntaxError(
                  this.source,
                  position,
                  `Invalid Unicode escape sequence.`,
                );
              }
              const hexStr = body.slice(position + 3, hexEnd);
              const cp = Number.parseInt(hexStr, 16);
              if (!isUnicodeScalarValue(cp)) {
                throw syntaxError(
                  this.source,
                  position,
                  `Invalid Unicode escape sequence: "\\u{${hexStr}}".`,
                );
              }
              value += String.fromCodePoint(cp);
              position = hexEnd + 1;
            } else {
              const hexStr = body.slice(position + 2, position + 6);
              if (
                hexStr.length !== 4 ||
                !isHexDigit(hexStr.charCodeAt(0)) ||
                !isHexDigit(hexStr.charCodeAt(1)) ||
                !isHexDigit(hexStr.charCodeAt(2)) ||
                !isHexDigit(hexStr.charCodeAt(3))
              ) {
                throw syntaxError(
                  this.source,
                  position,
                  `Invalid character escape sequence: "\\u${hexStr}".`,
                );
              }
              const cp = Number.parseInt(hexStr, 16);
              // Handle UTF-16 surrogate pair \uD800..\uDBFF followed by \uDC00..\uDFFF
              if (
                cp >= 0xd800 &&
                cp <= 0xdbff &&
                body.charCodeAt(position + 6) === 0x005c &&
                body.charCodeAt(position + 7) === 0x0075
              ) {
                const lowHex = body.slice(position + 8, position + 12);
                if (
                  lowHex.length === 4 &&
                  isHexDigit(lowHex.charCodeAt(0)) &&
                  isHexDigit(lowHex.charCodeAt(1)) &&
                  isHexDigit(lowHex.charCodeAt(2)) &&
                  isHexDigit(lowHex.charCodeAt(3))
                ) {
                  const lowCp = Number.parseInt(lowHex, 16);
                  if (lowCp >= 0xdc00 && lowCp <= 0xdfff) {
                    value += String.fromCharCode(cp, lowCp);
                    position += 12;
                    chunkStart = position;
                    continue;
                  }
                }
              }
              if (cp >= 0xd800 && cp <= 0xdfff) {
                throw syntaxError(
                  this.source,
                  position,
                  `Invalid Unicode surrogate escape sequence: "\\u${hexStr}".`,
                );
              }
              value += String.fromCharCode(cp);
              position += 6;
            }
            break;
          }
          default:
            throw syntaxError(
              this.source,
              position,
              `Invalid character escape sequence: "\\${body[position + 1] ?? ""}".`,
            );
        }
        chunkStart = position;
        continue;
      }

      if (code < 0x0020 && code !== 0x0009) {
        throw syntaxError(
          this.source,
          position,
          `Invalid character within String: ${printCharCode(code)}.`,
        );
      }

      position++;
    }

    throw syntaxError(this.source, position, "Unterminated string.");
  }

  private readBlockString(start: number, prev: Token): Token {
    const body = this.source.body;
    const bodyLength = body.length;
    const startLine = this.line;
    const startCol = start - this.lineStart + 1;
    let position = start + 3;
    let chunkStart = position;
    let rawValue = "";

    while (position < bodyLength) {
      const code = body.charCodeAt(position);
      if (
        code === 0x0022 &&
        body.charCodeAt(position + 1) === 0x0022 &&
        body.charCodeAt(position + 2) === 0x0022
      ) {
        rawValue += body.slice(chunkStart, position);
        const lines = rawValue.split(/\r\n|\n|\r/);
        const dedented = dedentBlockStringLines(lines).join("\n");
        return new Token(
          TokenKind.BLOCK_STRING,
          start,
          position + 3,
          startLine,
          startCol,
          dedented,
          prev,
        );
      }

      // Escaped triple-quote \"""
      if (
        code === 0x005c &&
        body.charCodeAt(position + 1) === 0x0022 &&
        body.charCodeAt(position + 2) === 0x0022 &&
        body.charCodeAt(position + 3) === 0x0022
      ) {
        rawValue += body.slice(chunkStart, position) + '"""';
        position += 4;
        chunkStart = position;
        continue;
      }

      if (code === 0x000a) {
        position++;
        this.line++;
        this.lineStart = position;
        continue;
      }
      if (code === 0x000d) {
        if (body.charCodeAt(position + 1) === 0x000a) {
          position += 2;
        } else {
          position++;
        }
        this.line++;
        this.lineStart = position;
        continue;
      }

      if (code < 0x0020 && code !== 0x0009) {
        throw syntaxError(
          this.source,
          position,
          `Invalid character within String: ${printCharCode(code)}.`,
        );
      }

      position++;
    }

    throw syntaxError(this.source, position, "Unterminated string.");
  }
}
