import {
  BunestFunctionExpression,
  BunestReturnStatement,
  Node,
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type MethodDeclaration,
  type PropertyDeclaration,
} from "../ast";
import { BUILTIN_DECORATOR_SPECS } from "./builtin-specs";

export interface ResolvedDecoratorEntry {
  /** Short decorator name (e.g. `"BaseEntity"`, `"Data"`, `"SoftDelete"`). */
  readonly name: string;
  /** Full decorator name (e.g. `"Builder.Default"` or `"Data"`). */
  readonly fullName: string;
  /** The decorator node attached to the class/member (used for locations and attribution). */
  readonly sourceDecorator: Decorator;
  /** Wrapper decorator name if statically expanded from `applyDecorators(...)`. */
  readonly composedFrom?: string;
  /** The call expression for this decorator (either direct or inside `applyDecorators(...)`). */
  readonly callExpression?: CallExpression;
  /** Resolved argument expressions (with forwarded wrapper parameters substituted). */
  readonly resolvedArgs: readonly Expression[];
  /** Resolved type argument texts (with forwarded generic type params substituted). */
  readonly resolvedTypeArgTexts: readonly string[];
  /** Resolved type argument AST nodes (when directly available). */
  readonly resolvedTypeArgNodes: readonly Node[];
}

function getDecoratorNames(dec: Decorator): {
  readonly fullName: string;
  readonly shortName: string;
} {
  const fullName = dec.getName();
  const dot = fullName.lastIndexOf(".");
  return {
    fullName,
    shortName: dot !== -1 ? fullName.slice(dot + 1) : fullName,
  };
}

function getCallCalleeNames(call: CallExpression): {
  readonly fullName: string;
  readonly shortName: string;
} {
  const expr = call.getExpression();
  const fullName = expr.getText().trim();
  const dot = fullName.lastIndexOf(".");
  return {
    fullName,
    shortName: dot !== -1 ? fullName.slice(dot + 1) : fullName,
  };
}

function unwrapExpr(node: Node | undefined): Node | undefined {
  let cur = node;
  while (cur) {
    if (Node.isParenthesizedExpression(cur)) {
      cur = cur.getExpression();
    } else if (Node.isAsExpression(cur)) {
      cur = cur.getExpression();
    } else if (Node.isSatisfiesExpression(cur)) {
      cur = cur.getExpression();
    } else {
      break;
    }
  }
  return cur;
}

interface ParsedTypeParam {
  readonly name: string;
  readonly defaultType?: string;
}

/**
 * Extracts top-level generic type parameter declarations from a function or arrow header,
 * e.g. `export function DomainEntity<Key = number, T extends object>(...)` -> `[{ name: "Key", defaultType: "number" }, { name: "T" }]`.
 */
function parseFunctionTypeParams(fnText: string): ParsedTypeParam[] {
  const parenIdx = fnText.indexOf("(");
  const header = parenIdx !== -1 ? fnText.slice(0, parenIdx) : fnText;
  const ltIdx = header.indexOf("<");
  if (ltIdx === -1) return [];

  let depth = 0;
  let gtIdx = -1;
  for (let i = ltIdx; i < header.length; i++) {
    const ch = header[i]!;
    if (ch === "<") depth++;
    else if (ch === ">") {
      depth--;
      if (depth === 0) {
        gtIdx = i;
        break;
      }
    }
  }
  if (gtIdx === -1) return [];

  const inner = header.slice(ltIdx + 1, gtIdx);
  const parts: string[] = [];
  let cur = "";
  let d = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") d++;
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") d--;
    if (ch === "," && d === 0) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());

  const params: ParsedTypeParam[] = [];
  for (const part of parts) {
    const cleaned = part.replace(/^const\s+/, "").trim();
    const nameMatch = /^([A-Za-z_$][\w$]*)/.exec(cleaned);
    if (!nameMatch) continue;
    const name = nameMatch[1]!;
    // Find top-level `=` (not `=>`)
    let eqIdx = -1;
    let pd = 0;
    for (let i = name.length; i < cleaned.length; i++) {
      const ch = cleaned[i]!;
      if (ch === "<" || ch === "(" || ch === "[" || ch === "{") pd++;
      else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") pd--;
      if (ch === "=" && cleaned[i + 1] !== ">" && pd === 0) {
        eqIdx = i;
        break;
      }
    }
    const defaultType =
      eqIdx !== -1 ? cleaned.slice(eqIdx + 1).trim() || undefined : undefined;
    params.push({ name, ...(defaultType ? { defaultType } : {}) });
  }
  return params;
}

