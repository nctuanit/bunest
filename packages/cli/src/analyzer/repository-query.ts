import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type MethodDeclaration,
  type Project,
  type SourceFile,
  type Type as TsType,
} from "../ast";
import {
  collectCustomQueryOperators,
  type BunestConfigLike,
  type CustomQueryOperatorConfigLike,
} from "../config/bunest-config.loader";
import {
  BUILTIN_ENTITY_DECORATOR_NAMES,
  BUILTIN_ORM_COLUMN_DECORATOR_NAMES,
  BUILTIN_ORM_PRIMARY_COLUMN_DECORATOR_NAMES,
  BUILTIN_REPOSITORY_DECORATOR_NAMES,
  parseBaseEntityDecoratorAst,
  resolveComposedDecorators,
  type ResolvedDecoratorEntry,
} from "../decorators";
import { nodeToLocation } from "../typegen/scanner";
import type { SourceLocation } from "../typegen/types";

export type RepoSqlDialect = "sqlite" | "postgres" | "mysql";
export type EntityFieldCategory =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "other";

export interface EntityFieldInfo {
  readonly propertyName: string;
  readonly columnName: string;
  readonly tsType: string;
  readonly category: EntityFieldCategory;
  readonly nullable: boolean;
  readonly primary: boolean;
  readonly unique: boolean;
  readonly indexed: boolean;
  readonly location: SourceLocation;
}

export interface AnalyzedEntity {
  readonly className: string;
  readonly tableName: string;
  readonly idColumn: string;
  readonly idPropertyName: string;
  readonly idTsType: string;
  readonly camelCaseMapping: boolean;
  readonly sourceFile: string;
  readonly location: SourceLocation;
  readonly fields: readonly EntityFieldInfo[];
}

export interface DerivedConditionToken {
  readonly rawPropertySegment: string;
  readonly propertyName?: string;
  readonly columnName?: string;
  readonly field?: EntityFieldInfo;
  readonly operator: string;
  readonly ignoreCase: boolean;
  readonly combinator?: "AND" | "OR";
  /** Character offset of `rawPropertySegment` inside the method name. */
  readonly segmentStart: number;
  readonly segmentEnd: number;
  readonly expectedParamCount: number;
  readonly expectedParamTypes: readonly string[];
}

export interface DerivedOrderToken {
  readonly rawPropertySegment: string;
  readonly propertyName?: string;
  readonly columnName?: string;
  readonly field?: EntityFieldInfo;
  readonly direction: "ASC" | "DESC";
  readonly segmentStart: number;
  readonly segmentEnd: number;
}

export type DerivedQueryKind =
  | "findAll"
  | "findOne"
  | "findPage"
  | "findCursor"
  | "exists"
  | "count"
  | "delete";

export interface RepositoryScopeInfo {
  readonly name: string;
  readonly kind: "softDelete" | "tenant" | "custom";
  readonly column?: string;
  readonly property?: string;
}

export interface ParsedDerivedQuery {
  readonly methodName: string;
  readonly kind: DerivedQueryKind;
  readonly limit?: number;
  readonly conditions: readonly DerivedConditionToken[];
  readonly orderBy: readonly DerivedOrderToken[];
  readonly projectedFields?: readonly string[];
  readonly activeScopes?: readonly string[];
  readonly expectedParamCount: number;
  readonly expectedParams: readonly { readonly name: string; readonly tsType: string }[];
  readonly expectedReturnType: string;
  readonly sqlPreview: string;
  readonly sqlByDialect: Readonly<Record<RepoSqlDialect, string>>;
  readonly unknownProperties: readonly {
    readonly raw: string;
    readonly suggestion?: string;
    readonly segmentStart: number;
    readonly segmentEnd: number;
  }[];
  readonly operatorTypeErrors: readonly {
    readonly propertyName: string;
    readonly operator: string;
    readonly fieldCategory: EntityFieldCategory;
    readonly reason: string;
  }[];
}

export interface AnalyzedQueryMethod {
  readonly name: string;
  readonly kind: "derived" | "customQuery" | "crud" | "concrete";
  readonly isAbstract: boolean;
  readonly location: SourceLocation;
  readonly methodStart: number;
  readonly methodEnd: number;
  readonly params: readonly {
    readonly name: string;
    readonly tsType: string;
    readonly sqlParamName?: string;
    readonly location: SourceLocation;
  }[];
  readonly returnTypeText: string;
  readonly projectedFields?: readonly string[];
  readonly ignoredScopes?: readonly string[];
  readonly ignoreAllScopes?: boolean;
  readonly derived?: ParsedDerivedQuery;
  readonly customQuery?: {
    readonly sql: string;
    readonly isModifying: boolean;
    readonly namedPlaceholders: readonly string[];
    readonly positionalCount: number;
    readonly isWriteSql: boolean;
    readonly decoratorLocation: SourceLocation;
  };
}

export interface AnalyzedRepository {
  readonly className: string;
  readonly driver: "orm";
  readonly dialect: RepoSqlDialect;
  readonly baseClassName: string;
  readonly hasRepositoryDecorator: boolean;
  readonly entityName?: string;
  readonly entity?: AnalyzedEntity;
  readonly tableName: string;
  readonly idColumn: string;
  readonly idTsType: string;
  readonly camelCaseMapping: boolean;
  readonly scopes?: readonly RepositoryScopeInfo[];
  readonly sourceFile: string;
  readonly location: SourceLocation;
  readonly methods: readonly AnalyzedQueryMethod[];
}

export interface RepositoryCompletionItem {
  readonly label: string;
  readonly insertText: string;
  readonly detail: string;
  readonly documentation?: string;
  readonly kind: "prefix" | "property" | "operator" | "combinator" | "order" | "fullMethod";
  readonly sortText: string;
}

export interface RepositoryDiagnostic {
  readonly code:
    | "BUNEST_REPO001"
    | "BUNEST_REPO002"
    | "BUNEST_REPO003"
    | "BUNEST_REPO004"
    | "BUNEST_REPO005"
    | "BUNEST_REPO006"
    | "BUNEST_REPO007";
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly location: SourceLocation;
  readonly fixData?: {
    readonly kind:
      | "renameDerivedProperty"
      | "addModifyingDecorator"
      | "addRepositoryDecorator"
      | "fixReturnType";
    readonly replacement?: string;
    readonly entityName?: string;
    readonly driver?: "orm";
  };
}

// ============================================================================
// Exact Operator & Prefix Tables (Synced 1:1 with @bunest/orm)
// ============================================================================

interface OperatorSpec {
  readonly suffix: string;
  readonly paramCount: number;
  readonly expectsArrayParam?: boolean;
  readonly allowedCategories?: readonly EntityFieldCategory[];
  readonly description?: string;
  readonly isCustom?: boolean;
  readonly customOp?: CustomQueryOperatorConfigLike;
  readonly sqlOp: (
    col: string,
    p1: string,
    p2: string,
    ignoreCase: boolean,
  ) => string;
}

function buildCombinedOperators(
  customOperators: readonly CustomQueryOperatorConfigLike[],
): readonly OperatorSpec[] {
  if (customOperators.length === 0) return OPERATORS;

  const bySuffix = new Map<string, OperatorSpec>();
  for (const op of OPERATORS) {
    bySuffix.set(op.suffix, op);
  }
  for (const custom of customOperators) {
    bySuffix.set(custom.suffix, {
      suffix: custom.suffix,
      paramCount: Math.max(0, custom.arity),
      expectsArrayParam: custom.expectsArrayParam,
      allowedCategories: custom.allowedCategories,
      description: custom.description,
      isCustom: true,
      customOp: custom,
      sqlOp: (c, p1) => (p1 ? `${c} /* ${custom.suffix} */ ${p1}` : `${c} /* ${custom.suffix} */`),
    });
  }

  return [...bySuffix.values()].sort(
    (a, b) => b.suffix.length - a.suffix.length,
  );
}

