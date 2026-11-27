import { afterEach, describe, expect, it } from "bun:test";
import {
  dirname,
  join,
  mkdirSyncPath,
  readTextSync,
  removePath,
  writeTextSync,
} from "@bunest/core";
import {
  BunestStaticAnalyzer,
  buildAddProviderToModuleEdit,
  buildCollapseLoggerBoilerplateEdit,
  buildConvertDerivedToQueryEdit,
  buildConvertTypeImportEdit,
  buildDelombokEdit,
  buildGenerateRepositorySource,
  buildSyncDiConstructorEdit,
  buildWrapMongooseRefEdit,
  emitBunestDeclaration,
  getRepositoryDerivedCompletions,
  parseDerivedMethodName,
  resolveClassMacroMembers,
  runCli,
  scanSqlPlaceholders,
  type CliIO,
} from "../src";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: string[] = [];

function createTempProject(files: Record<string, string>): string {
  const dir = join(
    TMP_DIR,
    `bunest-analyzer-${crypto.randomUUID().slice(0, 8)}`,
  );
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
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true });
  }
});

describe("BunestStaticAnalyzer: Declarative Repositories, Class Macros & magic-string", () => {
  it("parses derived queries, previews SQLite/Postgres/MySQL SQL, and suggests chained completions", () => {
    const cwd = createTempProject({
      "src/user.entity.ts": `
        function Entity(_n?: string): ClassDecorator { return () => {}; }
        function PrimaryGeneratedColumn(): PropertyDecorator { return () => {}; }
        function Column(_o?: any): PropertyDecorator { return () => {}; }
        function Unique(): PropertyDecorator { return () => {}; }
        function Index(): PropertyDecorator { return () => {}; }

        @Entity("users")
        export class UserEntity {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column()
          @Unique()
          email!: string;

          @Column()
          @Index()
          age!: number;

          @Column()
          active!: boolean;

          @Column()
          createdAt!: Date;
        }
      `,
      "src/user.repository.ts": `
        import { UserEntity } from "./user.entity";
        function Repository(_e?: any): ClassDecorator { return () => {}; }
        function Query(_sql: string): MethodDecorator { return () => {}; }
        function SqlParam(_n: string): ParameterDecorator { return () => {}; }
        abstract class CrudRepository<T, K = number> {}

        @Repository(UserEntity)
        export abstract class UserRepository extends CrudRepository<UserEntity, number> {
          abstract findAllByAgeGreaterThanEqualAndActiveIsTrueOrderByCreatedAtDesc(age: number): Promise<UserEntity[]>;
          abstract findByEmial(email: string): Promise<UserEntity | null>;
          abstract findByAgeBetween(min: number): Promise<UserEntity[]>;
          abstract findByAge(age: string): Promise<UserEntity | null>;
          abstract existsByEmail(email: string): Promise<string>;
          abstract findByAgeContaining(age: number): Promise<UserEntity[]>;

          @Query("UPDATE users SET active = 0 WHERE email = :email")
          deactivate(@SqlParam("wrong") _email: string): Promise<void> {
            throw new Error("proxy");
          }
        }

        export abstract class MissingDecRepo extends CrudRepository<UserEntity, number> {}
      `,
    });

    const analyzer = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" });
    const snap = analyzer.analyze();

    expect(snap.entities.length).toBe(1);
    expect(snap.repositories.length).toBe(2);

    const userRepo = snap.repositories.find((r) => r.className === "UserRepository")!;
    const goodMethod = userRepo.methods.find(
      (m) => m.name === "findAllByAgeGreaterThanEqualAndActiveIsTrueOrderByCreatedAtDesc",
    )!;
    expect(goodMethod.derived?.sqlByDialect.sqlite).toBe(
      'SELECT * FROM "users" WHERE "age" >= ? AND "active" = 1 ORDER BY "created_at" DESC',
    );
    expect(goodMethod.derived?.sqlByDialect.postgres).toBe(
      'SELECT * FROM "users" WHERE "age" >= $1 AND "active" = 1 ORDER BY "created_at" DESC',
    );
    expect(goodMethod.derived?.sqlByDialect.mysql).toBe(
      "SELECT * FROM `users` WHERE `age` >= ? AND `active` = 1 ORDER BY `created_at` DESC",
    );

    // Chained completions
    const propCompletions = getRepositoryDerivedCompletions(userRepo, "findAllBy");
    expect(propCompletions.some((c) => c.label === "Email")).toBe(true);
    expect(propCompletions.some((c) => c.label === "Age")).toBe(true);

    const ageOps = getRepositoryDerivedCompletions(userRepo, "findAllByAge");
    expect(ageOps.some((c) => c.label === "GreaterThanEqual")).toBe(true);
    expect(ageOps.some((c) => c.label === "Between")).toBe(true);
    // String-only operators should NOT be offered on number column `age`!
    expect(ageOps.some((c) => c.label === "Containing")).toBe(false);

    // Verify all 7 BUNEST_REPO001..007 rules triggered
    const codes = new Set(snap.diagnostics.map((d) => d.code));
    expect(codes.has("BUNEST_REPO001")).toBe(true); // Emial -> Email
    expect(codes.has("BUNEST_REPO002")).toBe(true); // Between needs 2 args
    expect(codes.has("BUNEST_REPO003")).toBe(true); // age: string vs number
    expect(codes.has("BUNEST_REPO004")).toBe(true); // existsBy returns string
    expect(codes.has("BUNEST_REPO005")).toBe(true); // Containing on number
    expect(codes.has("BUNEST_REPO006")).toBe(true); // UPDATE without @Modifying + :email mismatch
    expect(codes.has("BUNEST_REPO007")).toBe(true); // MissingDecRepo without @Repository

    const repo001 = snap.diagnostics.find((d) => d.code === "BUNEST_REPO001")!;
    expect(repo001.message).toContain('Did you mean "Email"?');

    // SQL placeholder scanner skips strings, comments & Postgres casts
    const scanned = scanSqlPlaceholders(
      "SELECT id::text, ':notParam' FROM users -- :comment\n WHERE email = :email AND age > :minAge",
    );
    expect(scanned.namedPlaceholders).toEqual(["email", "minAge"]);
    expect(scanned.isWriteSql).toBe(false);

    // Derived -> @Query magic-string edit preserves surrounding code
    const sf = analyzer.getSourceFile(userRepo.sourceFile)!;
    const converted = buildConvertDerivedToQueryEdit({
      filePath: userRepo.sourceFile,
      sourceText: sf.getFullText(),
      method: goodMethod,
      repo: userRepo,
    });
    expect(converted.changed).toBe(true);
    expect(converted.updated).toContain('@Query("SELECT * FROM \\"users\\" WHERE \\"age\\" >= :age');
    expect(converted.updated).toContain('@SqlParam("age") age: number');

    // Entity -> declarative @Repository<Entity, Key>() generator targets @bunest/orm (ZERO Jpa prefix!)
    const generatedRepo = buildGenerateRepositorySource({
      entity: snap.entities[0]!,
      entityImportPath: "./user.entity",
    });
    expect(generatedRepo.fileName).toBe("user.repository.ts");
    expect(generatedRepo.content).toContain('import { Repository } from "@bunest/orm";');
    expect(generatedRepo.content).toContain('import type { UserEntity } from "./user.entity";');
    expect(generatedRepo.content).toContain("@Repository<UserEntity, number>()");
    expect(generatedRepo.content).toContain("export abstract class UserRepository {");
    expect(generatedRepo.content).toContain("abstract findByEmail(email: string): Promise<UserEntity | null>;");
    expect(generatedRepo.content).toContain("abstract findAllByAge(age: number): Promise<UserEntity[]>;");
    expect(generatedRepo.content).not.toContain("Jpa");
  });

  it("analyzes Class Macros, emits interface+namespace augmentation, detects BUNEST_MACRO001..005, and runs Delombok", () => {
    const cwd = createTempProject({
      "src/models.ts": `
        function Data(_o?: any): ClassDecorator { return () => {}; }
        function Value(_o?: any): ClassDecorator { return () => {}; }
        function Builder(_o?: any): ClassDecorator { return () => {}; }
        function Setter(_o?: any): ClassDecorator & PropertyDecorator { return () => {}; }
        function Secret(_o?: any): PropertyDecorator { return () => {}; }
        function Singular(_n?: string): PropertyDecorator { return () => {}; }
        function FieldNameConstants(_o?: any): ClassDecorator { return () => {}; }
        function WithLogger(_o?: any): ClassDecorator { return () => {}; }
        function Delegate(_o?: any): PropertyDecorator { return () => {}; }
        function UtilityClass(): ClassDecorator { return () => {}; }

        export class Printer {
          print(text: string): string { return text; }
        }

        @Data({ exclude: ["passwrod"] })
        @Builder({ toBuilder: true })
        @FieldNameConstants()
        export class Account {
          id!: number;
          email!: string;
          @Secret()
          password!: string;
          @Singular()
          roles!: string[];
          @Singular()
          badSingular!: number;
        }

        @Value()
        @Setter()
        export class ConflictValue {
          amount!: number;
        }

        @WithLogger()
        export class ShadowedLoggerService {
          logger = null;
          @Delegate()
          printer = new Printer();
          @Delegate()
          primitiveDel = 123;
        }

        @UtilityClass()
        export class BadUtil {
          instanceMethod() {}
        }
      `,
    });

    const analyzer = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" });
    const snap = analyzer.analyze();

    expect(snap.scan.classMacros.length).toBe(4);
    const dts = emitBunestDeclaration(snap.scan, {
      outputPath: join(cwd, ".bunest/types/bunest.d.ts"),
      cwd,
    });
    expect(dts).toContain("interface Account");
    expect(dts).toContain("interface AccountBuilder");
    expect(dts).toContain("namespace Account");
    expect(dts).toContain("role(item: string): this;");
    expect(dts).toContain("clearRoles(): this;");
    expect(dts).toContain("export const Fields:");
    expect(dts).toContain("print(text: string): string;");

    const accountMacro = snap.scan.classMacros.find((m) => m.className === "Account")!;
    const members = resolveClassMacroMembers(accountMacro);
    expect(members.some((m) => m.name === "builder" && m.kind === "static")).toBe(true);
    expect(members.some((m) => m.name === "toBuilder" && m.kind === "instance")).toBe(true);

    const codes = new Set(snap.diagnostics.map((d) => d.code));
    expect(codes.has("BUNEST_MACRO001")).toBe(true); // passwrod -> password
    expect(codes.has("BUNEST_MACRO002")).toBe(true); // @Value + @Setter / @UtilityClass instance method
    expect(codes.has("BUNEST_MACRO003")).toBe(true); // Shadowed logger
    expect(codes.has("BUNEST_MACRO004")).toBe(true); // @Singular on number
    expect(codes.has("BUNEST_MACRO005")).toBe(true); // @Delegate on primitive 123

    // Delombok expands @Data / @Builder cleanly preserving formatting
    const sf = analyzer.getSourceFile(accountMacro.sourceFile)!;
    const delomboked = buildDelombokEdit({
      sourceFile: sf,
      classDecl: sf.getClass("Account")!,
      macro: accountMacro,
      targetDecorator: "FieldNameConstants",
    });
    expect(delomboked.changed).toBe(true);
    expect(delomboked.updated).not.toContain("@FieldNameConstants()");
    expect(delomboked.updated).toContain("static readonly Fields = {");
  });

  it("detects core diagnostics BUNEST001..007 and executes magic-string Quick Fixes cleanly", () => {
    const cwd = createTempProject({
      "src/logger.service.ts": `
        export class Logger { constructor(_ctx?: string) {} }
      `,
      "src/dep.service.ts": `
        function Injectable(_o?: any): ClassDecorator { return () => {}; }
        @Injectable({ scope: Scope.REQUEST })
        export class ReqDep {}
        const Scope = { REQUEST: 1 };
      `,
      "src/cycle-a.ts": `
        import { CycleB } from "./cycle-b";
        function Injectable(): ClassDecorator { return () => {}; }
        @Injectable()
        export class CycleA { constructor(private readonly b: CycleB) {} }
      `,
      "src/cycle-b.ts": `
        import { CycleA } from "./cycle-a";
        function Injectable(): ClassDecorator { return () => {}; }
        @Injectable()
        export class CycleB { constructor(private readonly a: CycleA) {} }
      `,
      "src/app.service.ts": `
        import type { ReqDep } from "./dep.service";
        import { Logger } from "./logger.service";
        function Injectable(): ClassDecorator { return () => {}; }
        function Controller(_p?: string): ClassDecorator { return () => {}; }
        function Get(_p?: string): MethodDecorator { return () => {}; }
        function Schema(): ClassDecorator { return () => {}; }
        function Prop(_o?: any): PropertyDecorator { return () => {}; }
        function EmitEvent(_n: string): MethodDecorator { return () => {}; }

        @Schema()
        export class Post {
          @Prop({ ref: "User" })
          authorId!: string;
          @Prop()
          meta!: string | number;
        }

        @Injectable()
        export class AppService {
          private readonly logger = new Logger(AppService.name);
          private readonly dep!: ReqDep;
          constructor(private readonly reqDep: ReqDep) {}

          @EmitEvent("orphan.event")
          fire() { return 1; }
        }

        @Controller("items")
        export class ItemsController {
          @Get("list")
          listA() { return []; }
          @Get("list")
          listB() { return []; }
        }
      `,
      "src/app.module.ts": `
        import { AppService, ItemsController } from "./app.service";
        function Module(_m: any): ClassDecorator { return () => {}; }

        @Module({
          controllers: [ItemsController],
          providers: [AppService],
        })
        export class AppModule {}
      `,
    });

    const analyzer = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" });
    const snap = analyzer.analyze();
    const codes = new Set(snap.diagnostics.map((d) => d.code));

    expect(codes.has("BUNEST001")).toBe(true); // ReqDep missing from AppModule
    expect(codes.has("BUNEST002")).toBe(true); // CycleA <-> CycleB
    expect(codes.has("BUNEST003")).toBe(true); // SINGLETON AppService -> REQUEST ReqDep
    const bunest003 = snap.diagnostics.find((d) => d.code === "BUNEST003")!;
    expect(bunest003.severity).toBe("error");
    expect(bunest003.message).toContain("BUNEST_E003");
    expect(bunest003.message).toContain("ScopeLeakException");
    expect(bunest003.message).toContain("AppService [SINGLETON] -> ReqDep [REQUEST]");
    expect(codes.has("BUNEST004")).toBe(true); // import type { ReqDep }
    expect(codes.has("BUNEST005")).toBe(true); // duplicate GET /items/list
    expect(codes.has("BUNEST006")).toBe(true); // bare ref & union @Prop
    expect(codes.has("BUNEST007")).toBe(true); // orphan.event

    // Test magic-string edits
    const modSf = analyzer.getSourceFile(join(cwd, "src/app.module.ts"))!;
    const addProv = buildAddProviderToModuleEdit({
      sourceFile: modSf,
      moduleClassName: "AppModule",
      symbolName: "ReqDep",
      arrayProperty: "providers",
      importSpecifier: "./dep.service",
    });
    expect(addProv.updated).toContain('import { ReqDep } from "./dep.service";');
    expect(addProv.updated).toContain("providers: [AppService, ReqDep]");

    const svcSf = analyzer.getSourceFile(join(cwd, "src/app.service.ts"))!;
    const fixTypeImp = buildConvertTypeImportEdit({
      sourceFile: svcSf,
      symbolName: "ReqDep",
    });
    expect(fixTypeImp.updated).toContain('import { ReqDep } from "./dep.service";');

    const collapseLogger = buildCollapseLoggerBoilerplateEdit({
      sourceFile: svcSf,
      classDecl: svcSf.getClass("AppService")!,
    });
    expect(collapseLogger.changed).toBe(true);
    expect(collapseLogger.updated).toContain("@WithLogger()");
    expect(collapseLogger.updated).not.toContain("new Logger(AppService.name)");

    const syncCtor = buildSyncDiConstructorEdit({
      sourceFile: svcSf,
      classDecl: svcSf.getClass("AppService")!,
    });
    expect(syncCtor.changed).toBe(true);
    expect(syncCtor.updated).toContain("private readonly dep: ReqDep");

    const refDiag = snap.diagnostics.find(
      (d) => d.code === "BUNEST006" && d.fixData?.kind === "wrapMongooseRef",
    )!;
    const wrapRef = buildWrapMongooseRefEdit({
      filePath: svcSf.getFilePath(),
      sourceText: svcSf.getFullText(),
      decoratorStart: refDiag.fixData!.decoratorStart as number,
      decoratorEnd: refDiag.fixData!.decoratorEnd as number,
    });
    expect(wrapRef.updated).toContain("type: Schema.Types.ObjectId, ref:");
  });

  it("supports CLI commands: bunest check [--fix], generate repository, delombok, and codemod", async () => {
    const cwd = createTempProject({
      "src/order.entity.ts": `
        function Entity(_t?: string): ClassDecorator { return () => {}; }
        function PrimaryGeneratedColumn(): PropertyDecorator { return () => {}; }
        function Column(): PropertyDecorator { return () => {}; }
        function Unique(): PropertyDecorator { return () => {}; }
        function FieldNameConstants(): ClassDecorator { return () => {}; }

        @Entity("orders")
        @FieldNameConstants()
        export class OrderEntity {
          @PrimaryGeneratedColumn()
          id!: number;
          @Column()
          @Unique()
          code!: string;
        }
      `,
      "src/order.repo.ts": `
        import { OrderEntity } from "./order.entity";
        function Repository(_e?: any): ClassDecorator { return () => {}; }
        abstract class CrudRepository<T, K = number> {}

        @Repository(OrderEntity)
        export abstract class BrokenOrderRepo extends CrudRepository<OrderEntity, number> {
          abstract findByCdoe(code: string): Promise<OrderEntity | null>;
        }
      `,
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIO = {
      cwd,
      stdout: (m) => stdout.push(m),
      stderr: (m) => stderr.push(m),
    };

    // 1. bunest check --format json catches BUNEST_REPO001 typo "Cdoe"
    const check1 = await runCli(["check", "--format", "json"], io);
    expect(check1.exitCode).toBe(1);
    expect(stdout.join("\n")).toContain("BUNEST_REPO001");

    // 2. bunest check --fix auto-fixes Cdoe -> Code
    const checkFix = await runCli(["check", "--fix"], io);
    expect(checkFix.exitCode).toBe(0);
    expect(readTextSync(join(cwd, "src/order.repo.ts"))).toContain(
      "abstract findByCode(code: string)",
    );

    // 3. bunest g repo OrderEntity generates @bunest/orm order.repository.ts
    const genRepo = await runCli(
      ["g", "repo", "OrderEntity"],
      io,
    );
    expect(genRepo.exitCode).toBe(0);
    const repoSource = readTextSync(join(cwd, "src/order.repository.ts"));
    expect(repoSource).toContain('from "@bunest/orm"');
    expect(repoSource).toContain("@Repository<OrderEntity, number>()");
    expect(repoSource).toContain("export abstract class OrderRepository {");
    expect(repoSource).toContain("abstract findByCode(code: string)");

    // 4. bunest codemod derived-to-query converts findByCode -> @Query
    const codemodRes = await runCli(
      ["codemod", "derived-to-query", "src/order.repository.ts", "--method", "findByCode"],
      io,
    );
    expect(codemodRes.exitCode).toBe(0);
    expect(readTextSync(join(cwd, "src/order.repository.ts"))).toContain(
      "@Query(",
    );

    // 5. bunest delombok expands @FieldNameConstants() on OrderEntity
    const delombokRes = await runCli(["delombok", "OrderEntity"], io);
    expect(delombokRes.exitCode).toBe(0);
    const entityAfter = readTextSync(join(cwd, "src/order.entity.ts"));
    expect(entityAfter).not.toContain("@FieldNameConstants()");
    expect(entityAfter).toContain("static readonly Fields = {");
  });

  it("recognizes OrmModule.forFeature([UserRepository]), @Repository<Entity, Key>(), and @bunest/orm DI providers cleanly", () => {
    const cwd = createTempProject({
      "src/user.entity.ts": `
        function Entity(_o?: any): ClassDecorator { return () => {}; }
        function PrimaryColumn(): PropertyDecorator { return () => {}; }
        function Column(): PropertyDecorator { return () => {}; }

        @Entity({ tableName: "app_users" })
        export class UserEntity {
          @PrimaryColumn()
          id!: string;

          @Column()
          email!: string;
        }
      `,
      "src/user.repository.ts": `
        import type { UserEntity } from "./user.entity";
        function Repository<T = any, K = string>(_e?: any): ClassDecorator { return () => {}; }

        @Repository<UserEntity, string>()
        export abstract class UserRepository {
          abstract findByEmail(email: string): Promise<UserEntity | null>;
        }
      `,
      "src/user.service.ts": `
        import { UserRepository } from "./user.repository";
        function Injectable(): ClassDecorator { return () => {}; }
        class DataSource {}
        class OrmMigrationRunner {}

        @Injectable()
        export class UserService {
          constructor(
            private readonly users: UserRepository,
            private readonly dataSource: DataSource,
            private readonly migrations: OrmMigrationRunner,
          ) {}
        }
      `,
      "src/app.module.ts": `
        import { UserEntity } from "./user.entity";
        import { UserRepository } from "./user.repository";
        import { UserService } from "./user.service";
        function Module(_m: any): ClassDecorator { return () => {}; }
        const OrmModule = { forFeature: (_t: any[]) => ({}) };

        @Module({
          imports: [OrmModule.forFeature([UserEntity, UserRepository])],
          providers: [UserService],
        })
        export class AppModule {}
      `,
    });

    const analyzer = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" });
    const snap = analyzer.analyze();

    expect(snap.entities.length).toBe(1);
    expect(snap.entities[0]!.tableName).toBe("app_users");
    expect(snap.entities[0]!.idTsType).toBe("string");

    expect(snap.repositories.length).toBe(1);
    expect(snap.repositories[0]!.driver).toBe("orm");
    expect(snap.repositories[0]!.tableName).toBe("app_users");

    const errors = snap.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("scopes BUNEST001 bypass strictly to @AutoModule and keeps checking explicit @Module classes", () => {
    const cwd = createTempProject({
      "src/missing.service.ts": `
        function Injectable(): ClassDecorator { return () => {}; }
        @Injectable()
        export class MissingService {}
      `,
      "src/auto-dep.service.ts": `
        function Injectable(): ClassDecorator { return () => {}; }
        @Injectable()
        export class AutoDiscoveredDep {}
      `,
      "src/explicit.service.ts": `
        import { MissingService } from "./missing.service";
        function Injectable(): ClassDecorator { return () => {}; }
        @Injectable()
        export class ExplicitService {
          constructor(private readonly missing: MissingService) {}
        }
      `,
      "src/auto.service.ts": `
        import { AutoDiscoveredDep } from "./auto-dep.service";
        function Injectable(): ClassDecorator { return () => {}; }
        @Injectable()
        export class AutoService {
          constructor(private readonly dep: AutoDiscoveredDep) {}
        }
      `,
      "src/explicit.module.ts": `
        import { ExplicitService } from "./explicit.service";
        function Module(_m: any): ClassDecorator { return () => {}; }
        @Module({
          providers: [ExplicitService],
        })
        export class ExplicitModule {}
      `,
      "src/app.module.ts": `
        import { AutoService } from "./auto.service";
        import { ExplicitModule } from "./explicit.module";
        function AutoModule(_m?: any): ClassDecorator { return () => {}; }
        @AutoModule({
          imports: [ExplicitModule],
          providers: [AutoService],
        })
        export class AppAutoModule {}
      `,
    });

    const analyzer = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" });
    const snap = analyzer.analyze();

    const bunest001 = snap.diagnostics.filter((d) => d.code === "BUNEST001");
    // ExplicitModule MUST still emit BUNEST001 even though AppAutoModule exists
    expect(bunest001).toHaveLength(1);
    expect(bunest001[0]!.severity).toBe("error");
    expect(bunest001[0]!.message).toContain('"ExplicitService"');
    expect(bunest001[0]!.message).toContain('"MissingService"');
    expect(bunest001[0]!.message).toContain('"ExplicitModule"');
    // AutoService declared in @AutoModule MUST NOT emit BUNEST001
    expect(bunest001.some((d) => d.message.includes("AutoService"))).toBe(false);
  });

  it("reports BUNEST003 as error with transitive scope-leak chains aligned to ADR-012 / BUNEST_E003", async () => {
    const cwd = createTempProject({
      "src/scopes.ts": `
        export const Scope = { SINGLETON: 0, REQUEST: 1, TRANSIENT: 2 } as const;
        export const REQUEST = Symbol("REQUEST");
        export function Injectable(_o?: any): ClassDecorator { return () => {}; }
        export function Controller(_o?: any): ClassDecorator { return () => {}; }
        export function Module(_o?: any): ClassDecorator { return () => {}; }
        export function Inject(_t?: any): ParameterDecorator { return () => {}; }
      `,
      "src/tenant.context.ts": `
        import { Injectable, Scope } from "./scopes";
        @Injectable({ scope: Scope.REQUEST })
        export class TenantContext {}
      `,
      "src/transient.helper.ts": `
        import { Injectable, Scope } from "./scopes";
        import { TenantContext } from "./tenant.context";
        @Injectable({ scope: Scope.TRANSIENT })
        export class TransientHelper {
          constructor(private readonly tenant: TenantContext) {}
        }
      `,
      "src/users.service.ts": `
        import { Injectable } from "./scopes";
        import { TenantContext } from "./tenant.context";
        @Injectable()
        export class UsersService {
          constructor(private readonly tenant: TenantContext) {}
        }
      `,
      "src/users.controller.ts": `
        import { Controller } from "./scopes";
        import { UsersService } from "./users.service";
        @Controller("users")
        export class UsersController {
          constructor(private readonly users: UsersService) {}
        }
      `,
      "src/singleton-via-transient.service.ts": `
        import { Injectable } from "./scopes";
        import { TransientHelper } from "./transient.helper";
        @Injectable()
        export class SingletonViaTransientService {
          constructor(private readonly helper: TransientHelper) {}
        }
      `,
      "src/singleton-builtin-req.service.ts": `
        import { Inject, Injectable, REQUEST } from "./scopes";
        @Injectable()
        export class SingletonBuiltinReqService {
          constructor(@Inject(REQUEST) private readonly req: unknown) {}
        }
      `,
      "src/valid-request.controller.ts": `
        import { Controller, Scope } from "./scopes";
        import { TransientHelper } from "./transient.helper";
        @Controller({ path: "ok", scope: Scope.REQUEST })
        export class ValidRequestController {
          constructor(private readonly helper: TransientHelper) {}
        }
      `,
      "src/app.module.ts": `
        import { Module } from "./scopes";
        import { TenantContext } from "./tenant.context";
        import { TransientHelper } from "./transient.helper";
        import { UsersService } from "./users.service";
        import { UsersController } from "./users.controller";
        import { SingletonViaTransientService } from "./singleton-via-transient.service";
        import { SingletonBuiltinReqService } from "./singleton-builtin-req.service";
        import { ValidRequestController } from "./valid-request.controller";
        @Module({
          controllers: [UsersController, ValidRequestController],
          providers: [
            TenantContext,
            TransientHelper,
            UsersService,
            SingletonViaTransientService,
            SingletonBuiltinReqService,
          ],
        })
        export class AppModule {}
      `,
    });

    const analyzer = new BunestStaticAnalyzer({ cwd, sourceRoot: "src" });
    const snap = analyzer.analyze();
    const leaks = snap.diagnostics.filter((d) => d.code === "BUNEST003");

    // All BUNEST003 diagnostics must be severity "error" aligned to ADR-012 / BUNEST_E003
    expect(leaks.length).toBe(4);
    for (const d of leaks) {
      expect(d.severity).toBe("error");
      expect(d.message).toContain("BUNEST_E003");
      expect(d.message).toContain("ScopeLeakException");
      expect(d.message).toContain("ADR-012");
    }

    // 1. Direct: UsersService [SINGLETON] -> TenantContext [REQUEST]
    expect(
      leaks.some((d) =>
        d.message.includes("UsersService [SINGLETON] -> TenantContext [REQUEST]"),
      ),
    ).toBe(true);

    // 2. Transitive via SINGLETON: UsersController [SINGLETON] -> UsersService [SINGLETON] -> TenantContext [REQUEST]
    expect(
      leaks.some((d) =>
        d.message.includes(
          "UsersController [SINGLETON] -> UsersService [SINGLETON] -> TenantContext [REQUEST]",
        ),
      ),
    ).toBe(true);

    // 3. Transitive via TRANSIENT: SingletonViaTransientService [SINGLETON] -> TransientHelper [TRANSIENT] -> TenantContext [REQUEST]
    expect(
      leaks.some((d) =>
        d.message.includes(
          "SingletonViaTransientService [SINGLETON] -> TransientHelper [TRANSIENT] -> TenantContext [REQUEST]",
        ),
      ),
    ).toBe(true);

    // 4. Built-in REQUEST token injected into SINGLETON
    expect(
      leaks.some((d) =>
        d.message.includes("SingletonBuiltinReqService [SINGLETON] -> REQUEST [REQUEST]"),
      ),
    ).toBe(true);

    // TRANSIENT TransientHelper and REQUEST-scoped ValidRequestController MUST NOT be flagged as leaks
    expect(
      leaks.some((d) => d.message.includes('TRANSIENT "TransientHelper"')),
    ).toBe(false);
    expect(
      leaks.some((d) => d.message.includes("ValidRequestController")),
    ).toBe(false);

    // `bunest check` must fail (exitCode 1) even without --strict because BUNEST003 is now an error
    const stdout: string[] = [];
    const stderr: string[] = [];
    const checkRes = await runCli(["check", "--format", "json"], {
      cwd,
      stdout: (m) => stdout.push(m),
      stderr: (m) => stderr.push(m),
    });
    expect(checkRes.exitCode).toBe(1);
    const parsed = JSON.parse(stdout.join("\n")) as {
      errors: number;
      diagnostics: Array<{ code: string; severity: string }>;
    };
    expect(parsed.errors).toBeGreaterThanOrEqual(4);
    expect(
      parsed.diagnostics.every(
        (d) => d.code !== "BUNEST003" || d.severity === "error",
      ),
    ).toBe(true);
  });
});
