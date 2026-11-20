import type { SchematicType } from "../types";
import type { PlannedFile } from "../utils/fs-writer";
import type { ParsedSchematicName } from "../utils/naming";
import { buildProjectTemplateFiles } from "./project.templates";

export const SCHEMATIC_ALIASES: Readonly<Record<string, SchematicType>> = {
  application: "application",
  class: "class",
  cl: "class",
  configuration: "configuration",
  config: "configuration",
  controller: "controller",
  co: "controller",
  decorator: "decorator",
  d: "decorator",
  dto: "dto",
  endpoint: "endpoint",
  ep: "endpoint",
  filter: "filter",
  f: "filter",
  gateway: "gateway",
  ga: "gateway",
  guard: "guard",
  gu: "guard",
  interceptor: "interceptor",
  itc: "interceptor",
  in: "interceptor",
  interface: "interface",
  itf: "interface",
  library: "library",
  lib: "library",
  middleware: "middleware",
  mi: "middleware",
  module: "module",
  mo: "module",
  pipe: "pipe",
  pi: "pipe",
  provider: "provider",
  pr: "provider",
  resolver: "resolver",
  r: "resolver",
  resource: "resource",
  res: "resource",
  service: "service",
  s: "service",
  "sub-app": "sub-app",
  app: "sub-app",
};

export function resolveSchematicType(input: string): SchematicType {
  const normalized = input.trim().toLowerCase();
  const resolved = SCHEMATIC_ALIASES[normalized];
  if (!resolved) {
    const supported = [
      "application",
      "class (cl)",
      "configuration (config)",
      "controller (co)",
      "decorator (d)",
      "dto",
      "endpoint (ep)",
      "filter (f)",
      "gateway (ga)",
      "guard (gu)",
      "interceptor (itc, in)",
      "interface (itf)",
      "library (lib)",
      "middleware (mi)",
      "module (mo)",
      "pipe (pi)",
      "provider (pr)",
      "resolver (r)",
      "resource (res)",
      "service (s)",
      "sub-app (app)",
    ].join(", ");
    throw new Error(
      `Unknown schematic "${input}". Supported schematics: ${supported}.`,
    );
  }
  return resolved;
}

function joinRel(...parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join("/");
}

/**
 * Generates TypeScript source (and optional `bun:test` spec) files for a
 * requested schematic. All templates strictly obey `verbatimModuleSyntax: true`
 * (`import type` for interfaces, value imports for DI/DTO classes).
 */
export function buildSchematicFiles(
  schematic: SchematicType,
  parsed: ParsedSchematicName,
  options: { flat: boolean; spec: boolean; specFileSuffix?: string },
): PlannedFile[] {
  const { subDir, kebab, pascal, camel } = parsed;
  const { flat, spec } = options;
  const specSuffix = (options.specFileSuffix ?? "spec").replace(/^\.+/, "");
  const folder = flat ? subDir : joinRel(subDir, kebab);

  const files: PlannedFile[] = [];

  switch (schematic) {
    case "controller": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.controller.ts`),
        content: `import { Controller, Get } from "@bunest/core";

@Controller("/${kebab}")
export class ${pascal}Controller {
  @Get()
  findAll(): { resource: string; items: unknown[] } {
    return { resource: "${kebab}", items: [] };
  }
}
`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(folder, `${kebab}.controller.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { ${pascal}Controller } from "./${kebab}.controller";

describe("${pascal}Controller", () => {
  it("handles GET /${kebab}", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [${pascal}Controller],
    }).compile();

    const client = moduleRef.createTestClient();
    try {
      const res = await client.get("/${kebab}");
      res.expectStatus(200);
      expect(await res.json()).toEqual({ resource: "${kebab}", items: [] });
    } finally {
      await moduleRef.close();
    }
  });
});
`,
        });
      }
      break;
    }

    case "service": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.service.ts`),
        content: `import { Injectable } from "@bunest/core";

@Injectable()
export class ${pascal}Service {
  getStatus(): string {
    return "${kebab}:ok";
  }
}
`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(folder, `${kebab}.service.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { ${pascal}Service } from "./${kebab}.service";

describe("${pascal}Service", () => {
  it("resolves from DI container", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [${pascal}Service],
    }).compile();

    const service = moduleRef.get(${pascal}Service);
    expect(service.getStatus()).toBe("${kebab}:ok");
    await moduleRef.close();
  });
});
`,
        });
      }
      break;
    }

    case "module": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.module.ts`),
        content: `import { Module } from "@bunest/core";

