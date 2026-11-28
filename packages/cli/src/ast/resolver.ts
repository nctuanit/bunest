import { SyntaxKind, TypeFormatFlags } from "./syntax-kind";
import type {
  BunestArrayLiteralExpression,
  BunestArrayTypeNode,
  BunestArrowFunction,
  BunestAsExpression,
  BunestCallExpression,
  BunestClassDeclaration,
  BunestFunctionDeclaration,
  BunestFunctionExpression,
  BunestFunctionTypeNode,
  BunestInterfaceDeclaration,
  BunestMethodDeclaration,
  BunestMethodSignature,
  BunestNewExpression,
  BunestNode,
  BunestNumericLiteral,
  BunestObjectLiteralExpression,
  BunestParameterDeclaration,
  BunestParenthesizedExpression,
  BunestPropertyAccessExpression,
  BunestPropertyAssignment,
  BunestPropertyDeclaration,
  BunestPropertySignature,
  BunestReturnStatement,
  BunestShorthandPropertyAssignment,
  BunestSourceFile,
  BunestStringLiteral,
  BunestTypeAliasDeclaration,
  BunestTypeLiteralNode,
  BunestTypeOperatorNode,
  BunestTypeReferenceNode,
  BunestUnionTypeNode,
  BunestVariableDeclaration,
} from "./source-file";

export interface ResolverProjectHost {
  getSourceFile(filePath: string): BunestSourceFile | undefined;
  getSourceFiles(): BunestSourceFile[];
  addSourceFileAtPathIfExists(filePath: string): BunestSourceFile | undefined;
  resolveModulePath(fromFilePath: string, specifier: string): string | undefined;
}

export class BunestSymbol {
  readonly name: string;
  readonly declarations: readonly BunestNode[];
  readonly valueDeclaration?: BunestNode;
  readonly aliasedSymbol?: BunestSymbol;
  readonly optional: boolean;
  private readonly resolver: TypeResolver;
  private readonly explicitType?: BunestType;

  constructor(options: {
    readonly name: string;
    readonly declarations: readonly BunestNode[];
    readonly valueDeclaration?: BunestNode;
    readonly aliasedSymbol?: BunestSymbol;
    readonly optional?: boolean;
    readonly resolver: TypeResolver;
    readonly explicitType?: BunestType;
  }) {
    this.name = options.name;
    this.declarations = options.declarations;
    this.valueDeclaration = options.valueDeclaration ?? options.declarations[0];
    this.aliasedSymbol = options.aliasedSymbol;
    this.optional = options.optional ?? false;
    this.resolver = options.resolver;
    this.explicitType = options.explicitType;
  }

  getName(): string {
    return this.name;
  }

  getDeclarations(): BunestNode[] {
    return [...this.declarations];
  }

  getValueDeclaration(): BunestNode | undefined {
    return this.valueDeclaration;
  }

  getAliasedSymbol(): BunestSymbol | undefined {
    return this.aliasedSymbol;
  }

  isOptional(): boolean {
    return this.optional;
  }

  getTypeAtLocation(node: BunestNode): BunestType {
    if (this.explicitType) return this.explicitType;
    const target = this.valueDeclaration ?? node;
    return this.resolver.getNodeType(target);
  }
}

export class BunestSignature {
  private readonly parameters: readonly BunestSymbol[];
  private readonly returnType: BunestType;

  constructor(parameters: readonly BunestSymbol[], returnType: BunestType) {
    this.parameters = parameters;
    this.returnType = returnType;
  }

  getParameters(): BunestSymbol[] {
    return [...this.parameters];
  }

  getReturnType(): BunestType {
    return this.returnType;
  }
}

export type BunestTypeKind =
  | "primitive"
  | "stringLiteral"
  | "numberLiteral"
  | "booleanLiteral"
  | "union"
  | "intersection"
  | "array"
  | "tuple"
  | "object"
  | "reference"
  | "classInstance"
  | "classCtor"
  | "interface"
  | "enum"
  | "function"
  | "raw";

export interface BunestObjectProp {
  readonly name: string;
  readonly type: BunestType;
  readonly optional: boolean;
  readonly declaration?: BunestNode;
}

export interface BunestTypeData {
  readonly kind: BunestTypeKind;
  readonly name?: string;
  readonly literalValue?: string | number | boolean;
  readonly rawText?: string;
  readonly members?: readonly BunestType[];
  readonly elementType?: BunestType;
  readonly typeArguments?: readonly BunestType[];
  readonly symbol?: BunestSymbol;
  readonly aliasSymbol?: BunestSymbol;
  readonly declaration?: BunestNode;
  readonly objectProps?: readonly BunestObjectProp[];
  readonly callSignatures?: readonly BunestSignature[];
  readonly constructSignatures?: readonly BunestSignature[];
  readonly underlyingType?: BunestType;
}

export class BunestType {
  readonly data: BunestTypeData;
  private readonly resolver: TypeResolver;

  constructor(data: BunestTypeData, resolver: TypeResolver) {
    this.data = data;
    this.resolver = resolver;
  }

  private effective(): BunestType {
    if (this.data.underlyingType) return this.data.underlyingType;
    return this;
  }

  isString(): boolean {
    const t = this.effective();
    return t.data.kind === "primitive" && t.data.name === "string";
  }

  isStringLiteral(): boolean {
    return this.effective().data.kind === "stringLiteral";
  }

  isNumber(): boolean {
    const t = this.effective();
    return (
      t.data.kind === "primitive" &&
      (t.data.name === "number" || t.data.name === "bigint")
    );
  }

  isNumberLiteral(): boolean {
    return this.effective().data.kind === "numberLiteral";
  }

  isBoolean(): boolean {
    const t = this.effective();
    return t.data.kind === "primitive" && t.data.name === "boolean";
  }

  isBooleanLiteral(): boolean {
    return this.effective().data.kind === "booleanLiteral";
  }

  isUndefined(): boolean {
    const t = this.effective();
    return t.data.kind === "primitive" && t.data.name === "undefined";
  }

  isNull(): boolean {
    const t = this.effective();
    return t.data.kind === "primitive" && t.data.name === "null";
  }

  isAny(): boolean {
    const t = this.effective();
    return t.data.kind === "primitive" && t.data.name === "any";
  }

  isUnknown(): boolean {
    const t = this.effective();
    return t.data.kind === "primitive" && t.data.name === "unknown";
  }

  isVoid(): boolean {
    const t = this.effective();
    return t.data.kind === "primitive" && t.data.name === "void";
  }

  isNullable(): boolean {
    const t = this.effective();
    if (t.isNull() || t.isUndefined()) return true;
    if (t.data.kind === "union") {
      return (t.data.members ?? []).some((m) => m.isNull() || m.isUndefined());
    }
    return false;
  }

  isUnion(): boolean {
    return this.effective().data.kind === "union";
  }

  getUnionTypes(): BunestType[] {
    const t = this.effective();
    if (t.data.kind === "union") {
      return [...(t.data.members ?? [])];
    }
    return [];
  }

