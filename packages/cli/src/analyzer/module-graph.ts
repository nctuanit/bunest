import { cond } from "@bunest/core/common";
import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type SourceFile,
} from "../ast";
import { nodeToLocation } from "../typegen/scanner";
import type { SourceLocation } from "../typegen/types";

export type ProviderScope = "SINGLETON" | "REQUEST" | "TRANSIENT";

export type ErasedTypeKind = "interface" | "type-alias";

export type InjectTokenKind =
  | "string"
  | "identifier"
  | "member-access"
  | "call"
  | "decorator-shorthand";

export type UnknownRegistrationKind =
  | "dynamic-module"
  | "dynamic-provider"
  | "computed-route"
  | "runtime-only"
  | "auto-discover";

export interface UnknownRegistrationEntry {
  readonly kind: UnknownRegistrationKind;
  readonly reason: string;
  readonly moduleName?: string;
  readonly location?: SourceLocation;
}

export interface ConstructorDependencyInfo {
  readonly paramName: string;
  readonly typeName: string;
  readonly token?: string;
  readonly injectDecorator?: string;
  readonly tokenKind?: InjectTokenKind;
  readonly erasedTypeKind?: ErasedTypeKind;
  readonly isOptional: boolean;
  readonly isForwardRef: boolean;
  readonly isTypeOnlyImport: boolean;
  readonly importDeclarationLocation?: SourceLocation;
  readonly location: SourceLocation;
}

export interface StaticProviderNode {
  readonly name: string;
  readonly kind: "provider" | "controller" | "repository";
  readonly scope: ProviderScope;
  readonly isAbstract?: boolean;
  readonly sourceFile: string;
  readonly location: SourceLocation;
  readonly dependencies: readonly ConstructorDependencyInfo[];
}

export interface StaticModuleExportItem {
  readonly name: string;
  readonly location: SourceLocation;
}

export interface StaticModuleNode {
  readonly name: string;
  readonly sourceFile: string;
  readonly location: SourceLocation;
  readonly decoratorLocation: SourceLocation;
  readonly exportsLocation?: SourceLocation;
  readonly importsLocation?: SourceLocation;
  readonly providersLocation?: SourceLocation;
  readonly controllersLocation?: SourceLocation;
  readonly isGlobal: boolean;
  readonly isAutoModule?: boolean;
  readonly autoDiscover: boolean;
  readonly imports: readonly string[];
  readonly forwardRefImports?: readonly string[];
  readonly controllers: readonly string[];
  readonly providers: readonly string[];
  readonly exports: readonly string[];
  readonly exportItems?: readonly StaticModuleExportItem[];
  readonly hasDynamicProviders?: boolean;
  readonly hasUnresolvedImportSpread?: boolean;
  readonly hasExternalDynamicImports?: boolean;
}

export interface StaticModuleGraph {
  readonly modules: readonly StaticModuleNode[];
  readonly providers: readonly StaticProviderNode[];
  readonly providerByName: ReadonlyMap<string, StaticProviderNode>;
  readonly providersByName: ReadonlyMap<string, readonly StaticProviderNode[]>;
  readonly moduleByName: ReadonlyMap<string, StaticModuleNode>;
  readonly cycles: readonly (readonly string[])[];
  readonly moduleCycles: readonly (readonly string[])[];
  readonly stringTokenConstants?: ReadonlyMap<string, string>;
  readonly unknownRegistrations: readonly UnknownRegistrationEntry[];
}

function getDecoratorShortName(dec: Decorator): string {
  const n = dec.getName();
  const i = n.lastIndexOf(".");
  return i !== -1 ? n.slice(i + 1) : n;
}

function getObjectProp(
  expr: Expression | undefined,
  propName: string,
): Expression | undefined {
  if (!expr || !Node.isObjectLiteralExpression(expr)) return undefined;
  const p = expr.getProperty(propName);
  if (p && Node.isPropertyAssignment(p)) return p.getInitializer();
  if (p && Node.isShorthandPropertyAssignment(p)) return p.getNameNode();
  return undefined;
}