@Module({
  imports: [],
  controllers: [],
  providers: [],
  exports: [],
})
export class ${pascal}Module {}
`,
      });
      break;
    }

    case "dto": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.dto.ts`),
        content: `import { IsOptional, IsString, MinLength } from "class-validator";

export class ${pascal}Dto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;
}
`,
      });
      break;
    }

    case "class": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.ts`),
        content: `export class ${pascal} {}
`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(folder, `${kebab}.${specSuffix}.ts`),
          content: `import { describe, expect, it } from "bun:test";
import { ${pascal} } from "./${kebab}";

describe("${pascal}", () => {
  it("should be defined", () => {
    expect(new ${pascal}()).toBeDefined();
  });
});
`,
        });
      }
      break;
    }

    case "interface": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.interface.ts`),
        content: `export interface ${pascal} {}
`,
      });
      break;
    }

    case "decorator": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.decorator.ts`),
        content: `import { SetMetadata } from "@bunest/core";

export const ${pascal.toUpperCase()}_KEY = "${kebab}";

export const ${pascal} = (...args: string[]) =>
  SetMetadata(${pascal.toUpperCase()}_KEY, args);
`,
      });
      break;
    }

    case "provider": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.ts`),
        content: `import { Injectable } from "@bunest/core";

@Injectable()
export class ${pascal} {}
`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(folder, `${kebab}.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { ${pascal} } from "./${kebab}";

describe("${pascal}", () => {
  it("resolves provider from DI container", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [${pascal}],
    }).compile();

    expect(moduleRef.get(${pascal})).toBeInstanceOf(${pascal});
    await moduleRef.close();
  });
});
`,
        });
      }
      break;
    }

    case "gateway": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.gateway.ts`),
        content: `import {
  SubscribeMessage,
  WebSocketGateway,
} from "@bunest/websockets";

@WebSocketGateway()
export class ${pascal}Gateway {
  @SubscribeMessage("message")
  handleMessage(_client: unknown, payload: unknown): unknown {
    return payload;
  }
}
`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(folder, `${kebab}.gateway.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { ${pascal}Gateway } from "./${kebab}.gateway";

