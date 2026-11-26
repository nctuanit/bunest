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

export interface ConstructorDependencyInfo {
  readonly paramName: string;
  readonly typeName: string;
  readonly token?: string;
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
  readonly sourceFile: string;
  readonly location: SourceLocation;
  readonly dependencies: readonly ConstructorDependencyInfo[];
}

export interface StaticModuleNode {
  readonly name: string;
  readonly sourceFile: string;
  readonly location: SourceLocation;
  readonly decoratorLocation: SourceLocation;
  readonly isGlobal: boolean;
  readonly autoDiscover: boolean;
  readonly imports: readonly string[];
  readonly controllers: readonly string[];
  readonly providers: readonly string[];
  readonly exports: readonly string[];
}

export interface StaticModuleGraph {
  readonly modules: readonly StaticModuleNode[];
  readonly providers: readonly StaticProviderNode[];
  readonly providerByName: ReadonlyMap<string, StaticProviderNode>;
  readonly moduleByName: ReadonlyMap<string, StaticModuleNode>;
  readonly cycles: readonly (readonly string[])[];
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

function extractModuleClassRefs(expr: Expression | undefined): string[] {
  if (!expr || !Node.isArrayLiteralExpression(expr)) return [];
  const out: string[] = [];

  for (const el of expr.getElements()) {
    if (Node.isIdentifier(el)) {
      out.push(el.getText());
    } else if (Node.isCallExpression(el)) {
      const callee = el.getExpression();
      if (Node.isPropertyAccessExpression(callee)) {
        const base = callee.getExpression().getText();
        const method = callee.getName();
        out.push(base);
        // Handle `OrmModule.forFeature([UserEntity, UserRepo])`
        if (method === "forFeature" || method === "forFeatureAsync") {
          const arg0 = el.getArguments()[0];
          if (arg0 && Node.isArrayLiteralExpression(arg0)) {
            for (const sub of arg0.getElements()) {
              if (Node.isIdentifier(sub)) {
                out.push(sub.getText());
              }
            }
          }
        }
      } else if (callee.getText() === "forwardRef") {
        const fn = el.getArguments()[0];
        if (fn && Node.isArrowFunction(fn)) {
          const body = fn.getBody();
          if (Node.isIdentifier(body)) out.push(body.getText());
        }
      }
    } else if (Node.isObjectLiteralExpression(el)) {
      const provide = getObjectProp(el, "provide");
      if (provide) {
        if (Node.isIdentifier(provide)) out.push(provide.getText());
        else if (Node.isStringLiteral(provide)) out.push(provide.getLiteralValue());
      }
      const useClass = getObjectProp(el, "useClass");
      if (useClass && Node.isIdentifier(useClass)) {
        out.push(useClass.getText());
      }
    }
  }
  return out;
}

function extractInjectableScope(cls: ClassDeclaration): ProviderScope {
  const dec = cls
    .getDecorators()
    .find((d) => getDecoratorShortName(d) === "Injectable");
  if (!dec) return "SINGLETON";
  const arg0 = dec.getArguments()[0] as Expression | undefined;
  const scopeExpr = getObjectProp(arg0, "scope");
  if (!scopeExpr) return "SINGLETON";
  const txt = scopeExpr.getText();
  if (txt.includes("REQUEST") || txt === "1") return "REQUEST";
  if (txt.includes("TRANSIENT") || txt === "2") return "TRANSIENT";
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

function extractConstructorDeps(
  cls: ClassDeclaration,
  typeOnlyImports: ReadonlyMap<string, SourceLocation>,
): ConstructorDependencyInfo[] {
  const ctor = cls.getConstructors()[0];
  if (!ctor) return [];

  const deps: ConstructorDependencyInfo[] = [];
  for (const param of ctor.getParameters()) {
    const decs = param.getDecorators();
    let token: string | undefined;
    let isOptional = param.isOptional() || param.hasInitializer();
    let isForwardRef = false;

    for (const dec of decs) {
      const short = getDecoratorShortName(dec);
      if (short === "Optional") {
        isOptional = true;
      } else if (
        short === "Inject" ||
        short === "InjectModel" ||
        short === "InjectConnection" ||
        short === "InjectConfig" ||
        short === "InjectDataSource" ||
        short === "InjectEntityManager" ||
        short === "InjectRepository" ||
        short === "InjectOrmMigrations"
      ) {
        const arg0 = dec.getArguments()[0];
        if (arg0) {
          if (Node.isStringLiteral(arg0)) {
            token = arg0.getLiteralValue();
          } else if (Node.isCallExpression(arg0) && arg0.getExpression().getText() === "forwardRef") {
            isForwardRef = true;
            const fn = arg0.getArguments()[0];
            if (fn && Node.isArrowFunction(fn) && Node.isIdentifier(fn.getBody())) {
              token = fn.getBody().getText();
            }
          } else {
            token = arg0.getText();
          }
        } else {
          token = `@${short}`;
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

    if (!baseTypeName) continue;

    const typeOnlyLoc = typeOnlyImports.get(baseTypeName);

    deps.push({
      paramName: param.getName(),
      typeName: baseTypeName,
      token,
      isOptional,
      isForwardRef,
      isTypeOnlyImport: Boolean(typeOnlyLoc),
      importDeclarationLocation: typeOnlyLoc,
      location: nodeToLocation(param.getNameNode()),
    });
  }

  return deps;
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
  const moduleByName = new Map<string, StaticModuleNode>();

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
        const autoProp = getObjectProp(arg0, "autoDiscover");
        const autoDiscover =
          isAuto ||
          (autoProp !== undefined &&
            autoProp.getKind() !== SyntaxKind.FalseKeyword);

        const modNode: StaticModuleNode = {
          name,
          sourceFile: filePath,
          location: nodeToLocation(cls.getNameNode() ?? cls),
          decoratorLocation: nodeToLocation(modDec),
          isGlobal: decNames.has("Global"),
          autoDiscover,
          imports: extractModuleClassRefs(getObjectProp(arg0, "imports")),
          controllers: extractModuleClassRefs(getObjectProp(arg0, "controllers")),
          providers: extractModuleClassRefs(getObjectProp(arg0, "providers")),
          exports: extractModuleClassRefs(getObjectProp(arg0, "exports")),
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
          kind: isController
            ? "controller"
            : isRepository
              ? "repository"
              : "provider",
          scope: extractInjectableScope(cls),
          sourceFile: filePath,
          location: nodeToLocation(cls.getNameNode() ?? cls),
          dependencies: extractConstructorDeps(cls, typeOnlyImports),
        };
        providers.push(provNode);
        providerByName.set(name, provNode);
      }
    }
  }

  return {
    modules,
    providers,
    providerByName,
    moduleByName,
    cycles: detectProviderCycles(providers),
  };
}
