import { afterEach, describe, expect, it } from "bun:test";
import {
  dirname,
  join,
  mkdirSyncPath,
  removePath,
  writeTextSync,
} from "@bunest/core";
import {
  BunestProject,
  Node,
  SyntaxKind,
  TypeFormatFlags,
  getLineAndColumnAtPos,
  lexTypeScript,
  parseTypeScript,
} from "../src/ast";
import { generateBunestTypes } from "../src/typegen";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: string[] = [];

function createTempDir(files: Record<string, string>): string {
  const dir = join(TMP_DIR, `bunest-ast-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSyncPath(dir);
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSyncPath(dirname(abs));
    writeTextSync(abs, content);
  }
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await removePath(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Bunest Native TypeScript Lexer, Parser & Resolver (packages/cli/src/ast)", () => {
  it("lexes comments, hashbang, nested template literals, regex vs division, and computes O(log N) line/col", () => {
    const src = [
      "#!/usr/bin/env bun",
      "// line comment",
      "/* multi\nline */",
      "const ratio = a / b / 2;",
      "const re = /foo[a/b]\\/bar/gi;",
      "const tmpl = `outer ${`inner ${1 + { x: 2 }.x}`} tail`;",
      "const num = 1_000_000 + 0xff + 12n;",
    ].join("\n");

    const { tokens, lineStarts } = lexTypeScript(src);
    expect(tokens.some((t) => t.kind === SyntaxKind.RegularExpressionLiteral && t.text === "/foo[a/b]\\/bar/gi")).toBe(true);
    expect(tokens.filter((t) => t.kind === SyntaxKind.SlashToken)).toHaveLength(2);
    expect(tokens.filter((t) => t.kind === SyntaxKind.TemplateHead)).toHaveLength(2);
    expect(tokens.filter((t) => t.kind === SyntaxKind.TemplateTail)).toHaveLength(2);
    expect(tokens.some((t) => t.kind === SyntaxKind.NumericLiteral && t.value === 1000000)).toBe(true);
    expect(tokens.some((t) => t.kind === SyntaxKind.NumericLiteral && t.value === 255)).toBe(true);
    expect(tokens.some((t) => t.kind === SyntaxKind.BigIntLiteral)).toBe(true);

    // 1-based line/col verification
    expect(getLineAndColumnAtPos(lineStarts, 0)).toEqual({ line: 1, column: 1 });
    const reIdx = src.indexOf("/foo");
    expect(getLineAndColumnAtPos(lineStarts, reIdx)).toEqual({ line: 6, column: 12 });

    // CRLF line endings
    const crlf = "line1\r\nline2\r\nline3";
    const crlfRes = lexTypeScript(crlf);
    expect(getLineAndColumnAtPos(crlfRes.lineStarts, crlf.indexOf("line2"))).toEqual({
      line: 2,
      column: 1,
    });
    expect(getLineAndColumnAtPos(crlfRes.lineStarts, crlf.indexOf("line3"))).toEqual({
      line: 3,
      column: 1,
    });
  });

  it("parses nested generics (>> / >>>), decorators with namespaces, arrows, classes, interfaces, and TSX safely", () => {
    const project = new BunestProject();
    const sf = project.createSourceFile(
      "/virtual/complex.tsx",
      `
      import type { Foo, Bar as Baz } from "./types";
      import { Alpha, type Beta } from "./alpha";

      @Controller("v1")
      @ToString.Include()
      export abstract class ComplexService extends BaseService<Map<string, Set<Array<number>>>, string> {
        @ToString.Exclude()
        private readonly nested!: Promise<Record<string, Array<Foo | null>>>;

        @Get("items")
        async getItems(
          @Param("id") id: string,
          @Query("flag") flag = false,
        ): Promise<Array<Foo>> {
          const fn = <T>(x: T): T => x;
          const mapped = items.map((item) => ({ id: item }));
          const view = <div className="ok"><span>{this.renderHelper(id)}</span></div>;
          return fn(mapped) as unknown as Array<Foo>;
        }

        abstract findById(id: string): Promise<Foo | null>;
      }
      `,
    );

    expect(sf.getImportDeclarations()).toHaveLength(2);
    expect(sf.getImportDeclarations()[0]!.isTypeOnly()).toBe(true);
    expect(sf.getImportDeclarations()[0]!.getNamedImports()[1]!.getAliasNode()?.getText()).toBe("Baz");
    expect(sf.getImportDeclarations()[1]!.getNamedImports()[1]!.isTypeOnly()).toBe(true);

    const cls = sf.getClass("ComplexService")!;
    expect(cls).toBeDefined();
    expect(cls.isExported()).toBe(true);
    expect(cls.isAbstract()).toBe(true);
    expect(cls.getDecorators().map((d) => d.getName())).toEqual(["Controller", "Include"]);
    expect(cls.getExtends()?.getExpression().getText()).toBe("BaseService");
    expect(cls.getExtends()?.getTypeArguments()).toHaveLength(2);
    expect(cls.getExtends()?.getTypeArguments()[0]!.getText()).toBe(
      "Map<string, Set<Array<number>>>",
    );

    const prop = cls.getProperties()[0]!;
    expect(prop.getName()).toBe("nested");
    expect(prop.isReadonly()).toBe(true);
    expect(prop.hasExclamationToken()).toBe(true);
    expect(prop.getDecorators()[0]!.getName()).toBe("Exclude");
    const expr = prop.getDecorators()[0]!.getExpression();
    expect(Node.isCallExpression(expr)).toBe(true);
    if (Node.isCallExpression(expr)) {
      expect(expr.getExpression().getText()).toBe("ToString.Exclude");
    }

    // Call expression inside JSX `{this.renderHelper(id)}` is preserved in AST
    const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
    expect(
      calls.some((c) => c.getExpression().getText() === "this.renderHelper"),
    ).toBe(true);

    const absMethod = cls.getMethod("findById")!;
    expect(absMethod.isAbstract()).toBe(true);
    expect(absMethod.getReturnTypeNode()?.getText()).toBe("Promise<Foo | null>");
  });

  it("recovers gracefully on incomplete/malformed live-edited IDE buffers without hanging", () => {
    const raw = parseTypeScript(`
      @OrmRepository(User)
      export abstract class UserRepo extends CrudRepository<User, number> {
        abstract findAllByAge
        abstract findByEmail(email: string): Promise<User | null>;
      }
    `);
    expect(raw.kind).toBe(SyntaxKind.SourceFile);

    const project = new BunestProject();
    const sf = project.createSourceFile(
      "/virtual/incomplete.ts",
      `
      @Injectable()
      export class Broken {
        readonly x =
        ok(): string { return "still parsed"; }
      }
      `,
    );
    expect(sf.getClass("Broken")).toBeDefined();
    expect(sf.getClass("Broken")!.getMethod("ok")?.getReturnType().isString()).toBe(true);
  });

  it("resolves cross-file imports, re-exports, namespace imports, tsconfig paths, extends chains, and types", () => {
    const dir = createTempDir({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@domain/*": ["src/domain/*"],
          },
        },
      }),
      "src/domain/base.entity.ts": `
        export class BaseEntity {
          id!: number;
          createdAt!: Date;
        }
      `,
      "src/domain/user.entity.ts": `
        import { BaseEntity } from "./base.entity";
        export class UserEntity extends BaseEntity {
          email!: string;
          roles!: string[];
          tags!: Set<string>;
          meta!: Map<string, number>;
          active?: boolean;
        }
      `,
      "src/domain/index.ts": `
        export * from "./user.entity";
        export { BaseEntity as CoreBase } from "./base.entity";
      `,
      "src/consumer.ts": `
        import { UserEntity, CoreBase } from "@domain/index";
        import * as Domain from "./domain/user.entity";

        export class Consumer {
          user!: UserEntity;
          base!: CoreBase;
          nsUser = new Domain.UserEntity();
          cfg = ({ host: "localhost", port: 5432, ssl: false }) as const;
          async load(): Promise<UserEntity | null> { return null; }
        }
      `,
    });

    const project = new BunestProject({
      tsConfigFilePath: join(dir, "tsconfig.json"),
    });
    const consumerSf = project.addSourceFileAtPath(join(dir, "src/consumer.ts"));
    const consumerCls = consumerSf.getClass("Consumer")!;

    // 1. Cross-file via tsconfig path + `export * from` barrel
    const userProp = consumerCls.getProperties().find((p) => p.getName() === "user")!;
    const userType = userProp.getType();
    const userDecl = userType.getSymbol()?.getDeclarations()[0];
    expect(Node.isClassDeclaration(userDecl)).toBe(true);
    if (Node.isClassDeclaration(userDecl)) {
      expect(userDecl.getName()).toBe("UserEntity");
      // Inheritance chain across files
      const base = userDecl.getBaseClass();
      expect(base?.getName()).toBe("BaseEntity");
      // Collection type introspection
      const rolesType = userDecl.getProperties().find((p) => p.getName() === "roles")!.getType();
      expect(rolesType.isArray()).toBe(true);
      expect(rolesType.getArrayElementType()?.isString()).toBe(true);
      const tagsType = userDecl.getProperties().find((p) => p.getName() === "tags")!.getType();
      expect(tagsType.getSymbol()?.getName()).toBe("Set");
      expect(tagsType.getTypeArguments()[0]?.isString()).toBe(true);
      const metaType = userDecl.getProperties().find((p) => p.getName() === "meta")!.getType();
      expect(metaType.getSymbol()?.getName()).toBe("Map");
      expect(metaType.getTypeArguments().map((t) => t.getText(userDecl))).toEqual([
        "string",
        "number",
      ]);
      const activeType = userDecl.getProperties().find((p) => p.getName() === "active")!.getType();
      expect(activeType.isNullable()).toBe(true);
      expect(activeType.getNonNullableType().isBoolean()).toBe(true);
    }

    // 2. Aliased re-export `export { BaseEntity as CoreBase }`
    const baseProp = consumerCls.getProperties().find((p) => p.getName() === "base")!;
    const baseDecl = baseProp.getType().getSymbol()?.getDeclarations()[0];
    expect(Node.isClassDeclaration(baseDecl) && baseDecl.getName() === "BaseEntity").toBe(true);

    // 3. Namespace import `new Domain.UserEntity()`
    const nsProp = consumerCls.getProperties().find((p) => p.getName() === "nsUser")!;
    expect(nsProp.getType().getSymbol()?.getName()).toBe("UserEntity");

    // 4. `as const` preserves inferred object shape
    const cfgProp = consumerCls.getProperties().find((p) => p.getName() === "cfg")!;
    expect(cfgProp.getType().isObject()).toBe(true);
    expect(cfgProp.getType().getText(cfgProp)).toBe(
      "{ host: string; port: number; ssl: boolean; }",
    );

    // 5. `Promise<UserEntity | null>` formats with `import("...")` for TypePrinter
    const loadRet = consumerCls.getMethod("load")!.getReturnType();
    expect(loadRet.getSymbol()?.getName()).toBe("Promise");
    const inner = loadRet.getTypeArguments()[0]!;
    expect(
      inner.getText(
        undefined,
        TypeFormatFlags.NoTruncation |
          TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
      ),
    ).toContain('user.entity.ts").UserEntity | null');
  });

  it("handles unexported local structural inlining, inline registerAs factories, and incremental replaceWithText", async () => {
    const dir = createTempDir({
      "src/app.ts": `
        function Controller(_p?: string): ClassDecorator { return () => {}; }
        function Get(_p?: string): MethodDecorator { return () => {}; }
        function registerAs<T>(_ns: string, fn: () => T) { return fn; }

        interface LocalHealth {
          ok: boolean;
          uptime: number;
        }

        export default registerAs("runtime", () => ({
          env: "prod",
          workers: 4,
          debug: false,
        }));

        @Controller("health")
        export class HealthController {
          @Get()
          status(): LocalHealth {
            return { ok: true, uptime: 100 };
          }
        }
      `,
    });

    const res = await generateBunestTypes({ cwd: dir, dryRun: true });
    // Unexported `LocalHealth` is structurally inlined
    expect(res.content).toContain("readonly response: { ok: boolean; uptime: number };");
    // Inline `export default registerAs(...)` infers object shape
    expect(res.content).toContain(
      "runtime: { env: string; workers: number; debug: boolean; };",
    );

    // Incremental in-memory update via replaceWithText invalidates caches cleanly
    const project = new BunestProject();
    const sf = project.createSourceFile("/virtual/a.ts", "export class A { x!: string; }");
    expect(sf.getClass("A")?.getProperties()[0]?.getType().isString()).toBe(true);
    sf.replaceWithText("export class A { x!: number; }");
    expect(sf.getClass("A")?.getProperties()[0]?.getType().isNumber()).toBe(true);
  });
});