const OPERATORS: readonly OperatorSpec[] = [
  {
    suffix: "GreaterThanEqual",
    paramCount: 1,
    allowedCategories: ["number", "date", "string", "other"],
    sqlOp: (c, p1) => `${c} >= ${p1}`,
  },
  {
    suffix: "LessThanEqual",
    paramCount: 1,
    allowedCategories: ["number", "date", "string", "other"],
    sqlOp: (c, p1) => `${c} <= ${p1}`,
  },
  {
    suffix: "NotContaining",
    paramCount: 1,
    allowedCategories: ["string"],
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) NOT LIKE LOWER(${p1})` : `${c} NOT LIKE ${p1}`,
  },
  {
    suffix: "StartingWith",
    paramCount: 1,
    allowedCategories: ["string"],
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) LIKE LOWER(${p1})` : `${c} LIKE ${p1}`,
  },
  {
    suffix: "GreaterThan",
    paramCount: 1,
    allowedCategories: ["number", "date", "string", "other"],
    sqlOp: (c, p1) => `${c} > ${p1}`,
  },
  {
    suffix: "EndingWith",
    paramCount: 1,
    allowedCategories: ["string"],
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) LIKE LOWER(${p1})` : `${c} LIKE ${p1}`,
  },
  {
    suffix: "Containing",
    paramCount: 1,
    allowedCategories: ["string"],
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) LIKE LOWER(${p1})` : `${c} LIKE ${p1}`,
  },
  {
    suffix: "StartsWith",
    paramCount: 1,
    allowedCategories: ["string"],
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) LIKE LOWER(${p1})` : `${c} LIKE ${p1}`,
  },
  {
    suffix: "IsNotNull",
    paramCount: 0,
    sqlOp: (c) => `${c} IS NOT NULL`,
  },
  {
    suffix: "NotEquals",
    paramCount: 1,
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) <> LOWER(${p1})` : `${c} <> ${p1}`,
  },
  {
    suffix: "LessThan",
    paramCount: 1,
    allowedCategories: ["number", "date", "string", "other"],
    sqlOp: (c, p1) => `${c} < ${p1}`,
  },
  {
    suffix: "Contains",
    paramCount: 1,
    allowedCategories: ["string"],
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) LIKE LOWER(${p1})` : `${c} LIKE ${p1}`,
  },
  {
    suffix: "EndsWith",
    paramCount: 1,
    allowedCategories: ["string"],
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) LIKE LOWER(${p1})` : `${c} LIKE ${p1}`,
  },
  {
    suffix: "NotNull",
    paramCount: 0,
    sqlOp: (c) => `${c} IS NOT NULL`,
  },
  {
    suffix: "NotLike",
    paramCount: 1,
    allowedCategories: ["string"],
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) NOT LIKE LOWER(${p1})` : `${c} NOT LIKE ${p1}`,
  },
  {
    suffix: "Between",
    paramCount: 2,
    allowedCategories: ["number", "date", "string", "other"],
    sqlOp: (c, p1, p2) => `${c} BETWEEN ${p1} AND ${p2}`,
  },
  {
    suffix: "IsFalse",
    paramCount: 0,
    allowedCategories: ["boolean", "number"],
    sqlOp: (c) => `${c} = 0`,
  },
  {
    suffix: "IsNull",
    paramCount: 0,
    sqlOp: (c) => `${c} IS NULL`,
  },
  {
    suffix: "IsTrue",
    paramCount: 0,
    allowedCategories: ["boolean", "number"],
    sqlOp: (c) => `${c} = 1`,
  },
  {
    suffix: "Equals",
    paramCount: 1,
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) = LOWER(${p1})` : `${c} = ${p1}`,
  },
  {
    suffix: "IsNot",
    paramCount: 1,
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) <> LOWER(${p1})` : `${c} <> ${p1}`,
  },
  {
    suffix: "NotIn",
    paramCount: 1,
    expectsArrayParam: true,
    sqlOp: (c, p1) => `${c} NOT IN (${p1})`,
  },
  {
    suffix: "Like",
    paramCount: 1,
    allowedCategories: ["string"],
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) LIKE LOWER(${p1})` : `${c} LIKE ${p1}`,
  },
  {
    suffix: "Gte",
    paramCount: 1,
    allowedCategories: ["number", "date", "string", "other"],
    sqlOp: (c, p1) => `${c} >= ${p1}`,
  },
  {
    suffix: "Lte",
    paramCount: 1,
    allowedCategories: ["number", "date", "string", "other"],
    sqlOp: (c, p1) => `${c} <= ${p1}`,
  },
  {
    suffix: "Not",
    paramCount: 1,
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) <> LOWER(${p1})` : `${c} <> ${p1}`,
  },
  {
    suffix: "In",
    paramCount: 1,
    expectsArrayParam: true,
    sqlOp: (c, p1) => `${c} IN (${p1})`,
  },
  {
    suffix: "Gt",
    paramCount: 1,
    allowedCategories: ["number", "date", "string", "other"],
    sqlOp: (c, p1) => `${c} > ${p1}`,
  },
  {
    suffix: "Lt",
    paramCount: 1,
    allowedCategories: ["number", "date", "string", "other"],
    sqlOp: (c, p1) => `${c} < ${p1}`,
  },
  {
    suffix: "Is",
    paramCount: 1,
    sqlOp: (c, p1, _p2, ic) =>
      ic ? `LOWER(${c}) = LOWER(${p1})` : `${c} = ${p1}`,
  },
];

const CRUD_BASE_METHOD_NAMES = new Set([
  "findById",
  "findByIdOrFail",
  "findAll",
  "save",
  "saveMany",
  "deleteById",
  "softDeleteById",
  "restoreById",
  "hardDeleteById",
  "findCursorPage",
  "count",
  "existsById",
]);

const CRUD_REPO_BASE_CLASSES = new Set([
  "CrudRepository",
]);

const REPOSITORY_DECORATORS = BUILTIN_REPOSITORY_DECORATOR_NAMES;

const ENTITY_DECORATORS = BUILTIN_ENTITY_DECORATOR_NAMES;

// ============================================================================
// String / Naming / Fuzzy Helpers
// ============================================================================

function camelToSnake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function lowerFirst(input: string): string {
  return input.length === 0 ? input : input[0]!.toLowerCase() + input.slice(1);
}

function capitalize(input: string): string {
  return input.length === 0 ? input : input[0]!.toUpperCase() + input.slice(1);
}

function pluralizeTable(word: string): string {
  const cleaned = word.replace(/Entity$/i, "") || word;
  const snake = camelToSnake(cleaned);
  if (/(?:s|x|z|ch|sh)$/i.test(snake)) return `${snake}es`;
  if (/[^aeiou]y$/i.test(snake)) return `${snake.slice(0, -1)}ies`;
  return `${snake}s`;
}

function quoteIdent(ident: string, dialect: RepoSqlDialect): string {
  if (dialect === "mysql") return `\`${ident}\``;
  return `"${ident}"`;
}

export function levenshteinDistance(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  const m = al.length;
  const n = bl.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]!;
      const cost = al[i - 1] === bl[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[n]!;
}