function getObjectPropLocation(
  expr: Expression | undefined,
  propName: string,
): SourceLocation | undefined {
  if (!expr || !Node.isObjectLiteralExpression(expr)) return undefined;
  const p = expr.getProperty(propName);
  return p ? nodeToLocation(p) : undefined;
}

interface ExtractedModuleRefsResult {
  readonly refs: string[];
  readonly forwardRefs: string[];
  readonly items: StaticModuleExportItem[];
  readonly hasDynamicSpreadOrComputed: boolean;
  readonly hasDynamicModuleCall: boolean;
}

function unwrapParensExpr(expr: Expression | undefined): Expression | undefined {
  let cur = expr;
  while (cur && Node.isParenthesizedExpression(cur)) {
    cur = cur.getExpression();
  }
  return cur;
}

function extractForwardRefTarget(arg0: Expression | undefined): string | undefined {
  const fn = unwrapParensExpr(arg0);
  if (!fn) return undefined;
  if (Node.isArrowFunction(fn)) {
    const body = unwrapParensExpr(fn.getBody());
    if (body && Node.isIdentifier(body)) {
      return body.getText();
    }
  }
  return undefined;
}

function extractModuleClassRefsDetailed(
  expr: Expression | undefined,
  moduleName: string,
  arrayKind: "imports" | "controllers" | "providers" | "exports",
  unknowns: UnknownRegistrationEntry[],
): ExtractedModuleRefsResult {
  if (!expr) {
    return {
      refs: [],
      forwardRefs: [],
      items: [],
      hasDynamicSpreadOrComputed: false,
      hasDynamicModuleCall: false,
    };
  }
  const fallbackKind: UnknownRegistrationKind =
    arrayKind === "imports" ? "dynamic-module" : "dynamic-provider";

  if (!Node.isArrayLiteralExpression(expr)) {
    unknowns.push({
      kind: fallbackKind,
      reason: `Computed "${arrayKind}" expression "${expr.getText()}" in ${moduleName} cannot be resolved statically.`,
      moduleName,
      location: nodeToLocation(expr),
    });
    return {
      refs: [],
      forwardRefs: [],
      items: [],
      hasDynamicSpreadOrComputed: true,
      hasDynamicModuleCall: false,
    };
  }
  const out: string[] = [];
  const forwardRefs: string[] = [];
  const items: StaticModuleExportItem[] = [];
  let hasDynamicSpreadOrComputed = false;
  let hasDynamicModuleCall = false;

  const pushRef = (name: string, node: Expression): void => {
    out.push(name);
    items.push({ name, location: nodeToLocation(node) });
  };

  for (const el of expr.getElements()) {
    if (Node.isIdentifier(el)) {
      pushRef(el.getText(), el);
    } else if (Node.isPropertyAccessExpression(el)) {
      pushRef(el.getText(), el);
    } else if (Node.isCallExpression(el)) {
      const callee = el.getExpression();
      if (Node.isPropertyAccessExpression(callee)) {
        const base = callee.getExpression().getText();
        const method = callee.getName();
        pushRef(base, el);
        hasDynamicModuleCall = true;
        // Handle `OrmModule.forFeature([UserEntity, UserRepo])`
        if (method === "forFeature" || method === "forFeatureAsync") {
          const arg0 = el.getArguments()[0];
          if (arg0 && Node.isArrayLiteralExpression(arg0)) {
            for (const sub of arg0.getElements()) {
              if (Node.isIdentifier(sub)) {
                pushRef(sub.getText(), sub);
              } else {
                unknowns.push({
                  kind: "dynamic-module",
                  reason: `Dynamic element "${sub.getText()}" inside ${base}.${method}(...) in ${moduleName} cannot be resolved statically.`,
                  moduleName,
                  location: nodeToLocation(sub),
                });
              }
            }
          }
          if (method === "forFeatureAsync") {
            unknowns.push({
              kind: "dynamic-module",
              reason: `Async dynamic module registration "${el.getText()}" in ${moduleName} cannot be fully resolved statically.`,
              moduleName,
              location: nodeToLocation(el),
            });
          }
        } else if (
          method === "forRoot" ||
          method === "forRootAsync" ||
          method.startsWith("register")
        ) {
          unknowns.push({
            kind: "dynamic-module",
            reason: `Dynamic module registration "${el.getText()}" in ${moduleName} cannot be fully resolved statically.`,
            moduleName,
            location: nodeToLocation(el),
          });
        } else {
          unknowns.push({
            kind: fallbackKind,
            reason: `Dynamic registration call "${el.getText()}" in ${moduleName}.${arrayKind} cannot be resolved statically.`,
            moduleName,
            location: nodeToLocation(el),
          });
        }
      } else if (callee.getText() === "forwardRef") {
        const target = extractForwardRefTarget(el.getArguments()[0]);
        if (target) {
          pushRef(target, el);
          forwardRefs.push(target);
        } else {
          unknowns.push({
            kind: fallbackKind,
            reason: `Non-identifier forwardRef target "${el.getText()}" in ${moduleName}.${arrayKind} cannot be resolved statically.`,
            moduleName,
            location: nodeToLocation(el),
          });
        }
      } else {
        hasDynamicSpreadOrComputed = true;
        unknowns.push({
          kind: fallbackKind,
          reason: `Computed registration call "${el.getText()}" in ${moduleName}.${arrayKind} cannot be resolved statically.`,
          moduleName,
          location: nodeToLocation(el),
        });
      }
    } else if (Node.isObjectLiteralExpression(el)) {
      const provide = getObjectProp(el, "provide");
      if (provide) {
        if (Node.isIdentifier(provide)) {
          pushRef(provide.getText(), provide);
        } else if (
          Node.isStringLiteral(provide) ||
          Node.isNoSubstitutionTemplateLiteral(provide)
        ) {
          pushRef(provide.getLiteralValue(), provide);
        } else if (Node.isPropertyAccessExpression(provide)) {
          pushRef(provide.getText(), provide);
        } else {
          hasDynamicSpreadOrComputed = true;
          unknowns.push({
            kind: "dynamic-provider",
            reason: `Computed provider token "${provide.getText()}" in ${moduleName}.${arrayKind} cannot be resolved statically.`,
            moduleName,
            location: nodeToLocation(provide),
          });
        }
      } else {
        hasDynamicSpreadOrComputed = true;
        unknowns.push({
          kind: "dynamic-provider",
          reason: `Provider object "${el.getText()}" in ${moduleName}.${arrayKind} has no static "provide" token.`,
          moduleName,
          location: nodeToLocation(el),
        });
      }
      const useClass = getObjectProp(el, "useClass");
      if (useClass && Node.isIdentifier(useClass)) {
        out.push(useClass.getText());
      }
    } else if (
      el.getKind() === SyntaxKind.SpreadElement ||
      el.getText().trim().startsWith("...")
    ) {
      hasDynamicSpreadOrComputed = true;
      unknowns.push({
        kind: fallbackKind,
        reason: `Spread registration "${el.getText()}" in ${moduleName}.${arrayKind} cannot be resolved statically.`,
        moduleName,
        location: nodeToLocation(el),
      });
    } else if (
      Node.isStringLiteral(el) ||
      Node.isNoSubstitutionTemplateLiteral(el)
    ) {
      pushRef(el.getLiteralValue(), el);
    } else {
      hasDynamicSpreadOrComputed = true;
      unknowns.push({
        kind: fallbackKind,
        reason: `Computed expression "${el.getText()}" in ${moduleName}.${arrayKind} cannot be resolved statically.`,
        moduleName,
        location: nodeToLocation(el),
      });
    }
  }
  return {
    refs: out,
    forwardRefs,
    items,
    hasDynamicSpreadOrComputed,
    hasDynamicModuleCall,
  };
}