describe("${pascal}Gateway", () => {
  it("echoes incoming message payload", () => {
    const gateway = new ${pascal}Gateway();
    expect(gateway.handleMessage({}, { message: "hello world" })).toEqual({
      message: "hello world",
    });
  });
});
`,
        });
      }
      break;
    }

    case "resolver": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.resolver.ts`),
        content: `import { Query, Resolver } from "@bunest/graphql";

@Resolver()
export class ${pascal}Resolver {
  @Query(() => String)
  ${camel}(): string {
    return "${kebab}:ok";
  }
}
`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(folder, `${kebab}.resolver.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { ${pascal}Resolver } from "./${kebab}.resolver";

describe("${pascal}Resolver", () => {
  it("resolves query field", () => {
    const resolver = new ${pascal}Resolver();
    expect(resolver.${camel}()).toBe("${kebab}:ok");
  });
});
`,
        });
      }
      break;
    }

    case "configuration": {
      const configJson = {
        collection: "@bunest/schematics",
        sourceRoot: "src",
        entryFile: "main",
        compilerOptions: {
          deleteOutDir: true,
          assets: [],
          plugins: [],
        },
        generateOptions: {
          spec: true,
          flat: false,
          specFileSuffix: "spec",
        },
      };
      files.push({
        relativePath: joinRel(subDir, "bunest.json"),
        content: `${JSON.stringify(configJson, null, 2)}\n`,
      });
      break;
    }

    case "library": {
      const libRoot = joinRel(subDir, "libs", kebab);
      const libSrc = joinRel(libRoot, "src");
      files.push({
        relativePath: joinRel(libSrc, "index.ts"),
        content: `export { ${pascal}Module } from "./${kebab}.module";
export { ${pascal}Service } from "./${kebab}.service";
`,
      });
      files.push({
        relativePath: joinRel(libSrc, `${kebab}.service.ts`),
        content: `import { Injectable } from "@bunest/core";

@Injectable()
export class ${pascal}Service {
  getLibraryName(): string {
    return "${kebab}";
  }
}
`,
      });
      files.push({
        relativePath: joinRel(libSrc, `${kebab}.module.ts`),
        content: `import { Module } from "@bunest/core";
import { ${pascal}Service } from "./${kebab}.service";

@Module({
  providers: [${pascal}Service],
  exports: [${pascal}Service],
})
export class ${pascal}Module {}
`,
      });
      files.push({
        relativePath: joinRel(libRoot, "tsconfig.lib.json"),
        content: `${JSON.stringify(
          {
            extends: "../../tsconfig.json",
            compilerOptions: {
              declaration: true,
              outDir: `../../dist/libs/${kebab}`,
            },
            include: ["src/**/*"],
            exclude: ["node_modules", "dist", "test", "**/*spec.ts"],
          },
          null,
          2,
        )}\n`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(libSrc, `${kebab}.service.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { ${pascal}Service } from "./${kebab}.service";

describe("${pascal}Service", () => {
  it("resolves library service", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [${pascal}Service],
    }).compile();

    expect(moduleRef.get(${pascal}Service).getLibraryName()).toBe("${kebab}");
    await moduleRef.close();
  });
});
`,
        });
      }
      break;
    }

    case "sub-app": {
      const appRoot = joinRel(subDir, "apps", kebab);
      const appSrc = joinRel(appRoot, "src");
      files.push({
        relativePath: joinRel(appSrc, "main.ts"),
        content: `import "reflect-metadata";
import { BunestFactory } from "@bunest/core";
import { ${pascal}Module } from "./${kebab}.module";

async function bootstrap(): Promise<void> {
  const app = await BunestFactory.create(${pascal}Module);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

await bootstrap();
`,
      });
      files.push({
        relativePath: joinRel(appSrc, `${kebab}.service.ts`),
        content: `import { Injectable } from "@bunest/core";

@Injectable()
export class ${pascal}Service {
  getHello(): string {
    return "Hello from ${kebab}!";
  }
}
`,
      });
      files.push({
        relativePath: joinRel(appSrc, `${kebab}.controller.ts`),
        content: `import { Controller, Get } from "@bunest/core";
import { ${pascal}Service } from "./${kebab}.service";

@Controller()
export class ${pascal}Controller {
  constructor(private readonly ${camel}Service: ${pascal}Service) {}

  @Get()
  getHello(): string {
    return this.${camel}Service.getHello();
  }
}
`,
      });
      files.push({
        relativePath: joinRel(appSrc, `${kebab}.module.ts`),
        content: `import { Module } from "@bunest/core";
import { ${pascal}Controller } from "./${kebab}.controller";
import { ${pascal}Service } from "./${kebab}.service";

@Module({
  controllers: [${pascal}Controller],
  providers: [${pascal}Service],
})
export class ${pascal}Module {}
`,
      });
      files.push({
        relativePath: joinRel(appRoot, "tsconfig.app.json"),
        content: `${JSON.stringify(
          {
            extends: "../../tsconfig.json",
            compilerOptions: {
              outDir: `../../dist/apps/${kebab}`,
            },
            include: ["src/**/*"],
            exclude: ["node_modules", "dist", "test", "**/*spec.ts"],
          },
          null,
          2,
        )}\n`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(appSrc, `${kebab}.controller.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { ${pascal}Module } from "./${kebab}.module";

describe("${pascal}Controller", () => {
  it("responds to GET /", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [${pascal}Module],
    }).compile();

    const client = moduleRef.createTestClient();
    try {
      const res = await client.get("/");
      res.expectStatus(200);
      expect(await res.text()).toBe("Hello from ${kebab}!");
    } finally {
      await moduleRef.close();
    }
  });
});
`,
        });
      }
      break;
    }

    case "application": {
      const appFolder = flat ? subDir : joinRel(subDir, kebab);
      const templateFiles = buildProjectTemplateFiles(kebab);
      for (const f of templateFiles) {
        files.push({
          relativePath: joinRel(appFolder, f.relativePath),
          content: f.content,
        });
      }
      break;
    }

    case "guard": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.guard.ts`),
        content: `import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";