export function findClosestMatch(
  target: string,
  candidates: readonly string[],
  maxDist = 3,
): string | undefined {
  let best: string | undefined;
  let bestDist = maxDist + 1;
  for (const cand of candidates) {
    const d = levenshteinDistance(target, cand);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  return best;
}

function classifyTsType(tsType: TsType, text: string): EntityFieldCategory {
  const nonNull = tsType.getNonNullableType();
  if (nonNull.isString() || nonNull.isStringLiteral()) return "string";
  if (nonNull.isNumber() || nonNull.isNumberLiteral()) return "number";
  if (nonNull.isBoolean() || nonNull.isBooleanLiteral()) return "boolean";
  const sym = nonNull.getSymbol()?.getName();
  if (sym === "Date" || /\bDate\b/.test(text)) return "date";
  if (/\bstring\b/.test(text)) return "string";
  if (/\bnumber\b|\bbigint\b/.test(text)) return "number";
  if (/\bboolean\b/.test(text)) return "boolean";
  return "other";
}

function getDecoratorShortName(dec: Decorator): string {
  const name = dec.getName();
  const idx = name.lastIndexOf(".");
  return idx !== -1 ? name.slice(idx + 1) : name;
}

function extractStringLiteral(expr: Expression | undefined): string | undefined {
  if (!expr) return undefined;
  if (
    Node.isStringLiteral(expr) ||
    Node.isNoSubstitutionTemplateLiteral(expr)
  ) {
    return expr.getLiteralValue();
  }
  return undefined;
}

function getObjectProp(
  expr: Expression | undefined,
  name: string,
): Expression | undefined {
  if (!expr || !Node.isObjectLiteralExpression(expr)) return undefined;
  const prop = expr.getProperty(name);
  if (prop && Node.isPropertyAssignment(prop)) return prop.getInitializer();
  return undefined;
}

// ============================================================================
// Entity Inspector
// ============================================================================

export function analyzeEntityClass(cls: ClassDeclaration): AnalyzedEntity {
  const className = cls.getName() ?? "AnonymousEntity";
  const filePath = cls.getSourceFile().getFilePath();
  let tableName = pluralizeTable(className);
  let idColumn = "id";
  let idPropertyName = "id";
  let idTsType = "number";
  let camelCaseMapping = true;

  let baseEntityEntry: ResolvedDecoratorEntry | undefined;
  let hasExplicitTable = false;

  for (const entry of resolveComposedDecorators(cls)) {
    const short = entry.name;
    if (!ENTITY_DECORATORS.has(short)) continue;
    if (short === "BaseEntity") {
      if (!baseEntityEntry || !entry.composedFrom) {
        baseEntityEntry = entry;
      }
    }
    const arg0 = entry.resolvedArgs[0];
    const strArg = extractStringLiteral(arg0);
    if (strArg) {
      if (short === "Entity" || !hasExplicitTable) {
        tableName = strArg;
        hasExplicitTable = true;
      }
    } else if (arg0 && Node.isObjectLiteralExpression(arg0)) {
      const tName =
        extractStringLiteral(getObjectProp(arg0, "tableName")) ??
        extractStringLiteral(getObjectProp(arg0, "name")) ??
        extractStringLiteral(getObjectProp(arg0, "table"));
      if (tName && (short === "Entity" || !hasExplicitTable)) {
        tableName = tName;
        hasExplicitTable = true;
      }
      if (
        getObjectProp(arg0, "camelCaseMapping")?.getKind() ===
        SyntaxKind.FalseKeyword
      ) {
        camelCaseMapping = false;
      }
      const idColExpr = getObjectProp(arg0, "idColumn");
      const idCol =
        extractStringLiteral(idColExpr) ??
        extractStringLiteral(getObjectProp(idColExpr, "name"));
      if (idCol) idColumn = idCol;
    }
  }

  const fields: EntityFieldInfo[] = [];
  for (const prop of cls.getProperties()) {
    if (prop.isStatic()) continue;
    const propertyName = prop.getName();
    const rawType = prop.getType();
    const nonNull = rawType.getNonNullableType();
    const tsTypeText =
      prop.getTypeNode()?.getText().trim() ?? nonNull.getText(prop);
    const category = classifyTsType(rawType, tsTypeText);

    let columnName = camelCaseMapping
      ? camelToSnake(propertyName)
      : propertyName;
    let nullable = prop.hasQuestionToken() || rawType.isNullable();
    let primary = propertyName === "id";
    let unique = false;
    let indexed = false;

    for (const dec of prop.getDecorators()) {
      const short = getDecoratorShortName(dec);
      const arg0 = dec.getArguments()[0] as Expression | undefined;
      if (BUILTIN_ORM_COLUMN_DECORATOR_NAMES.has(short)) {
        const explicitName =
          extractStringLiteral(arg0) ??
          extractStringLiteral(getObjectProp(arg0, "name"));
        if (explicitName) columnName = explicitName;
        if (
          getObjectProp(arg0, "nullable")?.getKind() === SyntaxKind.TrueKeyword
        ) {
          nullable = true;
        }
        if (
          getObjectProp(arg0, "unique")?.getKind() === SyntaxKind.TrueKeyword
        ) {
          unique = true;
        }
      } else if (BUILTIN_ORM_PRIMARY_COLUMN_DECORATOR_NAMES.has(short)) {
        primary = true;
        const explicitName = extractStringLiteral(getObjectProp(arg0, "name"));
        if (explicitName) columnName = explicitName;
      } else if (short === "Unique") {
        unique = true;
      } else if (short === "Index") {
        indexed = true;
      }
    }

    if (primary) {
      idColumn = columnName;
      idPropertyName = propertyName;
      idTsType =
        tsTypeText.replace(/\s*\|\s*(?:null|undefined)/g, "").trim() ||
        "number";
    }

    fields.push({
      propertyName,
      columnName,
      tsType: tsTypeText,
      category,
      nullable,
      primary,
      unique,
      indexed,
      location: nodeToLocation(prop.getNameNode()),
    });
  }

  // Synthesize base entity columns (`id`, `createdAt`, `updatedAt`, `deletedAt`) via shared single-source parser
  if (baseEntityEntry) {
    const existingNames = new Set(fields.map((f) => f.propertyName));
    const baseLoc = nodeToLocation(baseEntityEntry.sourceDecorator);
    const parsedBase = parseBaseEntityDecoratorAst({
      decorator: baseEntityEntry.sourceDecorator,
      arg0: baseEntityEntry.resolvedArgs[0],
      typeArgNode: baseEntityEntry.resolvedTypeArgNodes[0],
      ...(baseEntityEntry.composedFrom &&
      baseEntityEntry.resolvedTypeArgTexts[0]
        ? { keyTypeOverride: baseEntityEntry.resolvedTypeArgTexts[0] }
        : {}),
    });

    for (const bf of parsedBase.fields) {
      if (existingNames.has(bf.name)) continue;
      const colName =
        bf.columnName ??
        (camelCaseMapping ? camelToSnake(bf.name) : bf.name);
      if (bf.role === "id") {
        const keyCat: EntityFieldCategory = /\bstring\b/.test(bf.typeText)
          ? "string"
          : /\bnumber\b|\bbigint\b/.test(bf.typeText)
            ? "number"
            : "other";
        fields.unshift({
          propertyName: bf.name,
          columnName: colName,
          tsType: bf.typeText,
          category: keyCat,
          nullable: false,
          primary: true,
          unique: false,
          indexed: false,
          location: baseLoc,
        });
        if (!fields.some((f, idx) => idx > 0 && f.primary)) {
          idColumn = colName;
          idPropertyName = bf.name;
          idTsType = bf.typeText;
        }
      } else {
        fields.push({
          propertyName: bf.name,
          columnName: colName,
          tsType: bf.typeText,
          category: "date",
          nullable: bf.optional,
          primary: false,
          unique: false,
          indexed: false,
          location: baseLoc,
        });
      }
    }
  }

  return {
    className,
    tableName,
    idColumn,
    idPropertyName,
    idTsType,
    camelCaseMapping,
    sourceFile: filePath,
    location: nodeToLocation(cls.getNameNode() ?? cls),
    fields,
  };
}

// ============================================================================
// Derived Query Parser & Multi-Dialect SQL Compiler Preview
// ============================================================================

interface DerivedPrefixMatch {
  readonly kind: DerivedQueryKind;
  readonly limit?: number;
  readonly rest: string;
  readonly restOffset: number;
  readonly orderOnly?: boolean;
}

export function matchDerivedPrefix(
  methodName: string,
): DerivedPrefixMatch | undefined {
  const patterns: Array<{
    re: RegExp;
    kind: DerivedQueryKind;
    hasLimit?: boolean;
    orderOnly?: boolean;
  }> = [
    { re: /^findPageBy(?=[A-Z])/, kind: "findPage" },
    { re: /^findPageOrderBy(?=[A-Z])/, kind: "findPage", orderOnly: true },
    { re: /^findCursorBy(?=[A-Z])/, kind: "findCursor" },
    { re: /^findCursorOrderBy(?=[A-Z])/, kind: "findCursor", orderOnly: true },
    { re: /^findAllBy(?=[A-Z])/, kind: "findAll" },
    { re: /^findAllOrderBy(?=[A-Z])/, kind: "findAll", orderOnly: true },
    { re: /^findOneBy(?=[A-Z])/, kind: "findOne", hasLimit: false },
    { re: /^findFirst(\d*)By(?=[A-Z])/, kind: "findOne", hasLimit: true },
    { re: /^findTop(\d+)By(?=[A-Z])/, kind: "findAll", hasLimit: true },
    { re: /^findBy(?=[A-Z])/, kind: "findOne" },
    { re: /^existsBy(?=[A-Z])/, kind: "exists" },
    { re: /^countBy(?=[A-Z])/, kind: "count" },
    { re: /^deleteBy(?=[A-Z])/, kind: "delete" },
    { re: /^removeBy(?=[A-Z])/, kind: "delete" },
  ];

  for (const p of patterns) {
    const m = p.re.exec(methodName);
    if (!m) continue;
    let limit: number | undefined;
    let kind = p.kind;
    if (p.hasLimit) {
      const n = m[1] ? Number(m[1]) : 1;
      limit = Number.isFinite(n) && n > 0 ? n : 1;
      if (limit > 1) kind = "findAll";
      else if (limit === 1 && methodName.startsWith("findFirst")) kind = "findOne";
    }
    return {
      kind,
      limit,
      rest: methodName.slice(m[0].length),
      restOffset: m[0].length,
      orderOnly: p.orderOnly,
    };
  }
  return undefined;
}

function splitCombinators(
  segment: string,
  baseOffset: number,
): Array<{
  readonly text: string;
  readonly startOffset: number;
  readonly combinator?: "AND" | "OR";
}> {
  const out: Array<{
    readonly text: string;
    readonly startOffset: number;
    readonly combinator?: "AND" | "OR";
  }> = [];
  const re = /(And|Or)(?=[A-Z])/g;
  let lastIndex = 0;
  let pendingComb: "AND" | "OR" | undefined;
  let match: RegExpExecArray | null;

  while ((match = re.exec(segment)) !== null) {
    out.push({
      text: segment.slice(lastIndex, match.index),
      startOffset: baseOffset + lastIndex,
      combinator: pendingComb,
    });
    pendingComb = match[1] === "Or" ? "OR" : "AND";
    lastIndex = match.index + match[1]!.length;
  }
  out.push({
    text: segment.slice(lastIndex),
    startOffset: baseOffset + lastIndex,
    combinator: pendingComb,
  });
  return out;
}

function parseOrderByClause(
  orderPart: string,
  baseOffset: number,
  entity?: AnalyzedEntity,
): DerivedOrderToken[] {
  const out: DerivedOrderToken[] = [];
  const re = /([A-Z][A-Za-z0-9]*?)(Asc|Desc)(?=[A-Z]|$)/g;
  let match: RegExpExecArray | null;
  let matchedAny = false;

  while ((match = re.exec(orderPart)) !== null) {
    matchedAny = true;
    const rawProp = match[1]!;
    const dir = match[2] === "Desc" ? "DESC" : "ASC";
    const field = resolveEntityField(rawProp, entity);
    out.push({
      rawPropertySegment: rawProp,
      propertyName: field?.propertyName ?? lowerFirst(rawProp),
      columnName: field?.columnName ?? camelToSnake(rawProp),
      field,
      direction: dir,
      segmentStart: baseOffset + match.index,
      segmentEnd: baseOffset + match.index + rawProp.length,
    });
  }

  if (!matchedAny && orderPart.length > 0) {
    const field = resolveEntityField(orderPart, entity);
    out.push({
      rawPropertySegment: orderPart,
      propertyName: field?.propertyName ?? lowerFirst(orderPart),
      columnName: field?.columnName ?? camelToSnake(orderPart),
      field,
      direction: "ASC",
      segmentStart: baseOffset,
      segmentEnd: baseOffset + orderPart.length,
    });
  }

  return out;
}

function resolveEntityField(
  pascalSegment: string,
  entity?: AnalyzedEntity,
): EntityFieldInfo | undefined {
  if (!entity) return undefined;
  const lower = lowerFirst(pascalSegment);
  const direct = entity.fields.find((f) => f.propertyName === lower);
  if (direct) return direct;
  const snake = camelToSnake(pascalSegment);
  return entity.fields.find(
    (f) =>
      f.propertyName.toLowerCase() === pascalSegment.toLowerCase() ||
      f.columnName.toLowerCase() === snake,
  );
}

function renderSqlForDialect(
  kind: DerivedQueryKind,
  tableName: string,
  conditions: readonly DerivedConditionToken[],
  orderBy: readonly DerivedOrderToken[],
  limit: number | undefined,
  dialect: RepoSqlDialect,
  options?: {
    readonly operators?: readonly OperatorSpec[];
    readonly projectedColumns?: readonly string[];
    readonly activeScopes?: readonly RepositoryScopeInfo[];
    readonly idColumn?: string;
  },
): string {
  const operators = options?.operators ?? OPERATORS;
  const qTable = quoteIdent(tableName, dialect);
  let paramIdx = 0;
  const nextPlaceholder = (): string => {
    paramIdx++;
    return dialect === "postgres" ? `$${paramIdx}` : "?";
  };

  let condSql = "";
  let hasOrCondition = false;
  if (conditions.length > 0) {
    const pieces: string[] = [];
    for (const cond of conditions) {
      const rawCol = cond.columnName ?? camelToSnake(cond.rawPropertySegment);
      const col = quoteIdent(rawCol, dialect);
      const spec = operators.find((o) => o.suffix === cond.operator);
      let expr: string;
      if (spec?.isCustom && spec.customOp?.toSql) {
        let allocatedCount = 0;
        const alloc = (): string => {
          allocatedCount++;
          return nextPlaceholder();
        };
        try {
          const compiled = spec.customOp.toSql({
            column: rawCol,
            quotedColumn: col,
            property: cond.propertyName ?? rawCol,
            propertyName: cond.propertyName ?? rawCol,
            dialect,
            args: Array.from(
              { length: Math.max(0, spec.customOp.arity) },
              (_, i) => `$arg${i + 1}`,
            ),
            ignoreCase: cond.ignoreCase,
            nextPlaceholder: alloc,
            placeholder: alloc,
            placeholders: [],
            quoteIdentifier: (ident: string) => quoteIdent(ident, dialect),
            serializeValue: (v: unknown) => v,
          });
          const rawExpr =
            typeof compiled === "string"
              ? compiled
              : typeof compiled?.sql === "string"
                ? compiled.sql
                : "";
          if (rawExpr) {
            expr =
              allocatedCount === 0 && dialect === "postgres" && rawExpr.includes("?")
                ? rawExpr.replace(/\?/g, () => nextPlaceholder())
                : rawExpr;
          } else {
            const ps = Array.from({ length: spec.paramCount }, () =>
              nextPlaceholder(),
            );
            expr = `${col} /* ${cond.operator} */ ${ps.join(", ")}`.trim();
          }
        } catch {
          const ps = Array.from({ length: spec.paramCount }, () =>
            nextPlaceholder(),
          );
          expr = `${col} /* ${cond.operator} */ ${ps.join(", ")}`.trim();
        }
      } else if (spec) {
        const p1 = spec.paramCount >= 1 ? nextPlaceholder() : "";
        const p2 = spec.paramCount >= 2 ? nextPlaceholder() : "";
        expr = spec.sqlOp(col, p1, p2, cond.ignoreCase);
      } else {
        const p1 = nextPlaceholder();
        expr = cond.ignoreCase
          ? `LOWER(${col}) = LOWER(${p1})`
          : `${col} = ${p1}`;
      }
      if (cond.combinator) {
        if (cond.combinator === "OR") hasOrCondition = true;
        pieces.push(`${cond.combinator} ${expr}`);
      } else {
        pieces.push(expr);
      }
    }
    condSql = pieces.join(" ");
  }

  const scopePredicates: string[] = [];
  for (const scope of options?.activeScopes ?? []) {
    if (scope.kind === "softDelete") {
      scopePredicates.push(
        `${quoteIdent(scope.column ?? "deleted_at", dialect)} IS NULL`,
      );
    } else if (scope.kind === "tenant") {
      scopePredicates.push(
        `${quoteIdent(scope.column ?? "tenant_id", dialect)} = ${nextPlaceholder()}`,
      );
    }
  }

  let whereSql = "";
  if (condSql && scopePredicates.length > 0) {
    const wrappedCond = hasOrCondition ? `(${condSql})` : condSql;
    whereSql = ` WHERE ${wrappedCond} AND ${scopePredicates.join(" AND ")}`;
  } else if (condSql) {
    whereSql = ` WHERE ${condSql}`;
  } else if (scopePredicates.length > 0) {
    whereSql = ` WHERE ${scopePredicates.join(" AND ")}`;
  }

  let orderSql = "";
  if (orderBy.length > 0) {
    orderSql = ` ORDER BY ${orderBy
      .map(
        (o) =>
          `${quoteIdent(o.columnName ?? camelToSnake(o.rawPropertySegment), dialect)} ${o.direction}`,
      )
      .join(", ")}`;
  }

  const selectCols =
    options?.projectedColumns && options.projectedColumns.length > 0
      ? options.projectedColumns.map((c) => quoteIdent(c, dialect)).join(", ")
      : "*";

  const effectiveLimit =
    limit ?? (kind === "findOne" || kind === "exists" ? 1 : undefined);
  const limitSql =
    effectiveLimit !== undefined &&
    kind !== "count" &&
    kind !== "delete" &&
    kind !== "findPage" &&
    kind !== "findCursor"
      ? ` LIMIT ${effectiveLimit}`
      : "";

  switch (kind) {
    case "findAll":
    case "findOne":
      return `SELECT ${selectCols} FROM ${qTable}${whereSql}${orderSql}${limitSql}`;
    case "findPage":
      return `SELECT ${selectCols} FROM ${qTable}${whereSql}${orderSql} LIMIT ${nextPlaceholder()} OFFSET ${nextPlaceholder()}`;
    case "findCursor": {
      const cursorOrder =
        orderSql ||
        ` ORDER BY ${quoteIdent(options?.idColumn ?? "id", dialect)} ASC`;
      return `SELECT ${selectCols} FROM ${qTable}${whereSql}${cursorOrder} LIMIT ${nextPlaceholder()}`;
    }
    case "exists":
      return `SELECT 1 AS found FROM ${qTable}${whereSql}${limitSql}`;
    case "count":
      return `SELECT COUNT(*) AS count FROM ${qTable}${whereSql}`;
    case "delete":
      return `DELETE FROM ${qTable}${whereSql}`;
  }
}

export function parseDerivedMethodName(
  methodName: string,
  options: {
    readonly tableName: string;
    readonly entityName?: string;
    readonly entity?: AnalyzedEntity;
    readonly dialect: RepoSqlDialect;
    readonly idColumn?: string;
    readonly customOperators?: readonly CustomQueryOperatorConfigLike[];
    readonly bunestConfig?: BunestConfigLike;
    readonly projectedFields?: readonly string[];
    readonly activeScopes?: readonly RepositoryScopeInfo[];
    readonly trailingPaginationKind?: "page" | "cursor";
  },
): ParsedDerivedQuery | undefined {
  const prefix = matchDerivedPrefix(methodName);
  if (!prefix) return undefined;

  const effectiveKind: DerivedQueryKind =
    options.trailingPaginationKind === "page" &&
    (prefix.kind === "findAll" || prefix.kind === "findOne")
      ? "findPage"
      : options.trailingPaginationKind === "cursor" &&
          (prefix.kind === "findAll" || prefix.kind === "findOne")
        ? "findCursor"
        : prefix.kind;

  const customOps = collectCustomQueryOperators(
    options.bunestConfig,
    options.customOperators,
  );
  const allOperators = buildCombinedOperators(customOps);

  let wherePart = prefix.orderOnly ? "" : prefix.rest;
  let whereOffset = prefix.restOffset;
  let orderPart = prefix.orderOnly ? prefix.rest : "";
  let orderOffset = prefix.restOffset;

  if (!prefix.orderOnly) {
    const orderIdx = prefix.rest.indexOf("OrderBy");
    if (orderIdx !== -1) {
      wherePart = prefix.rest.slice(0, orderIdx);
      orderPart = prefix.rest.slice(orderIdx + "OrderBy".length);
      orderOffset = prefix.restOffset + orderIdx + "OrderBy".length;
    }
  }

  const conditions: DerivedConditionToken[] = [];
  const unknownProperties: Array<{
    readonly raw: string;
    readonly suggestion?: string;
    readonly segmentStart: number;
    readonly segmentEnd: number;
  }> = [];
  const operatorTypeErrors: Array<{
    readonly propertyName: string;
    readonly operator: string;
    readonly fieldCategory: EntityFieldCategory;
    readonly reason: string;
  }> = [];
  const expectedParams: Array<{ readonly name: string; readonly tsType: string }> = [];

  const entityPropNames = options.entity?.fields.map((f) => f.propertyName) ?? [];

  if (wherePart.length > 0) {
    const rawClauses = splitCombinators(wherePart, whereOffset);
    for (const clause of rawClauses) {
      let body = clause.text;
      let ignoreCase = false;
      if (body.endsWith("IgnoreCase") && body.length > "IgnoreCase".length) {
        ignoreCase = true;
        body = body.slice(0, -"IgnoreCase".length);
      }

      let matchedOp: OperatorSpec | undefined;
      let propSegment = body;

      for (const spec of allOperators) {
        if (body.endsWith(spec.suffix) && body.length > spec.suffix.length) {
          // Ensure we didn't split an actual entity property name (e.g. `statusIs` vs `isActive`)
          const candidateProp = body.slice(0, -spec.suffix.length);
          const fullMatchesEntity = resolveEntityField(body, options.entity);
          if (!fullMatchesEntity) {
            matchedOp = spec;
            propSegment = candidateProp;
            break;
          }
        }
      }

      const field = resolveEntityField(propSegment, options.entity);
      const paramCount = matchedOp ? matchedOp.paramCount : 1;
      const baseType = field?.tsType ?? "unknown";
      const cleanBaseType = baseType.replace(/\s*\|\s*undefined/g, "").trim() || "unknown";

      const condParamTypes: string[] = [];
      const baseName = field?.propertyName ?? lowerFirst(propSegment);
      if (paramCount === 1) {
        const pt = matchedOp?.expectsArrayParam
          ? `readonly (${cleanBaseType})[]`
          : matchedOp?.isCustom
            ? "unknown"
            : cleanBaseType;
        condParamTypes.push(pt);
        expectedParams.push({
          name: baseName,
          tsType: pt,
        });
      } else if (paramCount === 2) {
        const pt = matchedOp?.isCustom ? "unknown" : cleanBaseType;
        condParamTypes.push(pt, pt);
        expectedParams.push(
          { name: `${baseName}Start`, tsType: pt },
          { name: `${baseName}End`, tsType: pt },
        );
      } else if (paramCount > 2) {
        for (let idx = 0; idx < paramCount; idx++) {
          condParamTypes.push("unknown");
          expectedParams.push({
            name: `${baseName}${idx + 1}`,
            tsType: "unknown",
          });
        }
      }

      if (options.entity && !field && entityPropNames.length > 0) {
        const suggestion = findClosestMatch(
          lowerFirst(propSegment),
          entityPropNames,
        );
        unknownProperties.push({
          raw: propSegment,
          suggestion: suggestion ? capitalize(suggestion) : undefined,
          segmentStart: clause.startOffset,
          segmentEnd: clause.startOffset + propSegment.length,
        });
      }

      if (field) {
        if (ignoreCase && field.category !== "string" && field.category !== "other") {
          operatorTypeErrors.push({
            propertyName: field.propertyName,
            operator: "IgnoreCase",
            fieldCategory: field.category,
            reason: `IgnoreCase is only valid on string fields, but "${field.propertyName}" is ${field.tsType}.`,
          });
        }
        if (
          matchedOp?.allowedCategories &&
          field.category !== "other" &&
          !matchedOp.allowedCategories.includes(field.category)
        ) {
          operatorTypeErrors.push({
            propertyName: field.propertyName,
            operator: matchedOp.suffix,
            fieldCategory: field.category,
            reason: `Operator "${matchedOp.suffix}" is not compatible with ${field.category} field "${field.propertyName}" (${field.tsType}).`,
          });
        }
      }

      conditions.push({
        rawPropertySegment: propSegment,
        propertyName: field?.propertyName ?? lowerFirst(propSegment),
        columnName: field?.columnName ?? camelToSnake(propSegment),
        field,
        operator: matchedOp?.suffix ?? "Equals",
        ignoreCase,
        combinator: clause.combinator,
        segmentStart: clause.startOffset,
        segmentEnd: clause.startOffset + propSegment.length,
        expectedParamCount: paramCount,
        expectedParamTypes: condParamTypes,
      });
    }
  }

  const orderBy = orderPart
    ? parseOrderByClause(orderPart, orderOffset, options.entity)
    : [];

  if (options.entity && entityPropNames.length > 0) {
    for (const o of orderBy) {
      if (!o.field) {
        const suggestion = findClosestMatch(
          lowerFirst(o.rawPropertySegment),
          entityPropNames,
        );
        unknownProperties.push({
          raw: o.rawPropertySegment,
          suggestion: suggestion ? capitalize(suggestion) : undefined,
          segmentStart: o.segmentStart,
          segmentEnd: o.segmentEnd,
        });
      }
    }
  }

  const entityType = options.entityName ?? options.entity?.className ?? "unknown";
  const projectedFields = options.projectedFields;
  const projectedColumns =
    projectedFields && projectedFields.length > 0
      ? projectedFields.map((propName) => {
          const found = options.entity?.fields.find(
            (f) => f.propertyName === propName,
          );
          return found?.columnName ?? camelToSnake(propName);
        })
      : undefined;

  const itemType =
    projectedFields && projectedFields.length > 0 && entityType !== "unknown"
      ? `Pick<${entityType}, ${projectedFields.map((f) => JSON.stringify(f)).join(" | ")}>`
      : entityType;

  if (effectiveKind === "findPage") {
    expectedParams.push({ name: "pageable", tsType: "Pageable" });
  } else if (effectiveKind === "findCursor") {
    expectedParams.push({ name: "cursor", tsType: "CursorPageable" });
  }

  let expectedReturnType: string;
  switch (effectiveKind) {
    case "findAll":
      expectedReturnType = `Promise<${itemType}[]>`;
      break;
    case "findOne":
      expectedReturnType = `Promise<${itemType} | null>`;
      break;
    case "findPage":
      expectedReturnType = `Promise<Page<${itemType}>>`;
      break;
    case "findCursor":
      expectedReturnType = `Promise<CursorPage<${itemType}>>`;
      break;
    case "exists":
      expectedReturnType = "Promise<boolean>";
      break;
    case "count":
    case "delete":
      expectedReturnType = "Promise<number>";
      break;
  }

  const renderOpts = {
    operators: allOperators,
    projectedColumns,
    activeScopes: options.activeScopes,
    idColumn: options.idColumn ?? options.entity?.idColumn ?? "id",
  };

  const sqlByDialect: Record<RepoSqlDialect, string> = {
    sqlite: renderSqlForDialect(
      effectiveKind,
      options.tableName,
      conditions,
      orderBy,
      prefix.limit,
      "sqlite",
      renderOpts,
    ),
    postgres: renderSqlForDialect(
      effectiveKind,
      options.tableName,
      conditions,
      orderBy,
      prefix.limit,
      "postgres",
      renderOpts,
    ),
    mysql: renderSqlForDialect(
      effectiveKind,
      options.tableName,
      conditions,
      orderBy,
      prefix.limit,
      "mysql",
      renderOpts,
    ),
  };

  const activeScopeNames = options.activeScopes?.map((s) => s.name);

  return {
    methodName,
    kind: effectiveKind,
    limit: prefix.limit,
    conditions,
    orderBy,
    ...(projectedFields && projectedFields.length > 0 ? { projectedFields } : {}),
    ...(activeScopeNames && activeScopeNames.length > 0
      ? { activeScopes: activeScopeNames }
      : {}),
    expectedParamCount: expectedParams.length,
    expectedParams,
    expectedReturnType,
    sqlPreview: sqlByDialect[options.dialect],
    sqlByDialect,
    unknownProperties,
    operatorTypeErrors,
  };
}

// ============================================================================
// Chained Derived Query Autocomplete Engine (Spring Data-style DX in VS Code)
// ============================================================================

export function getRepositoryDerivedCompletions(
  repo: AnalyzedRepository,
  currentPrefix: string,
  options?: {
    readonly bunestConfig?: BunestConfigLike;
    readonly customOperators?: readonly CustomQueryOperatorConfigLike[];
  },
): RepositoryCompletionItem[] {
  const entity = repo.entity;
  if (!entity || entity.fields.length === 0) return [];

  const customOps = collectCustomQueryOperators(
    options?.bunestConfig,
    options?.customOperators,
  );
  const allOperators = buildCombinedOperators(customOps);

  const items: RepositoryCompletionItem[] = [];
  const entityType = repo.entityName ?? entity.className;

  // Stage 0: Suggest top-level derived method prefixes
  const starterPrefixes: Array<{ prefix: string; detail: string }> = [
    { prefix: "findBy", detail: `Find single ${entityType} | null` },
    { prefix: "findAllBy", detail: `Find all matching ${entityType}[]` },
    { prefix: "findOneBy", detail: `Find one ${entityType} | null` },
    { prefix: "findFirstBy", detail: `Find first ${entityType} | null` },
    { prefix: "findTop10By", detail: `Find top 10 ${entityType}[]` },
    { prefix: "findPageBy", detail: `Find paginated Page<${entityType}>` },
    { prefix: "findCursorBy", detail: `Find keyset CursorPage<${entityType}>` },
    { prefix: "findAllOrderBy", detail: `Find all ordered ${entityType}[]` },
    { prefix: "existsBy", detail: "Check existence -> Promise<boolean>" },
    { prefix: "countBy", detail: "Count matching rows -> Promise<number>" },
    { prefix: "deleteBy", detail: "Delete matching rows -> Promise<number>" },
  ];

  const matched = matchDerivedPrefix(
    currentPrefix.length > 0 && /[A-Z]$/.test(currentPrefix)
      ? currentPrefix
      : `${currentPrefix}A`,
  );

  // If user is still typing the prefix itself (e.g. "find", "exi", "cou", "del")
  const exactPrefixOnly = starterPrefixes.find((s) => s.prefix === currentPrefix);
  if (!matched && !exactPrefixOnly) {
    for (const s of starterPrefixes) {
      if (
        currentPrefix.length === 0 ||
        s.prefix.toLowerCase().startsWith(currentPrefix.toLowerCase())
      ) {
        items.push({
          label: s.prefix,
          insertText: s.prefix,
          detail: s.detail,
          kind: "prefix",
          sortText: `0_${s.prefix}`,
        });
      }
    }
    return items;
  }

  // Determine exact parsing context after the prefix
  const prefixMatch =
    starterPrefixes.find((s) => currentPrefix.startsWith(s.prefix)) ??
    (() => {
      const m = /^(findTop\d+By|findFirst\d*By|findPageOrderBy|findCursorOrderBy|removeBy)/.exec(currentPrefix);
      return m ? { prefix: m[1]!, detail: "" } : undefined;
    })();
  if (!prefixMatch) return items;

  const rest = currentPrefix.slice(prefixMatch.prefix.length);
  const inOrderBy =
    prefixMatch.prefix === "findAllOrderBy" ||
    prefixMatch.prefix === "findPageOrderBy" ||
    prefixMatch.prefix === "findCursorOrderBy" ||
    rest.includes("OrderBy");

  const makeFullSignature = (fullMethodName: string): string => {
    const parsed = parseDerivedMethodName(fullMethodName, {
      tableName: repo.tableName,
      entityName: entityType,
      entity,
      dialect: repo.dialect,
      idColumn: repo.idColumn,
      bunestConfig: options?.bunestConfig,
      customOperators: options?.customOperators,
      activeScopes: repo.scopes,
    });
    if (!parsed) return `${fullMethodName}(): Promise<unknown>;`;
    const paramList = parsed.expectedParams
      .map((p) => `${p.name}: ${p.tsType}`)
      .join(", ");
    return `${fullMethodName}(${paramList}): ${parsed.expectedReturnType};`;
  };

  // Stage A: Inside OrderBy clause
  if (inOrderBy) {
    const orderRest =
      prefixMatch.prefix === "findAllOrderBy" ||
      prefixMatch.prefix === "findPageOrderBy" ||
      prefixMatch.prefix === "findCursorOrderBy"
        ? rest
        : rest.slice(rest.indexOf("OrderBy") + "OrderBy".length);

    // Strip completed `FieldAsc`/`FieldDesc` segments
    const trailing = orderRest.replace(/([A-Z][a-zA-Z0-9]*?(?:Asc|Desc))+/g, "");
    const matchedField = entity.fields.find(
      (f) => capitalize(f.propertyName) === trailing,
    );

    if (matchedField) {
      for (const dir of ["Asc", "Desc"] as const) {
        const full = `${currentPrefix}${dir}`;
        items.push({
          label: full,
          insertText: makeFullSignature(full),
          detail: `ORDER BY ${matchedField.columnName} ${dir.toUpperCase()}`,
          kind: "order",
          sortText: `1_${dir}`,
        });
      }
      return items;
    }

    for (const f of entity.fields) {
      const cap = capitalize(f.propertyName);
      if (trailing.length === 0 || cap.toLowerCase().startsWith(trailing.toLowerCase())) {
        const base = `${currentPrefix.slice(0, currentPrefix.length - trailing.length)}${cap}`;
        for (const dir of ["Asc", "Desc"] as const) {
          const full = `${base}${dir}`;
          items.push({
            label: `${cap}${dir}`,
            insertText: makeFullSignature(full),
            detail: `Order by ${f.propertyName} (${f.columnName}) ${dir.toUpperCase()}`,
            kind: "order",
            sortText: `1_${cap}_${dir}`,
          });
        }
      }
    }
    return items;
  }

  // Stage B: Inside WHERE clause — inspect trailing token after last And/Or
  const lastCombMatch = /(?:And|Or)(?=[A-Z]?$|[A-Z][a-zA-Z0-9]*$)/.exec(rest);
  const trailingClause = lastCombMatch
    ? rest.slice(lastCombMatch.index + lastCombMatch[0].length)
    : rest;
  const baseBeforeTrailing = currentPrefix.slice(
    0,
    currentPrefix.length - trailingClause.length,
  );

  // Check if trailingClause ALREADY matches a complete Entity property (+ optional operator)
  const exactField = entity.fields.find(
    (f) => capitalize(f.propertyName) === trailingClause,
  );

  if (exactField) {
    // 1. Complete method directly with `= ?`
    const parsedDirect = parseDerivedMethodName(currentPrefix, {
      tableName: repo.tableName,
      entityName: entityType,
      entity,
      dialect: repo.dialect,
      idColumn: repo.idColumn,
      bunestConfig: options?.bunestConfig,
      customOperators: options?.customOperators,
      activeScopes: repo.scopes,
    });
    items.push({
      label: `${currentPrefix}(...)`,
      insertText: makeFullSignature(currentPrefix),
      detail: `Complete method (${parsedDirect?.expectedReturnType ?? ""})`,
      documentation: parsedDirect ? `\`\`\`sql\n${parsedDirect.sqlPreview}\n\`\`\`` : undefined,
      kind: "fullMethod",
      sortText: "0_complete",
    });

    // 2. Suggest type-compatible operators (built-in + registered custom ORM operators!)
    for (const op of allOperators) {
      if (
        op.allowedCategories &&
        exactField.category !== "other" &&
        !op.allowedCategories.includes(exactField.category)
      ) {
        continue;
      }
      const nextName = `${currentPrefix}${op.suffix}`;
      const parsedOp = parseDerivedMethodName(nextName, {
        tableName: repo.tableName,
        entityName: entityType,
        entity,
        dialect: repo.dialect,
        idColumn: repo.idColumn,
        bunestConfig: options?.bunestConfig,
        customOperators: options?.customOperators,
        activeScopes: repo.scopes,
      });
      const detailText = op.description
        ? `${op.description} (${exactField.propertyName} ${op.suffix})`
        : `${exactField.propertyName} ${op.suffix} -> ${parsedOp?.expectedReturnType ?? ""}`;
      items.push({
        label: op.suffix,
        insertText: makeFullSignature(nextName),
        detail: detailText,
        documentation: parsedOp ? `\`\`\`sql\n${parsedOp.sqlPreview}\n\`\`\`` : undefined,
        kind: "operator",
        sortText: op.isCustom ? `0_custom_${op.suffix}` : `1_${op.suffix}`,
      });
    }

    if (exactField.category === "string") {
      const icName = `${currentPrefix}IgnoreCase`;
      items.push({
        label: "IgnoreCase",
        insertText: makeFullSignature(icName),
        detail: `Case-insensitive comparison on ${exactField.propertyName}`,
        kind: "operator",
        sortText: "1_IgnoreCase",
      });
    }

    // 3. Combinators (`And`, `Or`, `OrderBy`)
    for (const comb of ["And", "Or", "OrderBy"] as const) {
      items.push({
        label: comb,
        insertText: `${currentPrefix}${comb}`,
        detail: comb === "OrderBy" ? "Append ORDER BY clause" : `Combine with ${comb.toUpperCase()}`,
        kind: "combinator",
        sortText: `2_${comb}`,
      });
    }
    return items;
  }

  // Check if trailingClause is `<Property><Operator>` -> offer complete method + And/Or/OrderBy
  const parsedCurrent = parseDerivedMethodName(currentPrefix, {
    tableName: repo.tableName,
    entityName: entityType,
    entity,
    dialect: repo.dialect,
    idColumn: repo.idColumn,
    bunestConfig: options?.bunestConfig,
    customOperators: options?.customOperators,
    activeScopes: repo.scopes,
  });
  if (
    parsedCurrent &&
    parsedCurrent.conditions.length > 0 &&
    parsedCurrent.unknownProperties.length === 0
  ) {
    items.push({
      label: `${currentPrefix}(...)`,
      insertText: makeFullSignature(currentPrefix),
      detail: `Complete method -> ${parsedCurrent.expectedReturnType}`,
      documentation: `\`\`\`sql\n${parsedCurrent.sqlPreview}\n\`\`\``,
      kind: "fullMethod",
      sortText: "0_complete",
    });
    for (const comb of ["And", "Or", "OrderBy"] as const) {
      items.push({
        label: comb,
        insertText: `${currentPrefix}${comb}`,
        detail: comb === "OrderBy" ? "Append ORDER BY clause" : `Chain ${comb.toUpperCase()} condition`,
        kind: "combinator",
        sortText: `1_${comb}`,
      });
    }
  }

  // Suggest matching Entity properties for `trailingClause`
  for (const field of entity.fields) {
    const cap = capitalize(field.propertyName);
    if (
      trailingClause.length === 0 ||
      cap.toLowerCase().startsWith(trailingClause.toLowerCase())
    ) {
      const fullName = `${baseBeforeTrailing}${cap}`;
      const parsed = parseDerivedMethodName(fullName, {
        tableName: repo.tableName,
        entityName: entityType,
        entity,
        dialect: repo.dialect,
      });
      items.push({
        label: cap,
        insertText: makeFullSignature(fullName),
        detail: `${field.propertyName}: ${field.tsType} (col: ${field.columnName})`,
        documentation: parsed ? `\`\`\`sql\n${parsed.sqlPreview}\n\`\`\`` : undefined,
        kind: "property",
        sortText: `0_${cap}`,
      });
    }
  }

  return items;
}

// ============================================================================
// @Query SQL Placeholder Scanner
// ============================================================================

export function scanSqlPlaceholders(rawSql: string): {
  readonly namedPlaceholders: readonly string[];
  readonly positionalCount: number;
  readonly isWriteSql: boolean;
} {
  const named: string[] = [];
  const namedSet = new Set<string>();
  let positionalCount = 0;
  let stripped = "";

  let i = 0;
  const len = rawSql.length;
  while (i < len) {
    const ch = rawSql[i]!;
    const next = rawSql[i + 1];

    // Single-quoted string literal
    if (ch === "'") {
      i++;
      while (i < len) {
        if (rawSql[i] === "'" && rawSql[i + 1] === "'") {
          i += 2;
        } else if (rawSql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      stripped += " ";
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      i++;
      while (i < len) {
        if (rawSql[i] === '"' && rawSql[i + 1] === '"') {
          i += 2;
        } else if (rawSql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      stripped += " ";
      continue;
    }

    // Line comment --
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < len && rawSql[i] !== "\n") i++;
      stripped += " ";
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(rawSql[i] === "*" && rawSql[i + 1] === "/")) i++;
      i += 2;
      stripped += " ";
      continue;
    }

    // Postgres cast `::type` — skip!
    if (ch === ":" && next === ":") {
      stripped += "::";
      i += 2;
      continue;
    }

    // Named parameter `:paramName`
    if (ch === ":" && next && /[A-Za-z_]/.test(next)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_]/.test(rawSql[j]!)) j++;
      const name = rawSql.slice(i + 1, j);
      if (!namedSet.has(name)) {
        namedSet.add(name);
        named.push(name);
      }
      stripped += " ";
      i = j;
      continue;
    }

    // Positional `?` or `$1`
    if (ch === "?") {
      positionalCount++;
      stripped += "?";
      i++;
      continue;
    }
    if (ch === "$" && next && /[0-9]/.test(next)) {
      let j = i + 1;
      while (j < len && /[0-9]/.test(rawSql[j]!)) j++;
      const idx = Number(rawSql.slice(i + 1, j));
      if (idx > positionalCount) positionalCount = idx;
      stripped += "$";
      i = j;
      continue;
    }

    stripped += ch;
    i++;
  }

  const leadingKeyword = stripped.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  const isWriteSql =
    leadingKeyword === "INSERT" ||
    leadingKeyword === "UPDATE" ||
    leadingKeyword === "DELETE" ||
    leadingKeyword === "REPLACE";

  return {
    namedPlaceholders: named,
    positionalCount,
    isWriteSql,
  };
}