function extractInjectableScope(cls: ClassDeclaration): ProviderScope {
  for (const dec of cls.getDecorators()) {
    const short = getDecoratorShortName(dec);
    if (short !== "Injectable" && short !== "Controller") continue;
    const arg0 = dec.getArguments()[0] as Expression | undefined;
    const scopeExpr = getObjectProp(arg0, "scope");
    if (!scopeExpr) continue;
    const txt = scopeExpr.getText();
    if (txt.includes("REQUEST") || txt === "1") return "REQUEST";
    if (txt.includes("TRANSIENT") || txt === "2") return "TRANSIENT";
    return "SINGLETON";
  }
  return "SINGLETON";
}

function collectTypeOnlyImports(
  sf: SourceFile,
): Map<string, SourceLocation> {
  const map = new Map<string, SourceLocation>();
  for (const imp of sf.getImportDeclarations()) {
    const isWholeTypeOnly = imp.isTypeOnly();
    const loc = nodeToLocation(imp);
    for (const named of imp.getNamedImports()) {
      if (isWholeTypeOnly || named.isTypeOnly()) {
        const localName = named.getAliasNode()?.getText() ?? named.getName();
        map.set(localName, loc);
      }
    }
    const defaultImp = imp.getDefaultImport();
    if (defaultImp && isWholeTypeOnly) {
      map.set(defaultImp.getText(), loc);
    }
  }
  return map;
}

