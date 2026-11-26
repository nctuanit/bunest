import * as vscode from "vscode";
import type { BunestWorkspaceSnapshot } from "@bunest/cli";
import type { BunestWorkspaceIndex } from "../workspace/workspace-index";

export interface QueryDecoratorContext {
  readonly sql: string;
  readonly sqlStartOffset: number;
  readonly sqlEndOffset: number;
  readonly cursorOffsetInSql: number;
  readonly methodName?: string;
  readonly methodParams: readonly string[];
  readonly sqlParamAliases: ReadonlyMap<string, number>;
  readonly hasSingleObjectParam: boolean;
}

export interface InlineSqlDiagnostic {
  readonly code: "BUNEST_SQL001" | "BUNEST_SQL002";
  readonly message: string;
  readonly severity: "error" | "warning" | "information";
  readonly startOffset: number;
  readonly endOffset: number;
  readonly paramName?: string;
  readonly methodLine?: number;
}

const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE FROM",
  "ORDER BY",
  "GROUP BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "INNER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "ON",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS NULL",
  "IS NOT NULL",
  "RETURNING",
  "DISTINCT",
  "COUNT(*)",
  "ASC",
  "DESC",
] as const;

/**
 * Parses method parameters immediately following a `@Query(...)` decorator.
 */
function parseFollowingMethodSignature(
  source: string,
  afterDecoratorOffset: number,
): {
  methodName?: string;
  methodParams: string[];
  sqlParamAliases: Map<string, number>;
  hasSingleObjectParam: boolean;
} {
  const slice = source.slice(afterDecoratorOffset, afterDecoratorOffset + 800);
  // Skip other decorators (e.g. @Modifying(), @Projection(...)) and whitespace
  const methodMatch =
    /(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([\s\S]*?)\)\s*(?::|\{)/.exec(
      slice,
    );
  if (!methodMatch) {
    return {
      methodParams: [],
      sqlParamAliases: new Map(),
      hasSingleObjectParam: false,
    };
  }
  const methodName = methodMatch[1];
  const rawParams = methodMatch[2] ?? "";
  const methodParams: string[] = [];
  const sqlParamAliases = new Map<string, number>();

  // Split top-level comma-separated parameters
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < rawParams.length; i++) {
    const ch = rawParams[i]!;
    if (ch === "(" || ch === "{" || ch === "[" || ch === "<") depth++;
    else if (ch === ")" || ch === "}" || ch === "]" || ch === ">") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);

  let hasSingleObjectParam = false;
  parts.forEach((raw, idx) => {
    const aliasMatch = /@(?:SqlParam|Param)\s*\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\)/.exec(
      raw,
    );
    if (aliasMatch?.[1]) {
      sqlParamAliases.set(aliasMatch[1], idx);
    }
    // Strip decorators from parameter declaration
    const withoutDecorators = raw.replace(/@[A-Za-z_$][A-Za-z0-9_$]*\s*(?:\([^)]*\))?\s*/g, "").trim();
    const nameMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*(?::([\s\S]*))?$/.exec(
      withoutDecorators,
    );
    if (nameMatch?.[1]) {
      methodParams.push(nameMatch[1]);
      if (parts.length === 1 && nameMatch[2]) {
        const typeText = nameMatch[2].trim();
        if (
          typeText.startsWith("{") ||
          /Record\s*</.test(typeText) ||
          /Params|Filter|Input|Dto/i.test(typeText)
        ) {
          hasSingleObjectParam = true;
        }
      }
    }
  });

  return { methodName, methodParams, sqlParamAliases, hasSingleObjectParam };
}

/**
 * Finds all `this.query("...")`, `this.queryOne("...")`, `this.execute("...")`,
 * and `@Query("...")` SQL string literals in a TypeScript file.
 */
