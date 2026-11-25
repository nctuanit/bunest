import type { PlannedFile } from "../utils/fs-writer";

export interface ProjectTemplateOptions {
  readonly strict?: boolean;
  readonly spec?: boolean;
  readonly specFileSuffix?: string;
  readonly minimal?: boolean;
}

/**
 * Generates the complete set of files for `bunest new <project-name>`.
 * Matches Bun 1.4.5 empirically verified `tsconfig.json` and `verbatimModuleSyntax: true` rules.
 */
export function buildProjectTemplateFiles(
  projectName: string,
  options: ProjectTemplateOptions = {},
): PlannedFile[] {
  const strict = options.strict ?? true;
  const spec = options.spec ?? true;
  const specSuffix =
    (options.specFileSuffix ?? "spec").replace(/^\.+/, "") || "spec";
  const minimal = options.minimal ?? false;

  const packageJson = {
    name: projectName,
    version: "0.1.0",
    private: true,
    type: "module",
    engines: {
      bun: ">=1.4.5",
    },
    scripts: {
      dev: "bunest dev",
      typegen: "bunest typegen",
      build:
        "bun build ./src/main.ts --outdir ./dist --target bun --format esm",
      start: "bun dist/main.js",
      test: "bun test",
      typecheck: "bun check",
      verify: "bunest verify --reporter=agent",
    },
    dependencies: {
      "@bunest/core": "^0.1.0",
      "@bunest/validation": "^0.1.0",
    },
    devDependencies: {
      "@bunest/cli": "^0.1.0",
      "@bunest/testing": "^0.1.0",
      "@types/bun": "latest",
      typescript: "^7.0.2",
    },
  };

  const tsconfigJson = {
    compilerOptions: {
      lib: ["ESNext"],
      target: "ESNext",
      module: "Preserve",
      moduleDetection: "force",
      moduleResolution: "bundler",
      types: ["bun"],
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      verbatimModuleSyntax: true,
      strict,
      skipLibCheck: true,
      noEmit: true,
      noFallthroughCasesInSwitch: true,
      noUncheckedIndexedAccess: strict,
      noImplicitOverride: strict,
    },
    include: ["src/**/*.ts", "test/**/*.ts", ".bunest/types/**/*.d.ts"],
    exclude: ["node_modules", "dist"],
  };

  const mainTs = `import { BunestFactory, ValidationPipe } from "@bunest/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await BunestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe());
  app.enableShutdownHooks();

  const port = Number(Bun.env.PORT ?? 3000);
  const info = await app.listen(port);
  console.log(\`Bunest server listening at \${info.url}\`);
}

await bootstrap();
`;

  const appServiceTs = `import { Injectable } from "@bunest/core";

@Injectable()
export class AppService {
  getHello(): { message: string } {
    return { message: "Hello from ${projectName}!" };
  }

  getHealth(): { status: "ok"; runtime: string } {
    return { status: "ok", runtime: \`Bun \${Bun.version}\` };
  }
}
`;

  const appControllerTs = `import { Controller, Get } from "@bunest/core";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): { message: string } {
    return this.appService.getHello();
  }

  @Get("health")
  getHealth(): { status: "ok"; runtime: string } {
    return this.appService.getHealth();
  }
}
`;

  const appModuleTs = `import { Module } from "@bunest/core";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";

@Module({
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
`;

  const appSpecTs = `import { describe, expect, it } from "bun:test";
import { ValidationPipe } from "@bunest/core";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";

describe("AppModule", () => {
  it("responds to GET / and GET /health", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleRef.createBunestApplication();
    app.useGlobalPipes(new ValidationPipe());
    const client = moduleRef.createTestClient(app);

    try {
      const helloRes = await client.get("/");
      helloRes.expectStatus(200);
      expect(await helloRes.json()).toEqual({
        message: "Hello from ${projectName}!",
      });

      const healthRes = await client.get("/health");
      healthRes.expectStatus(200);
      expect(
        (await healthRes.json<{ status: string }>()).status,
      ).toBe("ok");
    } finally {
      await moduleRef.close();
    }
  });
});
`;

  const agentsMd = `# AGENTS.md — ${projectName}

Instructions for AI coding agents working in this Bunest app (Bun-native, NestJS-style).

## Verify after every change

\`\`\`bash
bun run verify          # = bunest verify --reporter=agent (typecheck + bunest check + tests)
\`\`\`

Fix the first failing step, re-run, repeat until \`VERIFY PASS\`. Auto-fixable diagnostics: \`bunest check --fix\`.

## Rules

- Runtime is **Bun >= 1.4.5** only. Never import \`node:*\`, Express, Fastify, RxJS or \`reflect-metadata\`.
- Import framework APIs from \`@bunest/*\` only: \`BunestFactory\`, \`Module\`, \`Controller\`, \`Injectable\`, … from \`@bunest/core\`;
  DTO validators from \`@bunest/validation/validator\` (not \`class-validator\`).
- **Value-import** services, controllers, DTOs and entities (never \`import type\`) — DI reads runtime metadata.
  Use \`import type\` only for interfaces and type aliases.
- Interfaces/unions/generics are erased at runtime: inject them with \`@Inject(TOKEN)\`.
- Interceptors return \`Promise<T>\` (\`await next.handle()\`), not Observables.
- Prefer the generators over hand-writing boilerplate:
  \`bunest g resource <name>\`, \`bunest g service <name>\`, \`bunest g controller <name>\` (add \`--dry-run\` to preview).

## Layout

- \`src/main.ts\` bootstrap · \`src/app.module.ts\` root module · one folder per feature (\`<feature>.module.ts\`,
  \`<feature>.controller.ts\`, \`<feature>.service.ts\`, \`dto/\`).
- Tests live in \`test/\` and use \`Test.createTestingModule(...)\` + \`moduleRef.createTestClient(app)\` from \`@bunest/testing\`.

## Errors

Bootstrap errors carry a stable code (\`err.code\`, e.g. \`BUNEST_E001\` unknown dependency, \`BUNEST_E002\` circular dependency).
\`toBunestErrorReport(err)\` from \`@bunest/core\` returns the ordered fixes and docs link.
`;

  const gitignore = `node_modules/
dist/
.bunest/
/.idea
.vscode
.env
.env.local
*.log
.DS_Store
`;

  const readmeMd = `# ${projectName}

A backend application built with [Bunest](https://github.com/bunest) on native Bun.

## Getting Started

\`\`\`bash
# Run in development watch mode
bun run dev

# Run tests
bun test

# Typecheck
bun run typecheck

# Build production bundle
bun run build
\`\`\`
`;

  if (minimal) {
    const minimalMainTs = `import { BunestFactory, Controller, Get, Module } from "@bunest/core";

@Controller()
class AppController {
  @Get()
  getHello(): { message: string } {
    return { message: "Hello from ${projectName}!" };
  }
}

@Module({
  controllers: [AppController],
})
class AppModule {}

async function bootstrap(): Promise<void> {
  const app = await BunestFactory.create(AppModule);
  const port = Number(Bun.env.PORT ?? 3000);
  await app.listen(port);
}

await bootstrap();
`;
    return [
      {
        relativePath: "package.json",
        content: `${JSON.stringify(packageJson, null, 2)}\n`,
      },
      {
        relativePath: "tsconfig.json",
        content: `${JSON.stringify(tsconfigJson, null, 2)}\n`,
      },
      {
        relativePath: "src/main.ts",
        content: minimalMainTs,
      },
      {
        relativePath: ".gitignore",
        content: gitignore,
      },
    ];
  }

  const files: PlannedFile[] = [
    {
      relativePath: "package.json",
      content: `${JSON.stringify(packageJson, null, 2)}\n`,
    },
    {
      relativePath: "tsconfig.json",
      content: `${JSON.stringify(tsconfigJson, null, 2)}\n`,
    },
    {
      relativePath: "src/main.ts",
      content: mainTs,
    },
    {
      relativePath: "src/app.service.ts",
      content: appServiceTs,
    },
    {
      relativePath: "src/app.controller.ts",
      content: appControllerTs,
    },
    {
      relativePath: "src/app.module.ts",
      content: appModuleTs,
    },
  ];

  if (spec) {
    files.push({
      relativePath: `test/app.${specSuffix}.ts`,
      content: appSpecTs,
    });
  }

  files.push(
    {
      relativePath: ".gitignore",
      content: gitignore,
    },
    {
      relativePath: "README.md",
      content: readmeMd,
    },
    {
      relativePath: "AGENTS.md",
      content: agentsMd,
    },
  );

  return files;
}