interface FileSymbolKindTable {
  readonly values: Set<string>;
  readonly interfaces: Set<string>;
  readonly typeAliases: Set<string>;
}

function collectFileSymbolKinds(sf: SourceFile): FileSymbolKindTable {
  const values = new Set<string>();
  const interfaces = new Set<string>();
  const typeAliases = new Set<string>();

  for (const cls of sf.getClasses()) {
    const n = cls.getName();
    if (n) values.add(n);
  }
  for (const en of sf.getEnums()) {
    const n = en.getName();
    if (n) values.add(n);
  }
  for (const fn of sf.getFunctions()) {
    const n = fn.getName();
    if (n) values.add(n);
  }
  for (const v of sf.getVariableDeclarations()) {
    values.add(v.getName());
  }
  for (const iface of sf.getInterfaces()) {
    const n = iface.getName();
    if (n) interfaces.add(n);
  }
  for (const ta of sf.getTypeAliases()) {
    const n = ta.getName();
    if (n) typeAliases.add(n);
  }

  return { values, interfaces, typeAliases };
}

function resolveErasedTypeKindForName(
  baseTypeName: string,
  sf: SourceFile,
  fileTables: ReadonlyMap<string, FileSymbolKindTable>,
): ErasedTypeKind | undefined {
  if (!/^[A-Za-z_$][\w$]*$/.test(baseTypeName)) return undefined;

  const local = fileTables.get(sf.getFilePath());
  if (local) {
    // Declaration merging: if a runtime value of the same name exists in scope, it is NOT erased
    if (local.values.has(baseTypeName)) return undefined;
    if (local.interfaces.has(baseTypeName)) return "interface";
    if (local.typeAliases.has(baseTypeName)) return "type-alias";
  }

  // Resolve imported symbol across workspace files
  const resolver = sf.getResolver();
  const sym = resolver.resolveIdentifierSymbol(baseTypeName, sf);
  const targetSym = sym?.getAliasedSymbol() ?? sym;
  if (targetSym) {
    const decls = targetSym.getDeclarations();
    if (decls.length > 0) {
      let hasRuntimeValue = false;
      let hasInterface = false;
      let hasTypeAlias = false;
      for (const decl of decls) {
        if (
          Node.isClassDeclaration(decl) ||
          Node.isEnumDeclaration(decl) ||
          Node.isVariableDeclaration(decl) ||
          Node.isFunctionDeclaration(decl)
        ) {
          hasRuntimeValue = true;
        } else if (Node.isInterfaceDeclaration(decl)) {
          hasInterface = true;
        } else if (Node.isTypeAliasDeclaration(decl)) {
          hasTypeAlias = true;
        }
      }
      if (hasRuntimeValue) return undefined;
      if (hasInterface) return "interface";
      if (hasTypeAlias) return "type-alias";
    }
  }

  // Fallback: inspect import declarations explicitly (handles type-only imports from sibling files)
  for (const imp of sf.getImportDeclarations()) {
    const named = imp
      .getNamedImports()
      .find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === baseTypeName);
    if (!named) continue;
    const origName = named.getName();
    const targetSf = resolver.resolveModuleSourceFile(
      sf.getFilePath(),
      imp.getModuleSpecifierValue(),
    );
    if (!targetSf) continue;
    const targetTable = fileTables.get(targetSf.getFilePath());
    if (!targetTable) continue;
    if (targetTable.values.has(origName)) return undefined;
    if (targetTable.interfaces.has(origName)) return "interface";
    if (targetTable.typeAliases.has(origName)) return "type-alias";
  }

  return undefined;
}