  getNonNullableType(): BunestType {
    const t = this.effective();
    if (t.data.kind === "union") {
      const kept = (t.data.members ?? []).filter(
        (m) => !m.isNull() && !m.isUndefined(),
      );
      if (kept.length === 0) return this.resolver.primitiveType("never");
      if (kept.length === 1) return kept[0]!;
      return new BunestType({ kind: "union", members: kept }, this.resolver);
    }
    return this;
  }

  isArray(): boolean {
    const t = this.effective();
    if (t.data.kind === "array") return true;
    if (t.data.kind === "reference" && t.data.name === "Array") return true;
    return false;
  }

  isTuple(): boolean {
    return this.effective().data.kind === "tuple";
  }

  isObject(): boolean {
    const t = this.effective();
    return (
      t.data.kind === "object" ||
      t.data.kind === "classInstance" ||
      t.data.kind === "interface" ||
      t.data.kind === "array" ||
      t.data.kind === "tuple" ||
      t.data.kind === "function" ||
      (t.data.kind === "primitive" && t.data.name === "object")
    );
  }

  getArrayElementType(): BunestType | undefined {
    const t = this.effective();
    if (t.data.kind === "array") return t.data.elementType;
    if (
      t.data.kind === "reference" &&
      (t.data.name === "Array" || t.data.name === "ReadonlyArray")
    ) {
      return t.data.typeArguments?.[0];
    }
    return undefined;
  }

  getTypeArguments(): BunestType[] {
    const t = this.effective();
    if (t.data.typeArguments && t.data.typeArguments.length > 0) {
      return [...t.data.typeArguments];
    }
    if (t.data.kind === "array" && t.data.elementType) {
      return [t.data.elementType];
    }
    return [];
  }

  getSymbol(): BunestSymbol | undefined {
    if (this.data.symbol) return this.data.symbol;
    const t = this.effective();
    if (t.data.symbol) return t.data.symbol;
    if (t.data.kind === "array") {
      return new BunestSymbol({
        name: "Array",
        declarations: [],
        resolver: this.resolver,
      });
    }
    if (t.data.kind === "reference" && t.data.name) {
      return new BunestSymbol({
        name: t.data.name,
        declarations: t.data.declaration ? [t.data.declaration] : [],
        resolver: this.resolver,
      });
    }
    return undefined;
  }

  getAliasSymbol(): BunestSymbol | undefined {
    return this.data.aliasSymbol;
  }

  getProperties(): BunestSymbol[] {
    const t = this.effective();
    if (t.data.kind === "classInstance" && t.data.declaration) {
      return this.resolver.getClassInstanceProperties(
        t.data.declaration as BunestClassDeclaration,
      );
    }
    if (t.data.kind === "interface" && t.data.declaration) {
      return this.resolver.getInterfaceProperties(
        t.data.declaration as BunestInterfaceDeclaration,
      );
    }
    if (t.data.objectProps) {
      return t.data.objectProps.map(
        (p) =>
          new BunestSymbol({
            name: p.name,
            declarations: p.declaration ? [p.declaration] : [],
            valueDeclaration: p.declaration,
            optional: p.optional,
            resolver: this.resolver,
            explicitType: p.type,
          }),
      );
    }
    return [];
  }

  getCallSignatures(): BunestSignature[] {
    const t = this.effective();
    return [...(t.data.callSignatures ?? [])];
  }

  getConstructSignatures(): BunestSignature[] {
    const t = this.effective();
    return [...(t.data.constructSignatures ?? [])];
  }

  getText(enclosingNode?: BunestNode, flags?: TypeFormatFlags): string {
    const qualifyImports = enclosingNode === undefined;
    return this.format(qualifyImports, flags ?? TypeFormatFlags.None, new Set());
  }

  private format(
    qualifyImports: boolean,
    flags: TypeFormatFlags,
    seen: Set<BunestType>,
  ): string {
    if (seen.has(this)) return this.data.name ?? "any";
    seen.add(this);

    const d = this.data;

    // If this is a named type alias (e.g. `export type Foo = ...`), format by its alias name
    if (d.aliasSymbol && d.declaration) {
      const name = d.aliasSymbol.getName();
      const args =
        d.typeArguments && d.typeArguments.length > 0
          ? `<${d.typeArguments.map((a) => a.format(qualifyImports, flags, seen)).join(", ")}>`
          : "";
      if (qualifyImports) {
        const declFile = d.declaration.getSourceFile().getFilePath();
        return `import(${JSON.stringify(declFile)}).${name}${args}`;
      }
      return `${name}${args}`;
    }

    switch (d.kind) {
      case "primitive":
        return d.name ?? "unknown";
      case "stringLiteral":
        return JSON.stringify(String(d.literalValue ?? ""));
      case "numberLiteral":
        return String(d.literalValue ?? 0);
      case "booleanLiteral":
        return d.literalValue ? "true" : "false";
      case "union": {
        const parts = (d.members ?? []).map((m) =>
          m.format(qualifyImports, flags, seen),
        );
        return parts.join(" | ");
      }
      case "intersection": {
        const parts = (d.members ?? []).map((m) =>
          m.format(qualifyImports, flags, seen),
        );
        return parts.join(" & ");
      }
      case "array": {
        const elem = d.elementType;
        if (!elem) return "unknown[]";
        const elemStr = elem.format(qualifyImports, flags, seen);
        const needsParens =
          elem.data.kind === "union" ||
          elem.data.kind === "intersection" ||
          elem.data.kind === "function";
        return needsParens ? `(${elemStr})[]` : `${elemStr}[]`;
      }
      case "tuple": {
        const elems = (d.members ?? []).map((m) =>
          m.format(qualifyImports, flags, seen),
        );
        return `[${elems.join(", ")}]`;
      }
      case "classInstance":
      case "interface":
      case "enum": {
        const name = d.name ?? "unknown";
        const args =
          d.typeArguments && d.typeArguments.length > 0
            ? `<${d.typeArguments.map((a) => a.format(qualifyImports, flags, seen)).join(", ")}>`
            : "";
        if (qualifyImports && d.declaration) {
          const declFile = d.declaration.getSourceFile().getFilePath();
          return `import(${JSON.stringify(declFile)}).${name}${args}`;
        }
        return `${name}${args}`;
      }
      case "classCtor": {
        const name = d.name ?? "unknown";
        if (qualifyImports && d.declaration) {
          const declFile = d.declaration.getSourceFile().getFilePath();
          return `typeof import(${JSON.stringify(declFile)}).${name}`;
        }
        return `typeof ${name}`;
      }
      case "reference": {
        const name = d.name ?? "unknown";
        const args =
          d.typeArguments && d.typeArguments.length > 0
            ? `<${d.typeArguments.map((a) => a.format(qualifyImports, flags, seen)).join(", ")}>`
            : "";
        if (qualifyImports && d.declaration) {
          const declFile = d.declaration.getSourceFile().getFilePath();
          return `import(${JSON.stringify(declFile)}).${name}${args}`;
        }
        return `${name}${args}`;
      }
      case "object": {
        const props = d.objectProps ?? [];
        if (props.length === 0) return "{}";
        const formatted = props.map((p) => {
          const key = /^[A-Za-z_$][\w$]*$/.test(p.name)
            ? p.name
            : JSON.stringify(p.name);
          const opt = p.optional ? "?" : "";
          return `${key}${opt}: ${p.type.format(qualifyImports, flags, seen)}`;
        });
        return `{ ${formatted.join("; ")}; }`;
      }
      case "function": {
        const sig = d.callSignatures?.[0];
        if (!sig) return "(...args: unknown[]) => unknown";
        const params = sig
          .getParameters()
          .map((p) => {
            const pDecl = p.getValueDeclaration();
            const pType = pDecl
              ? p.getTypeAtLocation(pDecl)
              : this.resolver.primitiveType("unknown");
            return `${p.getName()}${p.isOptional() ? "?" : ""}: ${pType.format(qualifyImports, flags, seen)}`;
          })
          .join(", ");
        const ret = sig.getReturnType().format(qualifyImports, flags, seen);
        return `(${params}) => ${ret}`;
      }
      case "raw":
      default:
        return d.rawText ?? "unknown";
    }
  }
}