// ============================================================================
// Workspace Repository & Entity Scanner + 7 Repository Diagnostics
// ============================================================================

function resolveEntityClassFromExpr(
  expr: Expression | undefined,
): ClassDeclaration | undefined {
  if (!expr || !Node.isIdentifier(expr)) return undefined;
  const sym = expr.getSymbol();
  const decl =
    sym?.getAliasedSymbol()?.getDeclarations()[0] ?? sym?.getDeclarations()[0];
  return decl && Node.isClassDeclaration(decl) ? decl : undefined;
}

function resolveEntityFromExtendsTypeArg(
  cls: ClassDeclaration,
): { entityClass?: ClassDeclaration; entityName?: string; idTsType?: string } {
  const ext = cls.getExtends();
  if (!ext) return {};
  const typeArgs = ext.getTypeArguments();
  const first = typeArgs[0];
  const second = typeArgs[1];
  let entityClass: ClassDeclaration | undefined;
  let entityName: string | undefined;

  if (first) {
    entityName = first.getText().trim();
    const sym = first.getType().getSymbol();
    const decl = sym?.getDeclarations()[0];
    if (decl && Node.isClassDeclaration(decl)) {
      entityClass = decl;
    }
  }
  return {
    entityClass,
    entityName,
    idTsType: second?.getText().trim(),
  };
}