function extractConstructorDeps(
  cls: ClassDeclaration,
  sf: SourceFile,
  typeOnlyImports: ReadonlyMap<string, SourceLocation>,
  fileTables: ReadonlyMap<string, FileSymbolKindTable>,
): ConstructorDependencyInfo[] {
  const ctor = cls.getConstructors()[0];
  if (!ctor) return [];

  const deps: ConstructorDependencyInfo[] = [];
  for (const param of ctor.getParameters()) {
    const decs = param.getDecorators();
    let token: string | undefined;
    let injectDecorator: string | undefined;
    let tokenKind: InjectTokenKind | undefined;
    let isOptional = param.isOptional() || param.hasInitializer();
    let isForwardRef = false;

    for (const dec of decs) {
      const short = getDecoratorShortName(dec);
      if (short === "Optional") {
        isOptional = true;
      } else if (
        short === "Inject" ||
        short === "ConfigValue" ||
        short.startsWith("Inject")
      ) {
        injectDecorator = short;
        const arg0 = dec.getArguments()[0];
        if (arg0) {
          if (
            Node.isStringLiteral(arg0) ||
            Node.isNoSubstitutionTemplateLiteral(arg0)
          ) {
            token = arg0.getLiteralValue();
            tokenKind = short === "Inject" ? "string" : "decorator-shorthand";
          } else if (
            Node.isCallExpression(arg0) &&
            arg0.getExpression().getText() === "forwardRef"
          ) {
            isForwardRef = true;
            const target = extractForwardRefTarget(arg0.getArguments()[0]);
            if (target) {
              token = target;
              tokenKind = "identifier";
            }
          } else if (Node.isCallExpression(arg0)) {
            token = arg0.getText();
            tokenKind = "call";
          } else if (Node.isPropertyAccessExpression(arg0)) {
            token = arg0.getText();
            tokenKind =
              short === "Inject" ? "member-access" : "decorator-shorthand";
          } else if (Node.isIdentifier(arg0)) {
            token = arg0.getText();
            tokenKind =
              short === "Inject" ? "identifier" : "decorator-shorthand";
          } else {
            token = arg0.getText();
            tokenKind = "call";
          }
        } else {
          token = `@${short}`;
          tokenKind = "decorator-shorthand";
        }
      }
    }

    const typeNode = param.getTypeNode();
    const rawTypeText = typeNode?.getText().trim() ?? "";
    // Strip generics & union with undefined/null to get base class identifier
    const baseTypeName = rawTypeText
      .replace(/\s*\|\s*(?:undefined|null)/g, "")
      .replace(/<.*>$/, "")
      .trim();

    if (!baseTypeName && !token) continue;

    const effectiveTypeName = baseTypeName || "unknown";
    const typeOnlyLoc = typeOnlyImports.get(effectiveTypeName);
    const erasedTypeKind = resolveErasedTypeKindForName(
      effectiveTypeName,
      sf,
      fileTables,
    );

    deps.push({
      paramName: param.getName(),
      typeName: effectiveTypeName,
      token,
      ...(injectDecorator ? { injectDecorator } : {}),
      ...(tokenKind ? { tokenKind } : {}),
      ...(erasedTypeKind ? { erasedTypeKind } : {}),
      isOptional,
      isForwardRef,
      isTypeOnlyImport: Boolean(typeOnlyLoc),
      importDeclarationLocation: typeOnlyLoc,
      location: nodeToLocation(param.getNameNode()),
    });
  }

  return deps;
}