const BUILTIN_GLOBAL_TYPES = new Set([
  "Promise",
  "PromiseLike",
  "Array",
  "ReadonlyArray",
  "Set",
  "ReadonlySet",
  "Map",
  "ReadonlyMap",
  "WeakMap",
  "WeakSet",
  "Record",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "NonNullable",
  "ReturnType",
  "Parameters",
  "ConstructorParameters",
  "InstanceType",
  "Awaited",
  "Date",
  "RegExp",
  "Error",
  "Function",
  "Object",
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "ArrayBuffer",
  "Buffer",
  "URL",
  "URLSearchParams",
  "Headers",
  "Request",
  "Response",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "AbortSignal",
  "AbortController",
]);

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

export class TypeResolver {
  private readonly project: ResolverProjectHost;
  private readonly exportsCache = new Map<string, Map<string, BunestNode[]>>();

  constructor(project: ResolverProjectHost) {
    this.project = project;
  }

  invalidate(): void {
    this.exportsCache.clear();
  }

  primitiveType(name: string): BunestType {
    return new BunestType({ kind: "primitive", name }, this);
  }

  // ─── Module & Export Resolution ──────────────────────────────────────────

  resolveModuleSourceFile(
    fromFilePath: string,
    specifier: string,
  ): BunestSourceFile | undefined {
    const resolvedPath = this.project.resolveModulePath(
      fromFilePath,
      specifier,
    );
    if (!resolvedPath) return undefined;
    return (
      this.project.getSourceFile(resolvedPath) ??
      this.project.addSourceFileAtPathIfExists(resolvedPath)
    );
  }

  getExportedDeclarations(
    sf: BunestSourceFile,
    visited = new Set<string>(),
  ): Map<string, BunestNode[]> {
    const fp = sf.getFilePath();
    const cached = this.exportsCache.get(fp);
    if (cached) return cached;
    if (visited.has(fp)) return new Map();
    visited.add(fp);

    const result = new Map<string, BunestNode[]>();
    const add = (name: string, node: BunestNode) => {
      const list = result.get(name) ?? [];
      if (!list.includes(node)) list.push(node);
      result.set(name, list);
    };

    const locals = this.collectTopLevelDeclarations(sf);

    // 1. Directly exported top-level declarations
    for (const cls of sf.getClasses()) {
      if (cls.hasExportModifier()) {
        const name = cls.getName();
        if (name) add(name, cls);
        if (cls.hasDefaultModifier()) add("default", cls);
      }
    }
    for (const iface of sf.getInterfaces()) {
      if (iface.hasExportModifier()) {
        const name = iface.getName();
        if (name) add(name, iface);
      }
    }
    for (const ta of sf.getTypeAliases()) {
      if (ta.hasExportModifier()) {
        const name = ta.getName();
        if (name) add(name, ta);
      }
    }
    for (const en of sf.getEnums()) {
      if (en.hasExportModifier()) {
        const name = en.getName();
        if (name) add(name, en);
      }
    }
    for (const fn of sf.getFunctions()) {
      if (fn.hasExportModifier()) {
        const name = fn.getName();
        if (name) add(name, fn);
        if (fn.hasDefaultModifier()) add("default", fn);
      }
    }
    for (const varDecl of sf.getVariableDeclarations()) {
      if (varDecl.getVariableStatement()?.isExported()) {
        add(varDecl.getName(), varDecl);
      }
    }

    // 2. `export { ... }` / `export { ... } from "..."` / `export * from "..."`
    for (const expDecl of sf.getExportDeclarations()) {
      const spec = expDecl.getModuleSpecifierValue();
      if (spec) {
        const targetSf = this.resolveModuleSourceFile(fp, spec);
        if (!targetSf) continue;
        const targetExports = this.getExportedDeclarations(targetSf, visited);
        if (expDecl.isNamespaceExport()) {
          for (const [k, decls] of targetExports) {
            if (k === "default") continue;
            for (const d of decls) add(k, d);
          }
        } else {
          for (const named of expDecl.getNamedExports()) {
            const origName = named.getName();
            const outName = named.getAliasName() ?? origName;
            const targetDecls = targetExports.get(origName);
            if (targetDecls) {
              for (const d of targetDecls) add(outName, d);
            }
          }
        }
      } else {
        for (const named of expDecl.getNamedExports()) {
          const localName = named.getName();
          const outName = named.getAliasName() ?? localName;
          const localNode = locals.get(localName);
          if (localNode) {
            add(outName, localNode);
          } else {
            // Re-exporting an imported symbol
            const sym = this.resolveIdentifierSymbol(localName, sf);
            const target =
              sym?.getAliasedSymbol()?.getDeclarations()[0] ??
              sym?.getDeclarations()[0];
            if (target) add(outName, target);
          }
        }
      }
    }

    this.exportsCache.set(fp, result);
    return result;
  }

  private collectTopLevelDeclarations(
    sf: BunestSourceFile,
  ): Map<string, BunestNode> {
    const map = new Map<string, BunestNode>();
    for (const cls of sf.getClasses()) {
      const n = cls.getName();
      if (n) map.set(n, cls);
    }
    for (const iface of sf.getInterfaces()) {
      const n = iface.getName();
      if (n) map.set(n, iface);
    }
    for (const ta of sf.getTypeAliases()) {
      const n = ta.getName();
      if (n) map.set(n, ta);
    }
    for (const en of sf.getEnums()) {
      const n = en.getName();
      if (n) map.set(n, en);
    }
    for (const fn of sf.getFunctions()) {
      const n = fn.getName();
      if (n) map.set(n, fn);
    }
    for (const v of sf.getVariableDeclarations()) {
      map.set(v.getName(), v);
    }
    return map;
  }