export function findQueryDecoratorsInSource(
  source: string,
): Array<{
  sql: string;
  sqlStartOffset: number;
  sqlEndOffset: number;
  decoratorEndOffset: number;
  kind: "decorator" | "method-call";
  callParamKeys?: readonly string[];
}> {
  const results: Array<{
    sql: string;
    sqlStartOffset: number;
    sqlEndOffset: number;
    decoratorEndOffset: number;
    kind: "decorator" | "method-call";
    callParamKeys?: readonly string[];
  }> = [];

  // 1. `this.query(...)` / `this.queryOne(...)` / `this.execute(...)`
  const callRe =
    /\bthis\.(?:queryOne|query|execute)(?:<[^>]*>)?\s*\(\s*(['"`])([\s\S]*?)\1(?:\s*,\s*\{([^}]*)\})?/g;
  let cm: RegExpExecArray | null;
  while ((cm = callRe.exec(source)) !== null) {
    const quote = cm[1]!;
    const sql = cm[2] ?? "";
    const quoteIdx = source.indexOf(quote, cm.index + cm[0].indexOf("("));
    const sqlStartOffset = quoteIdx + 1;
    const sqlEndOffset = sqlStartOffset + sql.length;
    const callParamKeys: string[] = [];
    if (cm[3]) {
      for (const prop of cm[3].split(",")) {
        const keyMatch = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(prop);
        if (keyMatch?.[1]) callParamKeys.push(keyMatch[1]);
      }
    }
    results.push({
      sql,
      sqlStartOffset,
      sqlEndOffset,
      decoratorEndOffset: cm.index + cm[0].length,
      kind: "method-call",
      callParamKeys: cm[3] !== undefined ? callParamKeys : undefined,
    });
  }

  // 2. `@Query("...")`
  const re = /@Query\s*\(\s*(['"`])([\s\S]*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const quote = m[1]!;
    const sql = m[2] ?? "";
    const quoteIdx = source.indexOf(quote, m.index + m[0].indexOf("("));
    const sqlStartOffset = quoteIdx + 1;
    const sqlEndOffset = sqlStartOffset + sql.length;
    results.push({
      sql,
      sqlStartOffset,
      sqlEndOffset,
      decoratorEndOffset: m.index + m[0].length,
      kind: "decorator",
    });
  }
  return results;
}

/**
 * Returns SQL context if `offset` falls inside a `this.query("...")` or `@Query("...")` literal.
 */
export function extractQueryContextAtOffset(
  source: string,
  offset: number,
): QueryDecoratorContext | undefined {
  for (const match of findQueryDecoratorsInSource(source)) {
    if (offset >= match.sqlStartOffset && offset <= match.sqlEndOffset) {
      if (match.kind === "method-call") {
        return {
          sql: match.sql,
          sqlStartOffset: match.sqlStartOffset,
          sqlEndOffset: match.sqlEndOffset,
          cursorOffsetInSql: offset - match.sqlStartOffset,
          methodParams: match.callParamKeys ?? [],
          sqlParamAliases: new Map(),
          hasSingleObjectParam: false,
        };
      }
      const sig = parseFollowingMethodSignature(source, match.decoratorEndOffset);
      return {
        sql: match.sql,
        sqlStartOffset: match.sqlStartOffset,
        sqlEndOffset: match.sqlEndOffset,
        cursorOffsetInSql: offset - match.sqlStartOffset,
        ...sig,
      };
    }
  }
  return undefined;
}

/**
 * Scans a TypeScript source file for inline SQL parameter mismatches (`BUNEST_SQL001`)
 * and legacy `as unknown as Promise<...>` stub casts (`BUNEST_SQL002`).
 */
export function findInlineSqlDiagnostics(
  source: string,
): InlineSqlDiagnostic[] {
  const diagnostics: InlineSqlDiagnostic[] = [];

  for (const match of findQueryDecoratorsInSource(source)) {
    if (match.kind === "method-call") {
      if (match.callParamKeys !== undefined) {
        const knownKeys = new Set(match.callParamKeys);
        const paramRe = /(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g;
        let pm: RegExpExecArray | null;
        while ((pm = paramRe.exec(match.sql)) !== null) {
          const name = pm[1]!;
          if (!knownKeys.has(name)) {
            diagnostics.push({
              code: "BUNEST_SQL001",
              severity: "error",
              message: `SQL placeholder ":${name}" is missing from the parameter object passed to this.query/queryOne/execute().`,
              startOffset: match.sqlStartOffset + pm.index,
              endOffset: match.sqlStartOffset + pm.index + pm[0].length,
              paramName: name,
            });
          }
        }
      }
      continue;
    }

    const sig = parseFollowingMethodSignature(source, match.decoratorEndOffset);
    if (!sig.methodName) continue;

    // 1. Validate :named placeholders (skip PostgreSQL ::type casts)
    if (!sig.hasSingleObjectParam) {
      const knownNames = new Set<string>();
      for (const alias of sig.sqlParamAliases.keys()) {
        knownNames.add(alias);
      }
      if (sig.sqlParamAliases.size === 0) {
        for (const p of sig.methodParams) {
          knownNames.add(p);
          const stripped = p.replace(/^_+/, "");
          if (stripped) knownNames.add(stripped);
        }
      }

      const paramRe = /(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g;
      let pm: RegExpExecArray | null;
      while ((pm = paramRe.exec(match.sql)) !== null) {
        const name = pm[1]!;
        if (!knownNames.has(name)) {
          diagnostics.push({
            code: "BUNEST_SQL001",
            severity: "error",
            message: `@Query placeholder ":${name}" on ${sig.methodName}() does not match any @SqlParam("${name}") or method parameter.`,
            startOffset: match.sqlStartOffset + pm.index,
            endOffset: match.sqlStartOffset + pm.index + pm[0].length,
            paramName: name,
          });
        }
      }
    }

    // 2. Suggest `return generatedQuery()` instead of `return ... as unknown as Promise<...>`
    const afterSlice = source.slice(
      match.decoratorEndOffset,
      match.decoratorEndOffset + 700,
    );
    const castMatch =
      /return\s+[^;\n]+?\s+as\s+unknown\s+as\s+Promise<[^>]+>\s*;?/.exec(
        afterSlice,
      );
    if (castMatch) {
      const start = match.decoratorEndOffset + castMatch.index;
      diagnostics.push({
        code: "BUNEST_SQL002",
        severity: "information",
        message: `Prefer \`return generatedQuery();\` from "@bunest/orm" instead of \`as unknown as Promise<...>\` stub cast.`,
        startOffset: start,
        endOffset: start + castMatch[0].length,
      });
    }
  }

  return diagnostics;
}

function collectEntitySchema(snapshots: readonly BunestWorkspaceSnapshot[]): {
  tables: Array<{ tableName: string; entityName: string; columns: Array<{ dbName: string; propName: string; typeText: string }> }>;
} {
  const tables: Array<{
    tableName: string;
    entityName: string;
    columns: Array<{ dbName: string; propName: string; typeText: string }>;
  }> = [];
  const seen = new Set<string>();

  for (const snap of snapshots) {
    for (const ent of snap.entities) {
      const tableName = ent.tableName || ent.className.toLowerCase();
      if (seen.has(tableName)) continue;
      seen.add(tableName);
      const columns = ent.fields.map((f) => ({
        dbName:
          f.columnName ||
          f.propertyName
            .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
            .toLowerCase(),
        propName: f.propertyName,
        typeText: f.tsType,
      }));
      tables.push({ tableName, entityName: ent.className, columns });
    }
  }

  return { tables };
}

/**
 * Provides IntelliSense inside `@Query("...")` SQL strings:
 * - `:paramName` completions from method parameters & `@SqlParam(...)`
 * - Table name completions from workspace `@Entity()` classes
 * - Column name completions from workspace `@Entity()` fields
 * - Standard SQL keyword completions
 */
export class BunestSqlCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(private readonly index: BunestWorkspaceIndex) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const source = document.getText();
    const offset = document.offsetAt(position);
    const ctx = extractQueryContextAtOffset(source, offset);
    if (!ctx) return [];

    const prefix = ctx.sql.slice(0, ctx.cursorOffsetInSql);
    const items: vscode.CompletionItem[] = [];

    // 1. Named placeholder completion after `:` (not `::` Postgres cast)
    if (/(?<!:):[A-Za-z0-9_]*$/.test(prefix)) {
      const seen = new Set<string>();
      for (const alias of ctx.sqlParamAliases.keys()) {
        seen.add(alias);
        const item = new vscode.CompletionItem(
          alias,
          vscode.CompletionItemKind.Variable,
        );
        item.detail = `@SqlParam("${alias}")`;
        item.sortText = `0_${alias}`;
        items.push(item);
      }
      for (const p of ctx.methodParams) {
        const clean = p.replace(/^_+/, "") || p;
        if (seen.has(clean)) continue;
        seen.add(clean);
        const item = new vscode.CompletionItem(
          clean,
          vscode.CompletionItemKind.Variable,
        );
        item.detail = `Method parameter (${p})`;
        item.sortText = `0_${clean}`;
        items.push(item);
      }
      return items;
    }

    const { tables } = collectEntitySchema(this.index.getAllSnapshots());

    // 2. Table completion after FROM / JOIN / INTO / UPDATE
    if (/\b(?:FROM|JOIN|INTO|UPDATE)\s+[A-Za-z0-9_]*$/i.test(prefix)) {
      for (const t of tables) {
        const item = new vscode.CompletionItem(
          t.tableName,
          vscode.CompletionItemKind.Struct,
        );
        item.detail = `@Entity("${t.tableName}") ${t.entityName}`;
        item.documentation = new vscode.MarkdownString(
          `Columns: ${t.columns.map((c) => `\`${c.dbName}\``).join(", ") || "(none)"}`,
        );
        item.sortText = `0_${t.tableName}`;
        items.push(item);
      }
      return items;
    }

    // 3. Column completions (qualified `table.col` or unqualified)
    const tableDotMatch = /\b([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z0-9_]*$/.exec(
      prefix,
    );
    const targetTables = tableDotMatch
      ? tables.filter(
          (t) =>
            t.tableName.toLowerCase() === tableDotMatch[1]!.toLowerCase(),
        )
      : tables;

    const seenCols = new Set<string>();
    for (const t of targetTables) {
      for (const col of t.columns) {
        const key = `${t.tableName}.${col.dbName}`;
        if (seenCols.has(key)) continue;
        seenCols.add(key);
        const item = new vscode.CompletionItem(
          col.dbName,
          vscode.CompletionItemKind.Field,
        );
        item.detail = `${t.tableName}.${col.dbName}: ${col.typeText}`;
        item.documentation = `Entity property \`${t.entityName}.${col.propName}\``;
        item.sortText = `1_${col.dbName}`;
        items.push(item);
      }
    }

    if (!tableDotMatch) {
      for (const t of tables) {
        const item = new vscode.CompletionItem(
          t.tableName,
          vscode.CompletionItemKind.Struct,
        );
        item.detail = `Table (${t.entityName})`;
        item.sortText = `2_${t.tableName}`;
        items.push(item);
      }
      for (const kw of SQL_KEYWORDS) {
        const item = new vscode.CompletionItem(
          kw,
          vscode.CompletionItemKind.Keyword,
        );
        item.sortText = `3_${kw}`;
        items.push(item);
      }
    }

    return items;
  }
}