@Injectable()
export class ${pascal}Guard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(folder, `${kebab}.guard.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { createMockExecutionContext } from "@bunest/testing";
import { ${pascal}Guard } from "./${kebab}.guard";

describe("${pascal}Guard", () => {
  it("allows request by default", () => {
    const guard = new ${pascal}Guard();
    const ctx = createMockExecutionContext();
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
`,
        });
      }
      break;
    }

    case "pipe": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.pipe.ts`),
        content: `import {
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from "@bunest/core";

@Injectable()
export class ${pascal}Pipe<T = unknown> implements PipeTransform<T, T> {
  transform(value: T, _metadata: ArgumentMetadata): T {
    return value;
  }
}
`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(folder, `${kebab}.pipe.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { ${pascal}Pipe } from "./${kebab}.pipe";

describe("${pascal}Pipe", () => {
  it("transforms input value", () => {
    const pipe = new ${pascal}Pipe<string>();
    expect(pipe.transform("hello", { type: "body" })).toBe("hello");
  });
});
`,
        });
      }
      break;
    }

    case "interceptor": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.interceptor.ts`),
        content: `import {
  Injectable,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/core";

@Injectable()
export class ${pascal}Interceptor<T = unknown>
  implements BunestInterceptor<T, T>
{
  async intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Promise<T> {
    return await next.handle();
  }
}
`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(folder, `${kebab}.interceptor.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  createMockCallHandler,
  createMockExecutionContext,
} from "@bunest/testing";
import { ${pascal}Interceptor } from "./${kebab}.interceptor";

describe("${pascal}Interceptor", () => {
  it("passes through handler result", async () => {
    const interceptor = new ${pascal}Interceptor<string>();
    const ctx = createMockExecutionContext();
    const next = createMockCallHandler("ok");
    expect(await interceptor.intercept(ctx, next)).toBe("ok");
    expect(next.called).toBe(true);
  });
});
`,
        });
      }
      break;
    }

    case "filter": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.filter.ts`),
        content: `import {
  Catch,
  HttpException,
  Injectable,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@bunest/core";

@Catch(HttpException)
@Injectable()
export class ${pascal}Filter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost): Response {
    const req = host.switchToHttp().getRequest<Request>();
    const payload = exception.toJSON();
    return Response.json(
      {
        ...payload,
        path: new URL(req.url).pathname,
        timestamp: new Date().toISOString(),
      },
      { status: exception.getStatus(), headers: exception.getHeaders() },
    );
  }
}
`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(folder, `${kebab}.filter.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { BadRequestException } from "@bunest/core";
import {
  createMockExecutionContext,
  createMockRequest,
} from "@bunest/testing";
import { ${pascal}Filter } from "./${kebab}.filter";

