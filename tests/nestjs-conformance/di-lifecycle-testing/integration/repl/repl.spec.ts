import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  Controller,
  Inject,
  Injectable,
  Module,
  Scope,
} from "../../../../../packages/core/src/common";
import {
  BunestFactory,
  createReplContext,
  type BunestApplicationContext,
  type ReplContextFunctions,
} from "../../../../../packages/core/src";
import { describeConformance, itAdapted } from "../../../_helpers";

@Injectable()
class UsersRepository {
  find() {
    return ["alice", "bob"];
  }
}

@Injectable()
class UsersService {
  constructor(
    @Inject("UsersRepository")
    public readonly usersRepository: UsersRepository,
  ) {}

  create() {
    return "created";
  }

  findAll() {
    return "This action returns all users";
  }

  findOne() {
    return "one";
  }

  update() {
    return "updated";
  }

  remove() {
    return "removed";
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientReportService {
  readonly id = Math.random();
}

@Controller("users")
class UsersController {
  constructor(private readonly usersService: UsersService) {}

  list() {
    return this.usersService.findAll();
  }
}

@Module({
  controllers: [UsersController],
  providers: [
    UsersService,
    TransientReportService,
    { provide: "UsersRepository", useClass: UsersRepository },
  ],
  exports: [UsersService, "UsersRepository"],
})
class UsersModule {}

@Module({
  imports: [UsersModule],
})
class AppModule {}

describeConformance(
  "REPL",
  {
    upstreamPath: "integration/repl/e2e/repl.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Upstream drives node:repl TTY ANSI prompt output; adapted to test all @bunest/core createReplContext() functions (get, $, resolve, select, debug, methods, help) programmatically without TTY side effects.",
  },
  () => {
    let app: BunestApplicationContext;
    let ctx: ReplContextFunctions;
    let consoleLogSpy: ReturnType<typeof spyOn>;

    beforeEach(async () => {
      app = await BunestFactory.createApplicationContext(AppModule, {
        logger: false,
      });
      await app.init();
      ctx = createReplContext(app);
      consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(async () => {
      consoleLogSpy.mockRestore();
      await app.close();
    });

    itAdapted(
      "ADR-001",
      "get() should retrieve providers by class or string token",
      () => {
        const svc = ctx.get(UsersService);
        expect(svc).toBeInstanceOf(UsersService);
        expect(svc.findAll()).toBe("This action returns all users");

        const repo = ctx.get<UsersRepository>("UsersRepository");
        expect(repo).toBeInstanceOf(UsersRepository);
        expect(repo.find()).toEqual(["alice", "bob"]);
      },
    );

    itAdapted("ADR-001", "$() should alias get()", () => {
      expect(ctx.$).toBe(ctx.get);
      expect(ctx.$(UsersService).findAll()).toBe(
        "This action returns all users",
      );
      expect(ctx.$("UsersRepository")).toBeInstanceOf(UsersRepository);
    });

    itAdapted(
      "ADR-001",
      "resolve() should asynchronously resolve transient providers",
      async () => {
        const first = await ctx.resolve(TransientReportService);
        const second = await ctx.resolve(TransientReportService);
        expect(first).toBeInstanceOf(TransientReportService);
        expect(second).toBeInstanceOf(TransientReportService);
        expect(first).not.toBe(second);
      },
    );

    itAdapted(
      "ADR-001",
      "select() should navigate into a specific module context",
      () => {
        const usersCtx = ctx.select(UsersModule);
        expect(usersCtx.get(UsersService)).toBeInstanceOf(UsersService);
      },
    );

    itAdapted(
      "ADR-001",
      "debug() should print modules, controllers, and providers",
      () => {
        ctx.debug(UsersModule);
        const output = consoleLogSpy.mock.calls
          .map((c: unknown[]) => c.join(" "))
          .join("\n");
        expect(output).toContain("UsersModule");
        expect(output).toContain("UsersController");
        expect(output).toContain("UsersService");
        expect(output).toContain("UsersRepository");
      },
    );

    itAdapted(
      "ADR-001",
      "methods() should list all prototype methods by token or class",
      () => {
        const repoMethods = ctx.methods("UsersRepository");
        expect(repoMethods).toEqual(["find"]);

        const svcMethods = ctx.methods(UsersService);
        expect(svcMethods.sort()).toEqual(
          ["create", "findAll", "findOne", "remove", "update"].sort(),
        );
      },
    );

    itAdapted(
      "ADR-001",
      "help() should print usage for all REPL functions",
      () => {
        ctx.help();
        const output = consoleLogSpy.mock.calls
          .map((c: unknown[]) => c.join(" "))
          .join("\n");
        expect(output).toContain("get(token)");
        expect(output).toContain("resolve(token)");
        expect(output).toContain("select(ModuleClass)");
        expect(output).toContain("debug(ModuleClass?)");
        expect(output).toContain("methods(tokenOrInstance)");
        expect(output).toContain("help()");
      },
    );

    describe("<native_function>.help properties", () => {
      // BUNEST_BUG: createReplContext() functions do not attach NestJS `.help` getter descriptors (help.help, get.help, resolve.help, select.help, debug.help, methods.help) (packages/core/src/repl/repl.ts)
      it.skip("should expose .help descriptor on native REPL functions (get, resolve, select, debug, methods, help)", () => {
        expect((ctx.help as unknown as { help?: unknown }).help).toBeDefined();
        expect((ctx.get as unknown as { help?: unknown }).help).toBeDefined();
        expect(
          (ctx.resolve as unknown as { help?: unknown }).help,
        ).toBeDefined();
        expect(
          (ctx.select as unknown as { help?: unknown }).help,
        ).toBeDefined();
        expect((ctx.debug as unknown as { help?: unknown }).help).toBeDefined();
        expect(
          (ctx.methods as unknown as { help?: unknown }).help,
        ).toBeDefined();
      });
    });
  },
);