function extractStringArgsList(dec: Decorator): string[] {
  const out: string[] = [];
  for (const arg of dec.getArguments()) {
    const expr = arg as Expression | undefined;
    const single = extractStringLiteral(expr);
    if (single !== undefined) {
      out.push(single);
      continue;
    }
    if (expr && Node.isArrayLiteralExpression(expr)) {
      for (const el of expr.getElements()) {
        const s = extractStringLiteral(el as Expression | undefined);
        if (s !== undefined) out.push(s);
      }
    }
  }
  return out;
}

function extractClassScopes(cls: ClassDeclaration | undefined): RepositoryScopeInfo[] {
  if (!cls) return [];
  const scopes: RepositoryScopeInfo[] = [];
  for (const entry of resolveComposedDecorators(cls)) {
    const short = entry.name;
    const arg0 = entry.resolvedArgs[0];
    if (short === "SoftDelete") {
      scopes.push({
        name: extractStringLiteral(getObjectProp(arg0, "name")) ?? "softDelete",
        kind: "softDelete",
        column:
          extractStringLiteral(getObjectProp(arg0, "column")) ?? "deleted_at",
        property:
          extractStringLiteral(getObjectProp(arg0, "property")) ?? "deletedAt",
      });
    } else if (short === "TenantScoped") {
      scopes.push({
        name: extractStringLiteral(getObjectProp(arg0, "name")) ?? "tenant",
        kind: "tenant",
        column:
          extractStringLiteral(getObjectProp(arg0, "column")) ?? "tenant_id",
        property:
          extractStringLiteral(getObjectProp(arg0, "property")) ?? "tenantId",
      });
    } else if (short === "RepositoryScope") {
      const name =
        extractStringLiteral(getObjectProp(arg0, "name")) ??
        extractStringLiteral(arg0) ??
        "custom";
      scopes.push({ name, kind: "custom" });
    }
  }
  return scopes;
}