describe("${pascal}Filter", () => {
  it("formats HttpException responses", async () => {
    const filter = new ${pascal}Filter();
    const host = createMockExecutionContext({
      request: createMockRequest("/${kebab}"),
    });
    const res = filter.catch(new BadRequestException("invalid input"), host);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { path: string; message: string };
    expect(body.path).toBe("/${kebab}");
    expect(body.message).toBe("invalid input");
  });
});
`,
        });
      }
      break;
    }

    case "middleware": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.middleware.ts`),
        content: `import {
  Injectable,
  type BunestMiddleware,
  type NextFunction,
  type ResponseContext,
} from "@bunest/core";

@Injectable()
export class ${pascal}Middleware implements BunestMiddleware {
  async use(
    _req: Request,
    _res: ResponseContext,
    next: NextFunction,
  ): Promise<Response | void> {
    return await next();
  }
}
`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(folder, `${kebab}.middleware.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { HttpResponseContext } from "@bunest/core";
import { createMockRequest } from "@bunest/testing";
import { ${pascal}Middleware } from "./${kebab}.middleware";

describe("${pascal}Middleware", () => {
  it("invokes next()", async () => {
    const middleware = new ${pascal}Middleware();
    let called = false;
    await middleware.use(
      createMockRequest("/${kebab}"),
      new HttpResponseContext(),
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);
  });
});
`,
        });
      }
      break;
    }

    case "endpoint": {
      files.push({
        relativePath: joinRel(folder, `${kebab}.endpoint.ts`),
        content: `import { Body, Controller, Post } from "@bunest/core";
import { IsString, MinLength } from "class-validator";

export class ${pascal}RequestDto {
  @IsString()
  @MinLength(1)
  name!: string;
}

@Controller("/${kebab}")
export class ${pascal}Endpoint {
  @Post()
  handle(@Body() dto: ${pascal}RequestDto): { ok: true; name: string } {
    return { ok: true, name: dto.name };
  }
}
`,
      });
      if (spec) {
        files.push({
          relativePath: joinRel(folder, `${kebab}.endpoint.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { ValidationPipe } from "@bunest/core";
import { Test } from "@bunest/testing";
import { ${pascal}Endpoint } from "./${kebab}.endpoint";

describe("${pascal}Endpoint", () => {
  it("validates payload and responds 201", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [${pascal}Endpoint],
    }).compile();

    const app = moduleRef.createBunestApplication();
    app.useGlobalPipes(new ValidationPipe());
    const client = moduleRef.createTestClient(app);

    try {
      const res = await client.post("/${kebab}", { json: { name: "Bunest" } });
      res.expectStatus(201);
      expect(await res.json()).toEqual({ ok: true, name: "Bunest" });
    } finally {
      await moduleRef.close();
    }
  });
});
`,
        });
      }
      break;
    }

    case "resource": {
      const dtoDir = flat ? folder : joinRel(folder, "dto");
      const dtoImportPrefix = flat ? "." : "./dto";

      files.push({
        relativePath: joinRel(dtoDir, `create-${kebab}.dto.ts`),
        content: `import { IsOptional, IsString, MinLength } from "class-validator";

export class Create${pascal}Dto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;
}
`,
      });

      files.push({
        relativePath: joinRel(dtoDir, `update-${kebab}.dto.ts`),
        content: `import { IsOptional, IsString, MinLength } from "class-validator";

export class Update${pascal}Dto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
`,
      });

      files.push({
        relativePath: joinRel(folder, `${kebab}.service.ts`),
        content: `import { Injectable, NotFoundException } from "@bunest/core";
import type { Create${pascal}Dto } from "${dtoImportPrefix}/create-${kebab}.dto";
import type { Update${pascal}Dto } from "${dtoImportPrefix}/update-${kebab}.dto";

export interface ${pascal}Record {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

@Injectable()
export class ${pascal}Service {
  private readonly items = new Map<string, ${pascal}Record>();
  private seq = 0;

  create(dto: Create${pascal}Dto): ${pascal}Record {
    const id = \`${kebab}_\${++this.seq}\`;
    const record: ${pascal}Record = {
      id,
      name: dto.name,
      description: dto.description,
    };
    this.items.set(id, record);
    return record;
  }

  findAll(): ${pascal}Record[] {
    return [...this.items.values()];
  }

  findOne(id: string): ${pascal}Record {
    const found = this.items.get(id);
    if (!found) {
      throw new NotFoundException(\`${pascal} "\${id}" not found\`);
    }
    return found;
  }

  update(id: string, dto: Update${pascal}Dto): ${pascal}Record {
    const existing = this.findOne(id);
    const updated: ${pascal}Record = {
      ...existing,
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
    };
    this.items.set(id, updated);
    return updated;
  }

  remove(id: string): void {
    this.findOne(id);
    this.items.delete(id);
  }
}
`,
      });

      files.push({
        relativePath: joinRel(folder, `${kebab}.controller.ts`),
        content: `import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from "@bunest/core";
import { Create${pascal}Dto } from "${dtoImportPrefix}/create-${kebab}.dto";
import { Update${pascal}Dto } from "${dtoImportPrefix}/update-${kebab}.dto";
import { ${pascal}Service, type ${pascal}Record } from "./${kebab}.service";

@Controller("/${kebab}")
export class ${pascal}Controller {
  constructor(private readonly ${camel}Service: ${pascal}Service) {}

  @Post()
  create(@Body() dto: Create${pascal}Dto): ${pascal}Record {
    return this.${camel}Service.create(dto);
  }

  @Get()
  findAll(): ${pascal}Record[] {
    return this.${camel}Service.findAll();
  }

  @Get(":id")
  findOne(@Param("id") id: string): ${pascal}Record {
    return this.${camel}Service.findOne(id);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() dto: Update${pascal}Dto,
  ): ${pascal}Record {
    return this.${camel}Service.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id") id: string): void {
    this.${camel}Service.remove(id);
  }
}
`,
      });

      files.push({
        relativePath: joinRel(folder, `${kebab}.module.ts`),
        content: `import { Module } from "@bunest/core";
import { ${pascal}Controller } from "./${kebab}.controller";
import { ${pascal}Service } from "./${kebab}.service";

@Module({
  controllers: [${pascal}Controller],
  providers: [${pascal}Service],
  exports: [${pascal}Service],
})
export class ${pascal}Module {}
`,
      });

      if (spec) {
        files.push({
          relativePath: joinRel(folder, `${kebab}.${specSuffix}.ts`),
          content: `import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { ValidationPipe } from "@bunest/core";
import { Test } from "@bunest/testing";
import { ${pascal}Module } from "./${kebab}.module";
import type { ${pascal}Record } from "./${kebab}.service";

describe("${pascal}Module CRUD", () => {
  it("supports create, list, get, update, and delete", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [${pascal}Module],
    }).compile();

    const app = moduleRef.createBunestApplication();
    app.useGlobalPipes(new ValidationPipe());
    const client = moduleRef.createTestClient(app);

    try {
      const createdRes = await client.post("/${kebab}", {
        json: { name: "First Item", description: "Initial" },
      });
      createdRes.expectStatus(201);
      const created = await createdRes.json<${pascal}Record>();
      expect(created.name).toBe("First Item");

      const listRes = await client.get("/${kebab}");
      listRes.expectStatus(200);
      expect(await listRes.json<${pascal}Record[]>()).toHaveLength(1);

      const getRes = await client.get(\`/${kebab}/\${created.id}\`);
      getRes.expectStatus(200);
      expect(await getRes.json<${pascal}Record>()).toEqual(created);

      const patchRes = await client.patch(\`/${kebab}/\${created.id}\`, {
        json: { name: "Updated Item" },
      });
      patchRes.expectStatus(200);
      expect((await patchRes.json<${pascal}Record>()).name).toBe("Updated Item");

      const delRes = await client.delete(\`/${kebab}/\${created.id}\`);
      delRes.expectStatus(204);

      const missingRes = await client.get(\`/${kebab}/\${created.id}\`);
      missingRes.expectStatus(404);
    } finally {
      await moduleRef.close();
    }
  });
});
`,
        });
      }
      break;
    }
  }

  return files;
}