  // ─── Identifier & Symbol Resolution ──────────────────────────────────────

  resolveIdentifierSymbol(
    name: string,
    sf: BunestSourceFile,
    contextNode?: BunestNode,
  ): BunestSymbol | undefined {
    // 1. Check enclosing function/method/arrow parameters if contextNode provided
    if (contextNode) {
      let cur: BunestNode | undefined = contextNode.getParent();
      while (cur) {
        if (
          cur.getKind() === SyntaxKind.MethodDeclaration ||
          cur.getKind() === SyntaxKind.FunctionDeclaration ||
          cur.getKind() === SyntaxKind.ArrowFunction ||
          cur.getKind() === SyntaxKind.FunctionExpression ||
          cur.getKind() === SyntaxKind.Constructor
        ) {
          const params = (
            cur as { getParameters?: () => BunestParameterDeclaration[] }
          ).getParameters?.();
          if (params) {
            const matched = params.find((p) => p.getName() === name);
            if (matched) {
              return new BunestSymbol({
                name,
                declarations: [matched],
                valueDeclaration: matched,
                optional: matched.isOptional(),
                resolver: this,
              });
            }
          }
        }
        cur = cur.getParent();
      }
    }

    // 2. Local top-level declarations in same file
    const locals = this.collectTopLevelDeclarations(sf);
    const localDecl = locals.get(name);
    if (localDecl) {
      return new BunestSymbol({
        name,
        declarations: [localDecl],
        valueDeclaration: localDecl,
        resolver: this,
      });
    }

    // 3. Imports in same file
    for (const imp of sf.getImportDeclarations()) {
      const spec = imp.getModuleSpecifierValue();
      const defImp = imp.getDefaultImport();
      if (defImp && defImp.getText() === name) {
        const targetSf = this.resolveModuleSourceFile(sf.getFilePath(), spec);
        const targetDecls = targetSf
          ? this.getExportedDeclarations(targetSf).get("default")
          : undefined;
        const aliased =
          targetDecls && targetDecls.length > 0
            ? new BunestSymbol({
                name: this.getDeclarationName(targetDecls[0]!) ?? name,
                declarations: targetDecls,
                valueDeclaration: targetDecls[0],
                resolver: this,
              })
            : undefined;
        return new BunestSymbol({
          name,
          declarations: [imp],
          valueDeclaration: imp,
          aliasedSymbol: aliased,
          resolver: this,
        });
      }

      for (const named of imp.getNamedImports()) {
        const localName = named.getAliasNode()?.getText() ?? named.getName();
        if (localName !== name) continue;
        const origName = named.getName();
        const targetSf = this.resolveModuleSourceFile(sf.getFilePath(), spec);
        const targetDecls = targetSf
          ? this.getExportedDeclarations(targetSf).get(origName)
          : undefined;
        const aliased =
          targetDecls && targetDecls.length > 0
            ? new BunestSymbol({
                name: origName,
                declarations: targetDecls,
                valueDeclaration: targetDecls[0],
                resolver: this,
              })
            : undefined;
        return new BunestSymbol({
          name: localName,
          declarations: [named],
          valueDeclaration: named,
          aliasedSymbol: aliased,
          resolver: this,
        });
      }
    }

    return undefined;
  }

  private resolveNamespaceMember(
    nsName: string,
    memberName: string,
    sf: BunestSourceFile,
  ): BunestNode | undefined {
    for (const imp of sf.getImportDeclarations()) {
      const ns = imp.getNamespaceImport();
      if (ns && ns.getText() === nsName) {
        const targetSf = this.resolveModuleSourceFile(
          sf.getFilePath(),
          imp.getModuleSpecifierValue(),
        );
        const decls = targetSf
          ? this.getExportedDeclarations(targetSf).get(memberName)
          : undefined;
        if (decls && decls.length > 0) return decls[0];
      }
    }
    return undefined;
  }

  private getDeclarationName(node: BunestNode): string | undefined {
    const maybe = node as { getName?: () => string | undefined };
    return typeof maybe.getName === "function" ? maybe.getName() : undefined;
  }

  resolveBaseClass(
    cls: BunestClassDeclaration,
  ): BunestClassDeclaration | undefined {
    const ext = cls.getExtends();
    if (!ext) return undefined;
    const expr = ext.getExpression();
    if (expr.getKind() !== SyntaxKind.Identifier) return undefined;
    const sym = this.resolveIdentifierSymbol(
      expr.getText(),
      cls.getSourceFile(),
    );
    const decl =
      sym?.getAliasedSymbol()?.getDeclarations()[0] ??
      sym?.getDeclarations()[0];
    if (decl && decl.getKind() === SyntaxKind.ClassDeclaration) {
      return decl as BunestClassDeclaration;
    }
    return undefined;
  }

  // ─── Class & Interface Members ───────────────────────────────────────────

  getClassInstanceProperties(cls: BunestClassDeclaration): BunestSymbol[] {
    const props = new Map<string, BunestSymbol>();
    const chain: BunestClassDeclaration[] = [];
    const visited = new Set<BunestClassDeclaration>();
    let cur: BunestClassDeclaration | undefined = cls;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      chain.unshift(cur);
      cur = this.resolveBaseClass(cur);
    }

    for (const c of chain) {
      for (const p of c.getProperties()) {
        if (p.isStatic()) continue;
        const name = p.getName();
        props.set(
          name,
          new BunestSymbol({
            name,
            declarations: [p],
            valueDeclaration: p,
            optional: p.hasQuestionToken(),
            resolver: this,
          }),
        );
      }
      for (const m of c.getMethods()) {
        if (m.isStatic()) continue;
        const name = m.getName();
        props.set(
          name,
          new BunestSymbol({
            name,
            declarations: [m],
            valueDeclaration: m,
            optional: m.hasQuestionToken(),
            resolver: this,
            explicitType: this.makeCallableType(m),
          }),
        );
      }
    }