function detectModuleCycles(modules: readonly StaticModuleNode[]): string[][] {
  const byName = new Map<string, StaticModuleNode>();
  for (const m of modules) byName.set(m.name, m);

  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];
  const cycles: string[][] = [];
  const seenKeys = new Set<string>();

  const dfs = (name: string): void => {
    visited.add(name);
    stack.add(name);
    path.push(name);

    const node = byName.get(name);
    if (node) {
      const fwdSet = new Set(node.forwardRefImports ?? []);
      for (const imp of node.imports) {
        if (fwdSet.has(imp)) continue;
        if (!byName.has(imp)) continue;
        if (stack.has(imp)) {
          const idx = path.indexOf(imp);
          const cycle = [...path.slice(idx), imp];
          const canonical = [...cycle.slice(0, -1)].sort().join("->");
          if (!seenKeys.has(canonical)) {
            seenKeys.add(canonical);
            cycles.push(cycle);
          }
        } else if (!visited.has(imp)) {
          dfs(imp);
        }
      }
    }

    path.pop();
    stack.delete(name);
  };

  for (const m of modules) {
    if (!visited.has(m.name)) dfs(m.name);
  }
  return cycles;
}

function detectProviderCycles(
  providers: readonly StaticProviderNode[],
): string[][] {
  const byName = new Map<string, StaticProviderNode>();
  for (const p of providers) byName.set(p.name, p);

  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];
  const cycles: string[][] = [];
  const seenKeys = new Set<string>();

  const dfs = (name: string): void => {
    visited.add(name);
    stack.add(name);
    path.push(name);

    const node = byName.get(name);
    if (node) {
      for (const dep of node.dependencies) {
        if (dep.isForwardRef) continue;
        const target = dep.typeName;
        if (!byName.has(target)) continue;
        if (stack.has(target)) {
          const idx = path.indexOf(target);
          const cycle = [...path.slice(idx), target];
          const canonical = [...cycle.slice(0, -1)].sort().join("->");
          if (!seenKeys.has(canonical)) {
            seenKeys.add(canonical);
            cycles.push(cycle);
          }
        } else if (!visited.has(target)) {
          dfs(target);
        }
      }
    }

    path.pop();
    stack.delete(name);
  };

  for (const p of providers) {
    if (!visited.has(p.name)) dfs(p.name);
  }
  return cycles;
}

/**
 * Extracts a static `@Module` / `@AutoModule` / `@Injectable` / `@Controller` / Repository
 * dependency graph across the workspace without executing user code.
 */