function detectTrailingPaginationKind(
  params: readonly { readonly tsType: string }[],
): "page" | "cursor" | undefined {
  const last = params[params.length - 1];
  if (!last) return undefined;
  const compact = last.tsType.replace(/\s+/g, "");
  if (/\bCursorPageable\b/.test(compact)) return "cursor";
  if (/\bPageable\b/.test(compact)) return "page";
  return undefined;
}

export interface ScanEntitiesAndRepositoriesOptions {
  readonly bunestConfig?: BunestConfigLike;
  readonly customOperators?: readonly CustomQueryOperatorConfigLike[];
}

export function scanEntitiesAndRepositories(
  sourceFiles: readonly SourceFile[],
  _project: Project,
  options?: ScanEntitiesAndRepositoriesOptions,
): {
  readonly entities: readonly AnalyzedEntity[];
  readonly repositories: readonly AnalyzedRepository[];
  readonly diagnostics: readonly RepositoryDiagnostic[];
} {
  const entitiesByClass = new Map<ClassDeclaration, AnalyzedEntity>();
  const entitiesByName = new Map<string, AnalyzedEntity>();
  const repositories: AnalyzedRepository[] = [];
  const diagnostics: RepositoryDiagnostic[] = [];

  // Pass 1: Scan all decorated @Entity / @BaseEntity classes (including applyDecorators wrappers)
  for (const sf of sourceFiles) {
    for (const cls of sf.getClasses()) {
      const hasEntityDec = resolveComposedDecorators(cls).some((d) =>
        ENTITY_DECORATORS.has(d.name),
      );
      if (hasEntityDec) {
        const analyzed = analyzeEntityClass(cls);
        entitiesByClass.set(cls, analyzed);
        entitiesByName.set(analyzed.className, analyzed);
      }
    }
  }

  // Pass 2: Scan all declarative repositories
  for (const sf of sourceFiles) {
    for (const cls of sf.getClasses()) {
      const className = cls.getName();
      if (!className) continue;

      const ext = cls.getExtends();
      const baseClassName = ext?.getExpression().getText() ?? "";
      const extendsCrudRepo = CRUD_REPO_BASE_CLASSES.has(baseClassName);

      const repoDecEntry = resolveComposedDecorators(cls).find((d) =>
        REPOSITORY_DECORATORS.has(d.name),
      );
      const repoDec = repoDecEntry?.sourceDecorator;

      if (!extendsCrudRepo && !repoDecEntry) continue;

      const driver = "orm" as const;
      let dialect: RepoSqlDialect = "sqlite";
      let entityClass: ClassDeclaration | undefined;
      let explicitTable: string | undefined;
      let explicitIdColumn: string | undefined;
      let camelCaseMapping = true;

      if (repoDecEntry) {
        const arg0 = repoDecEntry.resolvedArgs[0];
        const arg1 = repoDecEntry.resolvedArgs[1];

        const directEntity = resolveEntityClassFromExpr(arg0);
        if (directEntity) {
          entityClass = directEntity;
        }
        const optsExpr = directEntity ? arg1 : arg0;
        if (optsExpr && Node.isObjectLiteralExpression(optsExpr)) {
          const entProp = getObjectProp(optsExpr, "entity");
          if (entProp) {
            entityClass = resolveEntityClassFromExpr(entProp) ?? entityClass;
          }
          explicitTable =
            extractStringLiteral(getObjectProp(optsExpr, "tableName")) ??
            extractStringLiteral(getObjectProp(optsExpr, "table"));
          explicitIdColumn = extractStringLiteral(
            getObjectProp(optsExpr, "idColumn"),
          );
          const dStr = extractStringLiteral(getObjectProp(optsExpr, "dialect"));
          if (dStr === "sqlite" || dStr === "postgres" || dStr === "mysql") {
            dialect = dStr;
          }
          if (
            getObjectProp(optsExpr, "camelCaseMapping")?.getKind() ===
            SyntaxKind.FalseKeyword
          ) {
            camelCaseMapping = false;
          }
        } else if (!directEntity) {
          const tableStr = extractStringLiteral(arg0);
          if (tableStr) explicitTable = tableStr;
        }
      }

      const extInfo = resolveEntityFromExtendsTypeArg(cls);
      entityClass = entityClass ?? extInfo.entityClass;

      let entity: AnalyzedEntity | undefined;
      if (entityClass) {
        entity = entitiesByClass.get(entityClass);
        if (!entity) {
          entity = analyzeEntityClass(entityClass);
          entitiesByClass.set(entityClass, entity);
          entitiesByName.set(entity.className, entity);
        }
      } else if (extInfo.entityName) {
        entity = entitiesByName.get(extInfo.entityName);
      }

      const entityName = entity?.className ?? extInfo.entityName;
      const tableName =
        explicitTable ??
        entity?.tableName ??
        pluralizeTable(className.replace(/Repository$/i, "") || className);
      const idColumn = explicitIdColumn ?? entity?.idColumn ?? "id";
      const idTsType = extInfo.idTsType ?? entity?.idTsType ?? "number";

      // BUNEST_REPO007: extends CrudRepository without @OrmRepository decorator
      if (extendsCrudRepo && !repoDec) {
        diagnostics.push({
          code: "BUNEST_REPO007",
          severity: "error",
          message: `Repository "${className}" extends ${baseClassName} but is missing @OrmRepository(${entityName ?? "Entity"}) or @Repository(...) decorator.`,
          location: nodeToLocation(cls.getNameNode() ?? cls),
          fixData: {
            kind: "addRepositoryDecorator",
            entityName: entityName ?? "Entity",
            driver,
          },
        });
      }

      // Collect repository & entity scopes (`@SoftDelete`, `@TenantScoped`, `@RepositoryScope`)
      const scopeByName = new Map<string, RepositoryScopeInfo>();
      for (const s of extractClassScopes(entityClass)) {
        scopeByName.set(s.name, s);
      }
      for (const s of extractClassScopes(cls)) {
        scopeByName.set(s.name, s);
      }
      const repoScopes = [...scopeByName.values()];

      const methods: AnalyzedQueryMethod[] = [];

      for (const method of cls.getMethods()) {
        if (method.isStatic()) continue;
        const mName = method.getName();
        const isAbstract = method.isAbstract();
        const mLoc = nodeToLocation(method.getNameNode());
        const retTypeNodeText =
          method.getReturnTypeNode()?.getText().trim() ??
          method.getReturnType().getText(method);

        const methodDecs = method.getDecorators();
        const projectionDec = methodDecs.find(
          (d) => getDecoratorShortName(d) === "Projection",
        );
        const projectedFields = projectionDec
          ? extractStringArgsList(projectionDec)
          : undefined;

        const ignoreScopeDecs = methodDecs.filter(
          (d) => getDecoratorShortName(d) === "IgnoreScope",
        );
        let ignoreAllScopes = false;
        const ignoredScopeSet = new Set<string>();
        for (const igDec of ignoreScopeDecs) {
          const names = extractStringArgsList(igDec);
          if (names.length === 0) {
            ignoreAllScopes = true;
          } else {
            for (const n of names) ignoredScopeSet.add(n);
          }
        }
        const activeScopes = ignoreAllScopes
          ? []
          : repoScopes.filter((s) => !ignoredScopeSet.has(s.name));

        // Validate @Projection(...) field names against entity properties
        if (projectedFields && projectedFields.length > 0 && entity && projectionDec) {
          const entityPropNames = entity.fields.map((f) => f.propertyName);
          const propSet = new Set(entityPropNames);
          for (const pf of projectedFields) {
            if (!propSet.has(pf)) {
              const suggestion = findClosestMatch(pf, entityPropNames);
              const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
              diagnostics.push({
                code: "BUNEST_REPO001",
                severity: "error",
                message: `@Projection() on "${className}.${mName}" references unknown property "${pf}" on entity "${entityName ?? tableName}".${hint}`,
                location: nodeToLocation(projectionDec),
              });
            }
          }
        }

        const params = method.getParameters().map((p) => {
          const sqlParamDec = p.getDecorators().find((d) => {
            const s = getDecoratorShortName(d);
            return s === "SqlParam" || s === "Param";
          });
          const sqlParamName = sqlParamDec
            ? extractStringLiteral(
                sqlParamDec.getArguments()[0] as Expression | undefined,
              )
            : undefined;
          return {
            name: p.getName(),
            tsType:
              p.getTypeNode()?.getText().trim() ?? p.getType().getText(p),
            sqlParamName,
            location: nodeToLocation(p.getNameNode()),
          };
        });

        const queryDec = method.getDecorators().find((d) => {
          const s = getDecoratorShortName(d);
          return s === "Query" || s === "OrmQuery";
        });

        if (queryDec) {
          const sql =
            extractStringLiteral(
              queryDec.getArguments()[0] as Expression | undefined,
            ) ?? "";
          const isModifying = method
            .getDecorators()
            .some((d) => getDecoratorShortName(d) === "Modifying");
          const scanned = scanSqlPlaceholders(sql);

          // BUNEST_REPO006: Validate @Query placeholders & @Modifying
          if (scanned.isWriteSql && !isModifying) {
            diagnostics.push({
              code: "BUNEST_REPO006",
              severity: "error",
              message: `@Query() method "${className}.${mName}" executes a write SQL statement (INSERT/UPDATE/DELETE) without @Modifying().`,
              location: nodeToLocation(queryDec),
              fixData: { kind: "addModifyingDecorator" },
            });
          }

          if (scanned.namedPlaceholders.length > 0) {
            const declaredNames = new Set(
              params
                .map((p) => p.sqlParamName)
                .filter((n): n is string => Boolean(n)),
            );
            for (const ph of scanned.namedPlaceholders) {
              if (!declaredNames.has(ph)) {
                diagnostics.push({
                  code: "BUNEST_REPO006",
                  severity: "error",
                  message: `@Query() placeholder ":${ph}" in "${className}.${mName}" has no matching @SqlParam("${ph}") / @Param("${ph}") parameter.`,
                  location: nodeToLocation(queryDec),
                });
              }
            }
            for (const p of params) {
              if (
                p.sqlParamName &&
                !scanned.namedPlaceholders.includes(p.sqlParamName)
              ) {
                diagnostics.push({
                  code: "BUNEST_REPO006",
                  severity: "warning",
                  message: `@SqlParam("${p.sqlParamName}") on "${className}.${mName}" is never referenced in the SQL query.`,
                  location: p.location,
                });
              }
            }
          } else if (
            scanned.positionalCount > 0 &&
            params.length !== scanned.positionalCount
          ) {
            diagnostics.push({
              code: "BUNEST_REPO006",
              severity: "error",
              message: `@Query() in "${className}.${mName}" has ${scanned.positionalCount} positional placeholder(s), but method declares ${params.length} parameter(s).`,
              location: mLoc,
            });
          }

          methods.push({
            name: mName,
            kind: "customQuery",
            isAbstract,
            location: mLoc,
            methodStart: method.getStart(),
            methodEnd: method.getEnd(),
            params,
            returnTypeText: retTypeNodeText,
            customQuery: {
              sql,
              isModifying,
              namedPlaceholders: scanned.namedPlaceholders,
              positionalCount: scanned.positionalCount,
              isWriteSql: scanned.isWriteSql,
              decoratorLocation: nodeToLocation(queryDec),
            },
          });
          continue;
        }

        if (CRUD_BASE_METHOD_NAMES.has(mName)) {
          methods.push({
            name: mName,
            kind: "crud",
            isAbstract,
            location: mLoc,
            methodStart: method.getStart(),
            methodEnd: method.getEnd(),
            params,
            returnTypeText: retTypeNodeText,
          });
          continue;
        }

        const trailingPaginationKind = detectTrailingPaginationKind(params);
        const parsedDerived = isAbstract
          ? parseDerivedMethodName(mName, {
              tableName,
              entityName,
              entity,
              dialect,
              idColumn,
              bunestConfig: options?.bunestConfig,
              customOperators: options?.customOperators,
              projectedFields,
              activeScopes,
              trailingPaginationKind,
            })
          : undefined;

        if (parsedDerived) {
          // BUNEST_REPO001: Unknown entity property in derived name
          for (const unk of parsedDerived.unknownProperties) {
            const hint = unk.suggestion
              ? ` Did you mean "${unk.suggestion}"?`
              : "";
            diagnostics.push({
              code: "BUNEST_REPO001",
              severity: "error",
              message: `Derived query "${mName}" references unknown property "${unk.raw}" on entity "${entityName ?? tableName}".${hint}`,
              location: {
                ...mLoc,
                start: mLoc.start + unk.segmentStart,
                end: mLoc.start + unk.segmentEnd,
                column: mLoc.column + unk.segmentStart,
                endColumn: mLoc.column + unk.segmentEnd,
              },
              ...(unk.suggestion
                ? {
                    fixData: {
                      kind: "renameDerivedProperty" as const,
                      replacement: unk.suggestion,
                    },
                  }
                : {}),
            });
          }

          // BUNEST_REPO002: Parameter count mismatch
          if (params.length !== parsedDerived.expectedParamCount) {
            diagnostics.push({
              code: "BUNEST_REPO002",
              severity: "error",
              message: `Derived query "${mName}" expects ${parsedDerived.expectedParamCount} parameter(s) (${parsedDerived.expectedParams.map((p) => `${p.name}: ${p.tsType}`).join(", ") || "none"}), but declares ${params.length}.`,
              location: mLoc,
            });
          } else {
            // BUNEST_REPO003: Parameter type mismatch against entity field
            for (let idx = 0; idx < params.length; idx++) {
              const actual = params[idx]!;
              const expected = parsedDerived.expectedParams[idx]!;
              if (
                expected.tsType !== "unknown" &&
                !isParamTypeCompatible(actual.tsType, expected.tsType)
              ) {
                diagnostics.push({
                  code: "BUNEST_REPO003",
                  severity: "warning",
                  message: `Parameter "${actual.name}" of "${mName}" has type "${actual.tsType}", expected "${expected.tsType}".`,
                  location: actual.location,
                });
              }
            }
          }

          // BUNEST_REPO004: Return type mismatch
          if (
            method.getReturnTypeNode() &&
            !isReturnTypeCompatible(
              retTypeNodeText,
              parsedDerived.kind,
              entityName,
              Boolean(projectedFields && projectedFields.length > 0),
            )
          ) {
            diagnostics.push({
              code: "BUNEST_REPO004",
              severity: "warning",
              message: `Derived query "${mName}" returns "${retTypeNodeText}", expected "${parsedDerived.expectedReturnType}".`,
              location: nodeToLocation(method.getReturnTypeNode()!),
              fixData: {
                kind: "fixReturnType",
                replacement: parsedDerived.expectedReturnType,
              },
            });
          }

          // BUNEST_REPO005: Operator incompatible with column type
          for (const opErr of parsedDerived.operatorTypeErrors) {
            diagnostics.push({
              code: "BUNEST_REPO005",
              severity: "error",
              message: `Derived query "${mName}": ${opErr.reason}`,
              location: mLoc,
            });
          }

          methods.push({
            name: mName,
            kind: "derived",
            isAbstract,
            location: mLoc,
            methodStart: method.getStart(),
            methodEnd: method.getEnd(),
            params,
            returnTypeText: retTypeNodeText,
            ...(projectedFields && projectedFields.length > 0
              ? { projectedFields }
              : {}),
            ...(ignoredScopeSet.size > 0
              ? { ignoredScopes: [...ignoredScopeSet] }
              : {}),
            ...(ignoreAllScopes ? { ignoreAllScopes: true } : {}),
            derived: parsedDerived,
          });
          continue;
        }

        methods.push({
          name: mName,
          kind: "concrete",
          isAbstract,
          location: mLoc,
          methodStart: method.getStart(),
          methodEnd: method.getEnd(),
          params,
          returnTypeText: retTypeNodeText,
          ...(projectedFields && projectedFields.length > 0
            ? { projectedFields }
            : {}),
          ...(ignoredScopeSet.size > 0
            ? { ignoredScopes: [...ignoredScopeSet] }
            : {}),
          ...(ignoreAllScopes ? { ignoreAllScopes: true } : {}),
        });
      }

      repositories.push({
        className,
        driver,
        dialect,
        baseClassName,
        hasRepositoryDecorator: Boolean(repoDec),
        entityName,
        entity,
        tableName,
        idColumn,
        idTsType,
        camelCaseMapping,
        ...(repoScopes.length > 0 ? { scopes: repoScopes } : {}),
        sourceFile: sf.getFilePath(),
        location: nodeToLocation(cls.getNameNode() ?? cls),
        methods,
      });
    }
  }

  return {
    entities: [...entitiesByClass.values()],
    repositories,
    diagnostics,
  };
}