function substituteTypeText(
  rawTypeText: string,
  typeBindings: ReadonlyMap<string, string>,
): string {
  if (typeBindings.size === 0) return rawTypeText;
  const direct = typeBindings.get(rawTypeText.trim());
  if (direct !== undefined) return direct;
  return rawTypeText.replace(/\b[A-Za-z_$][\w$]*\b/g, (ident) =>
    typeBindings.get(ident) ?? ident,
  );
}

function findApplyDecoratorsCall(body: Node | undefined): CallExpression | undefined {
  const unwrapped = unwrapExpr(body);
  if (!unwrapped) return undefined;

  if (Node.isCallExpression(unwrapped)) {
    const { shortName } = getCallCalleeNames(unwrapped);
    if (shortName === "applyDecorators") {
      return unwrapped;
    }
    return undefined;
  }

  // Block body: locate `return applyDecorators(...)`
  const returns = unwrapped.getDescendantsOfKind(SyntaxKind.ReturnStatement);
  for (const ret of returns) {
    if (!(ret instanceof BunestReturnStatement)) continue;
    const retExpr = unwrapExpr(ret.getExpression());
    if (retExpr && Node.isCallExpression(retExpr)) {
      const { shortName } = getCallCalleeNames(retExpr);
      if (shortName === "applyDecorators") {
        return retExpr;
      }
    }
  }
  return undefined;
}

interface ResolvedWrapperDefinition {
  readonly applyCall: CallExpression;
  readonly paramNames: readonly string[];
  readonly typeParams: readonly ParsedTypeParam[];
}

function resolveWrapperDefinitionFromIdentifier(
  identNode: Node | undefined,
): ResolvedWrapperDefinition | undefined {
  if (!identNode || !Node.isIdentifier(identNode)) {
    return undefined;
  }

  const sym = identNode.getSymbol();
  const resolvedDecl =
    sym?.getAliasedSymbol()?.getDeclarations()[0] ?? sym?.getDeclarations()[0];

  let decl: Node | undefined = resolvedDecl;

  // Same-file fallback when symbol resolution doesn't return a value declaration
  if (!decl) {
    const sf = identNode.getSourceFile();
    const name = identNode.getText().trim();
    decl =
      sf.getFunctions().find((f) => f.getName() === name) ??
      sf.getVariableDeclarations().find((v) => v.getName() === name);
  }

  if (!decl) return undefined;

  if (Node.isFunctionDeclaration(decl)) {
    const applyCall = findApplyDecoratorsCall(decl.getBody());
    if (!applyCall) return undefined;
    return {
      applyCall,
      paramNames: decl.getParameters().map((p) => p.getName()),
      typeParams: parseFunctionTypeParams(decl.getText()),
    };
  }

  if (Node.isVariableDeclaration(decl)) {
    const init = unwrapExpr(decl.getInitializer());
    if (!init) return undefined;
    if (Node.isArrowFunction(init) || init instanceof BunestFunctionExpression) {
      const applyCall = findApplyDecoratorsCall(init.getBody());
      if (!applyCall) return undefined;
      return {
        applyCall,
        paramNames: init.getParameters().map((p) => p.getName()),
        typeParams: parseFunctionTypeParams(init.getText()),
      };
    }
    // Direct constant: `export const Audited = applyDecorators(Data(), Builder());`
    if (Node.isCallExpression(init)) {
      const { shortName } = getCallCalleeNames(init);
      if (shortName === "applyDecorators") {
        return {
          applyCall: init,
          paramNames: [],
          typeParams: [],
        };
      }
    }
  }

  return undefined;
}