export function buildStaticModuleGraph(
  sourceFiles: readonly SourceFile[],
): StaticModuleGraph {
  const modules: StaticModuleNode[] = [];
  const providers: StaticProviderNode[] = [];
  const providerByName = new Map<string, StaticProviderNode>();
  const providersByNameMutable = new Map<string, StaticProviderNode[]>();
  const moduleByName = new Map<string, StaticModuleNode>();
  const unknownRegistrations: UnknownRegistrationEntry[] = [];
  const fileTables = new Map<string, FileSymbolKindTable>();
  const stringTokenConstants = new Map<string, string>();

  // Pre-pass: collect per-file symbol tables (classes/values vs interfaces/type aliases)
  // and top-level `const TOKEN = "literal"` aliases for accurate BUNEST008/009/011 checks.
  for (const sf of sourceFiles) {
    fileTables.set(sf.getFilePath(), collectFileSymbolKinds(sf));
    for (const v of sf.getVariableDeclarations()) {
      const init = unwrapParensExpr(v.getInitializer());
      if (
        init &&
        (Node.isStringLiteral(init) ||
          Node.isNoSubstitutionTemplateLiteral(init))
      ) {
        stringTokenConstants.set(v.getName(), init.getLiteralValue());
      }
    }
  }

  for (const sf of sourceFiles) {
    const typeOnlyImports = collectTypeOnlyImports(sf);
    const filePath = sf.getFilePath();

    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (!name) continue;
      const decs = cls.getDecorators();
      const decNames = new Set(decs.map(getDecoratorShortName));

      const modDec = decs.find((d) => {
        const s = getDecoratorShortName(d);
        return s === "Module" || s === "AutoModule";
      });
      if (modDec) {
        const isAuto = getDecoratorShortName(modDec) === "AutoModule";
        const arg0 = modDec.getArguments()[0] as Expression | undefined;
        let hasComputedMeta = false;
        if (arg0 && !Node.isObjectLiteralExpression(arg0)) {
          hasComputedMeta = true;
          unknownRegistrations.push({
            kind: "dynamic-module",
            reason: `Computed @${getDecoratorShortName(modDec)}(${arg0.getText()}) metadata on ${name} cannot be resolved statically.`,
            moduleName: name,
            location: nodeToLocation(arg0),
          });
        }
        const autoProp = getObjectProp(arg0, "autoDiscover");
        const autoDiscover =
          isAuto ||
          (autoProp !== undefined &&
            autoProp.getKind() !== SyntaxKind.FalseKeyword);

        if (autoDiscover) {
          unknownRegistrations.push({
            kind: "auto-discover",
            reason: `Module "${name}" uses autoDiscover; provider visibility may include auto-discovered classes.`,
            moduleName: name,
            location: nodeToLocation(modDec),
          });
        }

        const importsRes = extractModuleClassRefsDetailed(
          getObjectProp(arg0, "imports"),
          name,
          "imports",
          unknownRegistrations,
        );
        const controllersRes = extractModuleClassRefsDetailed(
          getObjectProp(arg0, "controllers"),
          name,
          "controllers",
          unknownRegistrations,
        );
        const providersRes = extractModuleClassRefsDetailed(
          getObjectProp(arg0, "providers"),
          name,
          "providers",
          unknownRegistrations,
        );
        const exportsRes = extractModuleClassRefsDetailed(
          getObjectProp(arg0, "exports"),
          name,
          "exports",
          unknownRegistrations,
        );

        const modNode: StaticModuleNode = {
          name,
          sourceFile: filePath,
          location: nodeToLocation(cls.getNameNode() ?? cls),
          decoratorLocation: nodeToLocation(modDec),
          exportsLocation: getObjectPropLocation(arg0, "exports"),
          importsLocation: getObjectPropLocation(arg0, "imports"),
          providersLocation: getObjectPropLocation(arg0, "providers"),
          controllersLocation: getObjectPropLocation(arg0, "controllers"),
          isGlobal: decNames.has("Global"),
          isAutoModule: isAuto,
          autoDiscover,
          imports: importsRes.refs,
          ...(importsRes.forwardRefs.length > 0
            ? { forwardRefImports: importsRes.forwardRefs }
            : {}),
          controllers: controllersRes.refs,
          providers: providersRes.refs,
          exports: exportsRes.refs,
          exportItems: exportsRes.items,
          hasDynamicProviders:
            hasComputedMeta || providersRes.hasDynamicSpreadOrComputed,
          hasUnresolvedImportSpread:
            hasComputedMeta || importsRes.hasDynamicSpreadOrComputed,
          hasExternalDynamicImports: importsRes.hasDynamicModuleCall,
        };
        modules.push(modNode);
        moduleByName.set(name, modNode);
      }

      const isController = decNames.has("Controller");
      const isRepository = decNames.has("Repository");
      const isInjectable =
        decNames.has("Injectable") ||
        decNames.has("CommandHandler") ||
        decNames.has("QueryHandler");

      if (isController || isRepository || isInjectable) {
        const provNode: StaticProviderNode = {
          name,
          kind: cond<"controller" | "repository", "provider">(
            [
              [isController, "controller"],
              [isRepository, "repository"],
            ],
            "provider",
          ),
          scope: extractInjectableScope(cls),
          ...(cls.isAbstract() ? { isAbstract: true } : {}),
          sourceFile: filePath,
          location: nodeToLocation(cls.getNameNode() ?? cls),
          dependencies: extractConstructorDeps(
            cls,
            sf,
            typeOnlyImports,
            fileTables,
          ),
        };
        providers.push(provNode);
        providerByName.set(name, provNode);
        const list = providersByNameMutable.get(name) ?? [];
        list.push(provNode);
        providersByNameMutable.set(name, list);
      }
    }
  }

  return {
    modules,
    providers,
    providerByName,
    providersByName: providersByNameMutable,
    moduleByName,
    cycles: detectProviderCycles(providers),
    moduleCycles: detectModuleCycles(modules),
    stringTokenConstants,
    unknownRegistrations,
  };
}