    return [...props.values()];
  }

  getInterfaceProperties(iface: BunestInterfaceDeclaration): BunestSymbol[] {
    const props = new Map<string, BunestSymbol>();
    const visited = new Set<BunestInterfaceDeclaration>();

    const visit = (cur: BunestInterfaceDeclaration): void => {
      if (visited.has(cur)) return;
      visited.add(cur);
      for (const ext of cur.getExtends()) {
        const expr = ext.getExpression();
        if (expr.getKind() === SyntaxKind.Identifier) {
          const sym = this.resolveIdentifierSymbol(
            expr.getText(),
            cur.getSourceFile(),
          );
          const decl =
            sym?.getAliasedSymbol()?.getDeclarations()[0] ??
            sym?.getDeclarations()[0];
          if (decl && decl.getKind() === SyntaxKind.InterfaceDeclaration) {
            visit(decl as BunestInterfaceDeclaration);
          }
        }
      }
      for (const mem of cur.getMembers()) {
        if (mem.getKind() === SyntaxKind.PropertySignature) {
          const ps = mem as BunestPropertySignature;
          const name = ps.getName();
          props.set(
            name,
            new BunestSymbol({
              name,
              declarations: [ps],
              valueDeclaration: ps,
              optional: ps.hasQuestionToken(),
              resolver: this,
              explicitType: ps.getTypeNode()
                ? this.resolveTypeNode(ps.getTypeNode()!)
                : this.primitiveType("any"),
            }),
          );
        } else if (mem.getKind() === SyntaxKind.MethodSignature) {
          const ms = mem as BunestMethodSignature;
          const name = ms.getName();
          props.set(
            name,
            new BunestSymbol({
              name,
              declarations: [ms],
              valueDeclaration: ms,
              optional: ms.hasQuestionToken(),
              resolver: this,
              explicitType: this.makeSignatureCallableType(
                ms.getParameters(),
                ms.getReturnTypeNode()
                  ? this.resolveTypeNode(ms.getReturnTypeNode()!)
                  : this.primitiveType("any"),
              ),
            }),
          );
        }
      }
    };

    visit(iface);
    return [...props.values()];
  }

  private makeCallableType(
    fn:
      | BunestMethodDeclaration
      | BunestFunctionDeclaration
      | BunestArrowFunction
      | BunestFunctionExpression,
  ): BunestType {
    return this.makeSignatureCallableType(
      fn.getParameters(),
      this.getMethodReturnType(fn),
    );
  }

  private makeSignatureCallableType(
    params: readonly BunestParameterDeclaration[],
    returnType: BunestType,
  ): BunestType {
    const paramSyms = params.map((p) => {
      const typeNode = p.getTypeNode();
      const init = p.getInitializer();
      let explicitType: BunestType;
      if (typeNode) {
        explicitType = this.resolveTypeNode(typeNode);
      } else if (init) {
        explicitType = this.inferExpressionType(init);
      } else {
        explicitType = this.primitiveType("any");
      }
      return new BunestSymbol({
        name: p.getName(),
        declarations: [p],
        valueDeclaration: p,
        optional: p.isOptional() || p.hasInitializer(),
        resolver: this,
        explicitType,
      });
    });
    return new BunestType(
      {
        kind: "function",
        callSignatures: [new BunestSignature(paramSyms, returnType)],
      },
      this,
    );
  }

  // ─── TypeNode Resolution ─────────────────────────────────────────────────

  resolveTypeNode(
    node: BunestNode,
    depth = 0,
  ): BunestType {
    if (depth > 16) return this.primitiveType("unknown");
    const kind = node.getKind();

    switch (kind) {
      case SyntaxKind.StringKeyword:
        return this.primitiveType("string");
      case SyntaxKind.NumberKeyword:
        return this.primitiveType("number");
      case SyntaxKind.BooleanKeyword:
        return this.primitiveType("boolean");
      case SyntaxKind.BigIntKeyword:
        return this.primitiveType("bigint");
      case SyntaxKind.SymbolKeyword:
        return this.primitiveType("symbol");
      case SyntaxKind.VoidKeyword:
        return this.primitiveType("void");
      case SyntaxKind.UndefinedKeyword:
        return this.primitiveType("undefined");
      case SyntaxKind.NullKeyword:
        return this.primitiveType("null");
      case SyntaxKind.NeverKeyword:
        return this.primitiveType("never");
      case SyntaxKind.AnyKeyword:
        return this.primitiveType("any");
      case SyntaxKind.UnknownKeyword:
        return this.primitiveType("unknown");
      case SyntaxKind.ObjectKeyword:
        return this.primitiveType("object");
      case SyntaxKind.TrueKeyword:
        return new BunestType(
          { kind: "booleanLiteral", literalValue: true },
          this,
        );
      case SyntaxKind.FalseKeyword:
        return new BunestType(
          { kind: "booleanLiteral", literalValue: false },
          this,
        );
      case SyntaxKind.LiteralType: {
        const lit = node.getChildAt(0);
        if (lit) {
          if (
            lit.getKind() === SyntaxKind.StringLiteral ||
            lit.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
          ) {
            return new BunestType(
              {
                kind: "stringLiteral",
                literalValue: (lit as BunestStringLiteral).getLiteralValue(),
              },
              this,
            );
          }
          if (lit.getKind() === SyntaxKind.NumericLiteral) {
            return new BunestType(
              {
                kind: "numberLiteral",
                literalValue: (lit as BunestNumericLiteral).getLiteralValue(),
              },
              this,
            );
          }
        }
        return new BunestType({ kind: "raw", rawText: node.getText().trim() }, this);
      }
      case SyntaxKind.ParenthesizedType: {
        const inner = node.getChildAt(0);
        return inner
          ? this.resolveTypeNode(inner, depth + 1)
          : this.primitiveType("unknown");
      }
      case SyntaxKind.UnionType: {
        const typeNodes = (node as BunestUnionTypeNode).getTypeNodes();
        const members = typeNodes.map((t) => this.resolveTypeNode(t, depth + 1));
        return new BunestType({ kind: "union", members }, this);
      }
      case SyntaxKind.IntersectionType: {
        const typeNodes = (node as BunestUnionTypeNode).getTypeNodes();
        const members = typeNodes.map((t) => this.resolveTypeNode(t, depth + 1));
        return new BunestType({ kind: "intersection", members }, this);
      }
      case SyntaxKind.ArrayType: {
        const elemNode = (node as BunestArrayTypeNode).getElementTypeNode();
        return new BunestType(
          {
            kind: "array",
            elementType: this.resolveTypeNode(elemNode, depth + 1),
          },
          this,
        );
      }
      case SyntaxKind.TupleType: {
        const elems = node
          .getChildren()
          .map((c) => this.resolveTypeNode(c, depth + 1));
        return new BunestType({ kind: "tuple", members: elems }, this);
      }
      case SyntaxKind.TypeLiteral: {
        const members = (node as BunestTypeLiteralNode).getMembers();
        const objectProps: BunestObjectProp[] = [];
        for (const mem of members) {
          if (mem.getKind() === SyntaxKind.PropertySignature) {
            const ps = mem as BunestPropertySignature;
            objectProps.push({
              name: stripQuotes(ps.getName()),
              type: ps.getTypeNode()
                ? this.resolveTypeNode(ps.getTypeNode()!, depth + 1)
                : this.primitiveType("any"),
              optional: ps.hasQuestionToken(),
              declaration: ps,
            });
          } else if (mem.getKind() === SyntaxKind.MethodSignature) {
            const ms = mem as BunestMethodSignature;
            objectProps.push({
              name: stripQuotes(ms.getName()),
              type: this.makeSignatureCallableType(
                ms.getParameters(),
                ms.getReturnTypeNode()
                  ? this.resolveTypeNode(ms.getReturnTypeNode()!, depth + 1)
                  : this.primitiveType("any"),
              ),
              optional: ms.hasQuestionToken(),
              declaration: ms,
            });
          }
        }
        return new BunestType({ kind: "object", objectProps }, this);
      }
      case SyntaxKind.FunctionType: {
        const fnNode = node as BunestFunctionTypeNode;
        return this.makeSignatureCallableType(
          fnNode.getParameters(),
          this.resolveTypeNode(fnNode.getReturnTypeNode(), depth + 1),
        );
      }
      case SyntaxKind.TypeOperator: {
        const op = (node as BunestTypeOperatorNode).getOperator();
        const inner = node.getChildAt(0);
        if (op === SyntaxKind.ReadonlyKeyword && inner) {
          const innerType = this.resolveTypeNode(inner, depth + 1);
          if (innerType.data.kind === "array" && innerType.data.elementType) {
            return new BunestType(
              {
                kind: "reference",
                name: "ReadonlyArray",
                typeArguments: [innerType.data.elementType],
              },
              this,
            );
          }
          return innerType;
        }
        return new BunestType({ kind: "raw", rawText: node.getText().trim() }, this);
      }
      case SyntaxKind.TypeReference: {
        const tr = node as BunestTypeReferenceNode;
        const nameText = tr.getTypeName().getText().trim();
        const typeArgs = tr
          .getTypeArguments()
          .map((a) => this.resolveTypeNode(a, depth + 1));

        if (nameText === "Array" && typeArgs.length > 0) {
          return new BunestType(
            {
              kind: "array",
              elementType: typeArgs[0]!,
              typeArguments: typeArgs,
            },
            this,
          );
        }

        if (BUILTIN_GLOBAL_TYPES.has(nameText)) {
          return new BunestType(
            {
              kind: "reference",
              name: nameText,
              typeArguments: typeArgs,
            },
            this,
          );
        }

        // Resolve user symbol across imports (including `ns.TypeName` namespace imports)
        const sf = node.getSourceFile();
        let decl: BunestNode | undefined;
        if (nameText.includes(".")) {
          const dotIdx = nameText.indexOf(".");
          const nsName = nameText.slice(0, dotIdx);
          const memberName = nameText.slice(dotIdx + 1);
          decl = this.resolveNamespaceMember(nsName, memberName, sf);
        } else {
          const sym = this.resolveIdentifierSymbol(nameText, sf);
          const resolvedSym = sym?.getAliasedSymbol() ?? sym;
          decl = resolvedSym?.getDeclarations()[0];
        }

        if (decl) {
          if (decl.getKind() === SyntaxKind.ClassDeclaration) {
            const cls = decl as BunestClassDeclaration;
            const clsName = cls.getName() ?? nameText;
            return new BunestType(
              {
                kind: "classInstance",
                name: clsName,
                typeArguments: typeArgs,
                declaration: cls,
                symbol: new BunestSymbol({
                  name: clsName,
                  declarations: [cls],
                  valueDeclaration: cls,
                  resolver: this,
                }),
              },
              this,
            );
          }
          if (decl.getKind() === SyntaxKind.InterfaceDeclaration) {
            const iface = decl as BunestInterfaceDeclaration;
            const iName = iface.getName() ?? nameText;
            return new BunestType(
              {
                kind: "interface",
                name: iName,
                typeArguments: typeArgs,
                declaration: iface,
                symbol: new BunestSymbol({
                  name: iName,
                  declarations: [iface],
                  valueDeclaration: iface,
                  resolver: this,
                }),
              },
              this,
            );
          }
          if (decl.getKind() === SyntaxKind.TypeAliasDeclaration) {
            const ta = decl as BunestTypeAliasDeclaration;
            const taName = ta.getName() ?? nameText;
            const underlying = this.resolveTypeNode(ta.getTypeNode(), depth + 1);
            const aliasSym = new BunestSymbol({
              name: taName,
              declarations: [ta],
              valueDeclaration: ta,
              resolver: this,
            });
            return new BunestType(
              {
                kind: underlying.data.kind,
                name: taName,
                typeArguments: typeArgs,
                declaration: ta,
                aliasSymbol: aliasSym,
                symbol: underlying.getSymbol() ?? aliasSym,
                underlyingType: underlying,
              },
              this,
            );
          }
          if (decl.getKind() === SyntaxKind.EnumDeclaration) {
            const enName = this.getDeclarationName(decl) ?? nameText;
            return new BunestType(
              {
                kind: "enum",
                name: enName,
                declaration: decl,
                symbol: new BunestSymbol({
                  name: enName,
                  declarations: [decl],
                  valueDeclaration: decl,
                  resolver: this,
                }),
              },
              this,
            );
          }
        }

        return new BunestType(
          {
            kind: "reference",
            name: nameText,
            typeArguments: typeArgs,
          },
          this,
        );
      }
      default:
        return new BunestType(
          { kind: "raw", rawText: node.getText().trim() || "unknown" },
          this,
        );
    }
  }

  // ─── Expression Type Inference ───────────────────────────────────────────

  inferExpressionType(expr: BunestNode, depth = 0): BunestType {
    if (depth > 16) return this.primitiveType("unknown");
    const kind = expr.getKind();

    switch (kind) {
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
      case SyntaxKind.TemplateExpression:
        return this.primitiveType("string");
      case SyntaxKind.NumericLiteral:
      case SyntaxKind.BigIntLiteral:
        return this.primitiveType("number");
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
        return this.primitiveType("boolean");
      case SyntaxKind.NullKeyword:
        return this.primitiveType("null");
      case SyntaxKind.UndefinedKeyword:
        return this.primitiveType("undefined");
      case SyntaxKind.ParenthesizedExpression: {
        const inner = (expr as BunestParenthesizedExpression).getExpression();
        return this.inferExpressionType(inner, depth + 1);
      }
      case SyntaxKind.AsExpression: {
        const asExpr = expr as BunestAsExpression;
        const typeNode = asExpr.getTypeNode();
        if (typeNode.getText().trim() === "const") {
          return this.inferExpressionType(asExpr.getExpression(), depth + 1);
        }
        return this.resolveTypeNode(typeNode, depth + 1);
      }
      case SyntaxKind.SatisfiesExpression: {
        const inner = (expr as BunestAsExpression).getExpression();
        return this.inferExpressionType(inner, depth + 1);
      }
      case SyntaxKind.PrefixUnaryExpression: {
        const txt = expr.getText().trim();
        if (txt.startsWith("!")) return this.primitiveType("boolean");
        if (txt.startsWith("+") || txt.startsWith("-") || txt.startsWith("~")) {
          return this.primitiveType("number");
        }
        return this.primitiveType("unknown");
      }
      case SyntaxKind.TypeOfExpression:
        return this.primitiveType("string");
      case SyntaxKind.AwaitExpression: {
        const inner = expr.getChildAt(0);
        if (!inner) return this.primitiveType("unknown");
        const t = this.inferExpressionType(inner, depth + 1);
        const symName = t.getSymbol()?.getName();
        if (symName === "Promise" || symName === "PromiseLike") {
          return t.getTypeArguments()[0] ?? this.primitiveType("unknown");
        }
        return t;
      }
      case SyntaxKind.ConditionalExpression: {
        const whenTrue = expr.getChildAt(1);
        const whenFalse = expr.getChildAt(2);
        if (whenTrue && whenFalse) {
          const unique = this.deduplicateUnion([
            this.inferExpressionType(whenTrue, depth + 1),
            this.inferExpressionType(whenFalse, depth + 1),
          ]);
          return unique.length === 1
            ? unique[0]!
            : new BunestType({ kind: "union", members: unique }, this);
        }
        return this.primitiveType("unknown");
      }
      case SyntaxKind.BinaryExpression: {
        const left = expr.getChildAt(0);
        const right = expr.getChildAt(1);
        const txt = expr.getText();
        if (/(?:===|!==|==|!=|<=|>=|<|>|\binstanceof\b|\bin\b)/.test(txt)) {
          return this.primitiveType("boolean");
        }
        if (left && right) {
          const lt = this.inferExpressionType(left, depth + 1);
          const rt = this.inferExpressionType(right, depth + 1);
          if (lt.isString() || rt.isString()) return this.primitiveType("string");
          if (lt.isNumber() && rt.isNumber()) return this.primitiveType("number");
        }
        return this.primitiveType("unknown");
      }
      case SyntaxKind.ArrayLiteralExpression: {
        const elems = (expr as BunestArrayLiteralExpression).getElements();
        if (elems.length === 0) {
          return new BunestType(
            { kind: "array", elementType: this.primitiveType("never") },
            this,
          );
        }
        const elemTypes = elems.map((e) =>
          this.inferExpressionType(e, depth + 1),
        );
        const unique = this.deduplicateUnion(elemTypes);
        const elemType =
          unique.length === 1
            ? unique[0]!
            : new BunestType({ kind: "union", members: unique }, this);
        return new BunestType({ kind: "array", elementType: elemType }, this);
      }
      case SyntaxKind.ObjectLiteralExpression: {
        const props = (expr as BunestObjectLiteralExpression).getProperties();
        const objectProps: BunestObjectProp[] = [];
        for (const p of props) {
          if (p.getKind() === SyntaxKind.PropertyAssignment) {
            const pa = p as BunestPropertyAssignment;
            const init = pa.getInitializer();
            objectProps.push({
              name: stripQuotes(pa.getName()),
              type: init
                ? this.inferExpressionType(init, depth + 1)
                : this.primitiveType("unknown"),
              optional: false,
              declaration: p,
            });
          } else if (p.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
            const sh = p as BunestShorthandPropertyAssignment;
            objectProps.push({
              name: sh.getName(),
              type: this.inferExpressionType(sh.getNameNode(), depth + 1),
              optional: false,
              declaration: p,
            });
          }
        }
        return new BunestType({ kind: "object", objectProps }, this);
      }
      case SyntaxKind.NewExpression: {
        const ne = expr as BunestNewExpression;
        const callee = ne.getExpression();
        const typeArgs = ne
          .getTypeArguments()
          .map((t) => this.resolveTypeNode(t, depth + 1));
        if (callee.getKind() === SyntaxKind.Identifier) {
          const name = callee.getText();
          if (BUILTIN_GLOBAL_TYPES.has(name)) {
            return new BunestType(
              { kind: "reference", name, typeArguments: typeArgs },
              this,
            );
          }
          const sym = this.resolveIdentifierSymbol(
            name,
            expr.getSourceFile(),
            expr,
          );
          const decl =
            sym?.getAliasedSymbol()?.getDeclarations()[0] ??
            sym?.getDeclarations()[0];
          if (decl && decl.getKind() === SyntaxKind.ClassDeclaration) {
            const cls = decl as BunestClassDeclaration;
            const clsName = cls.getName() ?? name;
            return new BunestType(
              {
                kind: "classInstance",
                name: clsName,
                typeArguments: typeArgs,
                declaration: cls,
                symbol: new BunestSymbol({
                  name: clsName,
                  declarations: [cls],
                  valueDeclaration: cls,
                  resolver: this,
                }),
              },
              this,
            );
          }
        } else if (callee.getKind() === SyntaxKind.PropertyAccessExpression) {
          const pa = callee as BunestPropertyAccessExpression;
          if (pa.getExpression().getKind() === SyntaxKind.Identifier) {
            const decl = this.resolveNamespaceMember(
              pa.getExpression().getText(),
              pa.getName(),
              expr.getSourceFile(),
            );
            if (decl && decl.getKind() === SyntaxKind.ClassDeclaration) {
              const cls = decl as BunestClassDeclaration;
              const clsName = cls.getName() ?? pa.getName();
              return new BunestType(
                {
                  kind: "classInstance",
                  name: clsName,
                  typeArguments: typeArgs,
                  declaration: cls,
                  symbol: new BunestSymbol({
                    name: clsName,
                    declarations: [cls],
                    valueDeclaration: cls,
                    resolver: this,
                  }),
                },
                this,
              );
            }
          }
        }
        return this.primitiveType("unknown");
      }
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionExpression: {
        return this.makeCallableType(
          expr as BunestArrowFunction | BunestFunctionExpression,
        );
      }
      case SyntaxKind.CallExpression: {
        const ce = expr as BunestCallExpression;
        const calleeType = this.inferExpressionType(
          ce.getExpression(),
          depth + 1,
        );
        const sig = calleeType.getCallSignatures()[0];
        if (sig) return sig.getReturnType();
        return this.primitiveType("unknown");
      }
      case SyntaxKind.Identifier: {
        const sym = this.resolveIdentifierSymbol(
          expr.getText(),
          expr.getSourceFile(),
          expr,
        );
        const decl =
          sym?.getAliasedSymbol()?.getDeclarations()[0] ??
          sym?.getDeclarations()[0];
        if (!decl) return this.primitiveType("unknown");
        return this.getDeclarationValueType(decl, depth + 1);
      }
      case SyntaxKind.PropertyAccessExpression: {
        const pa = expr as BunestPropertyAccessExpression;
        if (pa.getExpression().getKind() === SyntaxKind.Identifier) {
          const nsDecl = this.resolveNamespaceMember(
            pa.getExpression().getText(),
            pa.getName(),
            expr.getSourceFile(),
          );
          if (nsDecl) {
            return this.getDeclarationValueType(nsDecl, depth + 1);
          }
        }
        const objType = this.inferExpressionType(pa.getExpression(), depth + 1);
        const propSym = objType
          .getProperties()
          .find((p) => p.getName() === pa.getName());
        if (propSym) {
          return propSym.getTypeAtLocation(
            propSym.getValueDeclaration() ?? expr,
          );
        }
        return this.primitiveType("unknown");
      }
      default:
        return this.primitiveType("unknown");
    }
  }

  private getDeclarationValueType(decl: BunestNode, depth = 0): BunestType {
    if (depth > 16) return this.primitiveType("unknown");
    switch (decl.getKind()) {
      case SyntaxKind.ClassDeclaration: {
        const cls = decl as BunestClassDeclaration;
        const clsName = cls.getName() ?? "AnonymousClass";
        const instanceType = new BunestType(
          {
            kind: "classInstance",
            name: clsName,
            declaration: cls,
            symbol: new BunestSymbol({
              name: clsName,
              declarations: [cls],
              valueDeclaration: cls,
              resolver: this,
            }),
          },
          this,
        );
        const ctor = cls.getConstructors()[0];
        const ctorParams = ctor
          ? ctor.getParameters().map(
              (p) =>
                new BunestSymbol({
                  name: p.getName(),
                  declarations: [p],
                  valueDeclaration: p,
                  optional: p.isOptional() || p.hasInitializer(),
                  resolver: this,
                }),
            )
          : [];
        return new BunestType(
          {
            kind: "classCtor",
            name: clsName,
            declaration: cls,
            constructSignatures: [new BunestSignature(ctorParams, instanceType)],
          },
          this,
        );
      }
      case SyntaxKind.FunctionDeclaration:
        return this.makeCallableType(decl as BunestFunctionDeclaration);
      case SyntaxKind.VariableDeclaration: {
        const vd = decl as BunestVariableDeclaration;
        if (vd.getTypeNode()) {
          return this.resolveTypeNode(vd.getTypeNode()!, depth + 1);
        }
        if (vd.getInitializer()) {
          return this.inferExpressionType(vd.getInitializer()!, depth + 1);
        }
        return this.primitiveType("any");
      }
      case SyntaxKind.Parameter:
        return this.getParameterType(decl as BunestParameterDeclaration);
      case SyntaxKind.PropertyDeclaration:
        return this.getPropertyType(decl as BunestPropertyDeclaration);
      case SyntaxKind.MethodDeclaration:
        return this.makeCallableType(decl as BunestMethodDeclaration);
      default:
        return this.primitiveType("unknown");
    }
  }

  // ─── Node Type Helpers ───────────────────────────────────────────────────

  getPropertyType(prop: BunestPropertyDeclaration): BunestType {
    let base: BunestType;
    const typeNode = prop.getTypeNode();
    if (typeNode) {
      base = this.resolveTypeNode(typeNode);
    } else if (prop.getInitializer()) {
      base = this.inferExpressionType(prop.getInitializer()!);
    } else {
      base = this.primitiveType("any");
    }
    if (prop.hasQuestionToken() && !base.isNullable()) {
      return new BunestType(
        { kind: "union", members: [base, this.primitiveType("undefined")] },
        this,
      );
    }
    return base;
  }

  getParameterType(param: BunestParameterDeclaration): BunestType {
    let base: BunestType;
    const typeNode = param.getTypeNode();
    if (typeNode) {
      base = this.resolveTypeNode(typeNode);
    } else if (param.getInitializer()) {
      base = this.inferExpressionType(param.getInitializer()!);
    } else {
      base = this.primitiveType("any");
    }
    if ((param.isOptional() || param.hasInitializer()) && !base.isNullable()) {
      return new BunestType(
        { kind: "union", members: [base, this.primitiveType("undefined")] },
        this,
      );
    }
    return base;
  }

  getMethodReturnType(
    fn:
      | BunestMethodDeclaration
      | BunestFunctionDeclaration
      | BunestArrowFunction
      | BunestFunctionExpression,
  ): BunestType {
    const retNode = fn.getReturnTypeNode();
    if (retNode) {
      return this.resolveTypeNode(retNode);
    }
    const body = fn.getBody();
    const isAsync = fn.isAsync();
    let inferred: BunestType;
    if (!body) {
      inferred = this.primitiveType("void");
    } else if (body.getKind() !== SyntaxKind.Block) {
      // Concise arrow function body: `() => expr`
      inferred = this.inferExpressionType(body);
    } else {
      const returnTypes: BunestType[] = [];
      this.collectReturnExpressionTypes(body, returnTypes);
      if (returnTypes.length === 0) {
        inferred = this.primitiveType("void");
      } else {
        const unique = this.deduplicateUnion(returnTypes);
        inferred =
          unique.length === 1
            ? unique[0]!
            : new BunestType({ kind: "union", members: unique }, this);
      }
    }
    if (isAsync && inferred.getSymbol()?.getName() !== "Promise") {
      return new BunestType(
        { kind: "reference", name: "Promise", typeArguments: [inferred] },
        this,
      );
    }
    return inferred;
  }

  private collectReturnExpressionTypes(
    node: BunestNode,
    out: BunestType[],
  ): void {
    const k = node.getKind();
    // Do not descend into nested functions/classes
    if (
      k === SyntaxKind.ArrowFunction ||
      k === SyntaxKind.FunctionExpression ||
      k === SyntaxKind.FunctionDeclaration ||
      k === SyntaxKind.ClassDeclaration ||
      k === SyntaxKind.ClassExpression
    ) {
      return;
    }
    if (k === SyntaxKind.ReturnStatement) {
      const expr = (node as BunestReturnStatement).getExpression();
      if (expr) {
        out.push(this.inferExpressionType(expr));
      } else {
        out.push(this.primitiveType("void"));
      }
      return;
    }
    for (const child of node.getChildren()) {
      this.collectReturnExpressionTypes(child, out);
    }
  }

  getNodeType(node: BunestNode): BunestType {
    const k = node.getKind();
    if (k === SyntaxKind.PropertyDeclaration) {
      return this.getPropertyType(node as BunestPropertyDeclaration);
    }
    if (k === SyntaxKind.Parameter) {
      return this.getParameterType(node as BunestParameterDeclaration);
    }
    if (k === SyntaxKind.MethodDeclaration) {
      return this.makeCallableType(node as BunestMethodDeclaration);
    }
    if (k === SyntaxKind.PropertySignature) {
      const tn = (node as BunestPropertySignature).getTypeNode();
      return tn ? this.resolveTypeNode(tn) : this.primitiveType("any");
    }
    if (k === SyntaxKind.MethodSignature) {
      const ms = node as BunestMethodSignature;
      return this.makeSignatureCallableType(
        ms.getParameters(),
        ms.getReturnTypeNode()
          ? this.resolveTypeNode(ms.getReturnTypeNode()!)
          : this.primitiveType("any"),
      );
    }
    if (
      k >= SyntaxKind.TypeReference ||
      (k >= SyntaxKind.VoidKeyword && k <= SyntaxKind.ObjectKeyword) ||
      k === SyntaxKind.NullKeyword ||
      k === SyntaxKind.UndefinedKeyword
    ) {
      return this.resolveTypeNode(node);
    }
    return this.inferExpressionType(node);
  }

  private deduplicateUnion(types: readonly BunestType[]): BunestType[] {
    const seen = new Set<string>();
    const out: BunestType[] = [];
    for (const t of types) {
      const key = t.getText();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(t);
      }
    }
    return out;
  }
}