function expandDecoratorRecursive(
  sourceDecorator: Decorator,
  calleeExpr: Node | undefined,
  callExpr: CallExpression | undefined,
  args: readonly Expression[],
  typeArgTexts: readonly string[],
  typeArgNodes: readonly Node[],
  composedFrom: string | undefined,
  depth: number,
  maxDepth: number,
  visited: Set<string>,
  out: ResolvedDecoratorEntry[],
): void {
  const fullName = calleeExpr ? calleeExpr.getText().trim() : sourceDecorator.getName();
  const dotIdx = fullName.lastIndexOf(".");
  const shortName = dotIdx !== -1 ? fullName.slice(dotIdx + 1) : fullName;

  // Built-in decorators are leaf nodes (never try to expand @Data/@BaseEntity/etc.)
  if (
    depth >= maxDepth ||
    BUILTIN_DECORATOR_SPECS.has(fullName) ||
    BUILTIN_DECORATOR_SPECS.has(shortName)
  ) {
    out.push({
      name: shortName,
      fullName,
      sourceDecorator,
      ...(composedFrom ? { composedFrom } : {}),
      ...(callExpr ? { callExpression: callExpr } : {}),
      resolvedArgs: args,
      resolvedTypeArgTexts: typeArgTexts,
      resolvedTypeArgNodes: typeArgNodes,
    });
    return;
  }

  // Try to resolve `applyDecorators(...)` wrapper definition
  const identNode =
    calleeExpr && Node.isIdentifier(calleeExpr) ? calleeExpr : undefined;
  const wrapper = resolveWrapperDefinitionFromIdentifier(identNode);
  const visitKey = wrapper
    ? `${wrapper.applyCall.getSourceFile().getFilePath()}:${shortName}`
    : undefined;

  if (!wrapper || !visitKey || visited.has(visitKey)) {
    out.push({
      name: shortName,
      fullName,
      sourceDecorator,
      ...(composedFrom ? { composedFrom } : {}),
      ...(callExpr ? { callExpression: callExpr } : {}),
      resolvedArgs: args,
      resolvedTypeArgTexts: typeArgTexts,
      resolvedTypeArgNodes: typeArgNodes,
    });
    return;
  }

  // Keep the wrapper decorator itself so custom macros / presets still see it
  out.push({
    name: shortName,
    fullName,
    sourceDecorator,
    ...(composedFrom ? { composedFrom } : {}),
    ...(callExpr ? { callExpression: callExpr } : {}),
    resolvedArgs: args,
    resolvedTypeArgTexts: typeArgTexts,
    resolvedTypeArgNodes: typeArgNodes,
  });

  visited.add(visitKey);

  // Build formal param -> caller argument expression bindings
  const paramBindings = new Map<string, Expression>();
  for (let i = 0; i < wrapper.paramNames.length; i++) {
    const paramName = wrapper.paramNames[i]!;
    const argExpr = args[i];
    if (argExpr) {
      paramBindings.set(paramName, argExpr);
    }
  }

  // Build generic type param -> caller type argument text/node bindings
  const typeTextBindings = new Map<string, string>();
  const typeNodeBindings = new Map<string, Node>();
  for (let i = 0; i < wrapper.typeParams.length; i++) {
    const tp = wrapper.typeParams[i]!;
    const callerText = typeArgTexts[i];
    const callerNode = typeArgNodes[i];
    if (callerText !== undefined && callerText.length > 0) {
      typeTextBindings.set(tp.name, callerText);
      if (callerNode) {
        typeNodeBindings.set(tp.name, callerNode);
      }
    } else if (tp.defaultType) {
      typeTextBindings.set(tp.name, tp.defaultType);
    }
  }

  const rootWrapperName = composedFrom ?? shortName;
  for (const item of wrapper.applyCall.getArguments()) {
    const unwrappedItem = unwrapExpr(item);
    if (!unwrappedItem) continue;

    if (Node.isCallExpression(unwrappedItem)) {
      const innerCallee = unwrappedItem.getExpression();
      const innerArgs: Expression[] = [];
      for (const rawArg of unwrappedItem.getArguments()) {
        if (!Node.isExpression(rawArg)) continue;
        const uArg = unwrapExpr(rawArg);
        if (uArg && Node.isIdentifier(uArg)) {
          const bound = paramBindings.get(uArg.getText().trim());
          if (bound) {
            innerArgs.push(bound);
            continue;
          }
        }
        innerArgs.push(rawArg);
      }

      const innerTypeNodes: Node[] = [];
      const innerTypeTexts: string[] = [];
      for (const rawTypeNode of unwrappedItem.getTypeArguments()) {
        const rawText = rawTypeNode.getText().trim();
        const boundNode = typeNodeBindings.get(rawText);
        const substText = substituteTypeText(rawText, typeTextBindings);
        innerTypeTexts.push(substText);
        innerTypeNodes.push(boundNode ?? rawTypeNode);
      }

      expandDecoratorRecursive(
        sourceDecorator,
        innerCallee,
        unwrappedItem,
        innerArgs,
        innerTypeTexts,
        innerTypeNodes,
        rootWrapperName,
        depth + 1,
        maxDepth,
        visited,
        out,
      );
    } else if (
      Node.isIdentifier(unwrappedItem) ||
      Node.isPropertyAccessExpression(unwrappedItem)
    ) {
      expandDecoratorRecursive(
        sourceDecorator,
        unwrappedItem,
        undefined,
        [],
        [],
        [],
        rootWrapperName,
        depth + 1,
        maxDepth,
        visited,
        out,
      );
    }
  }

  visited.delete(visitKey);
}