function normalizeSimpleType(t: string): string {
  return t
    .replace(/\breadonly\s+/g, "")
    .replace(/\s+/g, "")
    .replace(/^\((.*)\)$/, "$1");
}

function isParamTypeCompatible(actual: string, expected: string): boolean {
  const a = normalizeSimpleType(actual);
  const e = normalizeSimpleType(expected);
  if (a === e || a === "any" || a === "unknown" || e === "unknown") return true;
  if (e.endsWith("[]") || e.startsWith("Array<") || e.startsWith("ReadonlyArray<")) {
    return (
      a.endsWith("[]") ||
      a.startsWith("Array<") ||
      a.startsWith("ReadonlyArray<")
    );
  }
  // Allow `string | Date` for Date columns, `number | boolean` for SQLite boolean columns
  if (e === "Date" && (a === "string" || a === "number")) return true;
  if (e === "boolean" && a === "number") return true;
  return a.includes(e) || e.includes(a);
}

function isReturnTypeCompatible(
  returnTypeText: string,
  kind: DerivedQueryKind,
  entityName?: string,
  hasProjection = false,
): boolean {
  const compact = returnTypeText.replace(/\s+/g, "");
  if (compact === "any" || compact === "Promise<any>" || compact === "Promise<unknown>") {
    return true;
  }
  switch (kind) {
    case "exists":
      return compact === "Promise<boolean>";
    case "count":
    case "delete":
      return compact === "Promise<number>" || (kind === "delete" && compact === "Promise<void>");
    case "findPage":
      return compact.startsWith("Promise<Page<");
    case "findCursor":
      return compact.startsWith("Promise<CursorPage<");
    case "findAll":
      return (
        compact.includes("[]") ||
        compact.includes("Array<") ||
        compact.includes("ReadonlyArray<")
      );
    case "findOne":
      if (compact.includes("[]") || compact.includes("Array<")) return false;
      if (hasProjection && compact.startsWith("Promise<")) {
        return true;
      }
      if (entityName && !compact.includes(entityName)) return false;
      return compact.startsWith("Promise<");
  }
}