/**
 * Resolves all decorators on a class, method, or property, statically expanding
 * user-defined `applyDecorators(...)` wrapper functions/constants (same-file or
 * imported) up to `maxDepth` levels while forwarding literal arguments and
 * generic type parameters (`@DomainEntity<string>("orders")` -> `@BaseEntity<string>("orders")`).
 */
export function resolveComposedDecorators(
  node: ClassDeclaration | MethodDeclaration | PropertyDeclaration,
  maxDepth = 3,
): ResolvedDecoratorEntry[] {
  const out: ResolvedDecoratorEntry[] = [];
  for (const dec of node.getDecorators()) {
    const callExpr = dec.getCallExpression();
    const calleeExpr = callExpr ? callExpr.getExpression() : dec.getExpression();
    const rawArgs = (dec.getArguments() as Expression[]) ?? [];
    const rawTypeNodes = callExpr?.getTypeArguments() ?? [];
    const rawTypeTexts = rawTypeNodes.map((t) => t.getText().trim());

    const visited = new Set<string>();
    expandDecoratorRecursive(
      dec,
      calleeExpr,
      callExpr,
      rawArgs,
      rawTypeTexts,
      rawTypeNodes,
      undefined,
      0,
      maxDepth,
      visited,
      out,
    );
  }
  return out;
}

/**
 * Convenience helper returning the short names of all direct + statically expanded
 * `applyDecorators(...)` decorators on a class, method, or property.
 */
export function getExpandedDecoratorNames(
  node: ClassDeclaration | MethodDeclaration | PropertyDeclaration,
  maxDepth = 3,
): Set<string> {
  const names = new Set<string>();
  for (const entry of resolveComposedDecorators(node, maxDepth)) {
    names.add(entry.name);
    if (entry.fullName !== entry.name) {
      names.add(entry.fullName);
    }
  }
  return names;
}
