import { afterEach, describe, expect, it } from "bun:test";
import {
  dirname,
  join,
  mkdirSyncPath,
  removePath,
  writeTextSync,
} from "@bunest/core";
import { scanRouteBodyContracts } from "../src/analyzer/body-dto-scanner";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: string[] = [];

function createTempProject(files: Record<string, string>): string {
  const dir = join(
    TMP_DIR,
    `bunest-dto-scanner-${crypto.randomUUID().slice(0, 8)}`,
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

describe("scanRouteBodyContracts (Branch A: Static Body DTO Scanner)", () => {
  it("extracts literal @Min/@Max/@MinLength/@MaxLength/@IsOptional/@IsString/@IsInt with relative file and line", async () => {
    const projectDir = createTempProject({
      "src/item.dto.ts": [
        `import {`,
        `  IsInt,`,
        `  IsOptional,`,
        `  IsString,`,
        `  Max,`,
        `  MaxLength,`,
        `  Min,`,
        `  MinLength,`,
        `} from "@bunest/validation/validator";`,
        ``,
        `export class CreateItemDto {`,
        `  @IsString()`,
        `  @MinLength(1)`,
        `  @MaxLength(200)`,
        `  name!: string;`,
        ``,
        `  @IsOptional()`,
        `  @IsString()`,
        `  @MaxLength(1000)`,
        `  description?: string;`,
        ``,
        `  @IsOptional()`,
        `  @IsInt()`,
        `  @Min(0)`,
        `  @Max(1_000_000)`,
        `  quantity?: number;`,
        `}`,
      ].join("\n"),
      "src/items.controller.ts": [
        `import { Body, Controller, Post } from "@bunest/core";`,
        `import { CreateItemDto } from "./item.dto";`,
        ``,
        `@Controller("orders")`,
        `export class OrdersController {`,
        `  @Post()`,
        `  create(@Body() dto: CreateItemDto) {`,
        `    return dto;`,
        `  }`,
        `}`,
      ].join("\n"),
    });

    const result = await scanRouteBodyContracts(projectDir);
    expect(result.scannedFiles).toBe(2);
    expect(result.routes).toHaveLength(1);

    const route = result.routes[0]!;
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/orders");
    expect(route.key).toBe("POST /orders");
    expect(route.controllerName).toBe("OrdersController");
    expect(route.handlerName).toBe("create");
    expect(route.routeSourceFile).toBe("src/items.controller.ts");
    expect(route.routeLine).toBe(7);
    expect(route.dtoName).toBe("CreateItemDto");
    expect(route.dtoSourceFile).toBe("src/item.dto.ts");
    expect(route.dtoLine).toBe(11);
    expect(route.dtoLocation).toEqual({
      file: "src/item.dto.ts",
      line: 11,
      endLine: 27,
    });
    expect(route.unsupportedReasons).toEqual([]);

    expect(route.fields).toEqual([
      {
        name: "name",
        tsType: "string",
        tsOptional: false,
        isOptional: false,
        constraints: { minLength: 1, maxLength: 200 },
        validators: ["IsString", "MinLength", "MaxLength"],
        sourceFile: "src/item.dto.ts",
        line: 15,
      },
      {
        name: "description",
        tsType: "string",
        tsOptional: true,
        isOptional: true,
        constraints: { maxLength: 1000 },
        validators: ["IsOptional", "IsString", "MaxLength"],
        sourceFile: "src/item.dto.ts",
        line: 20,
      },
      {
        name: "quantity",
        tsType: "number",
        tsOptional: true,
        isOptional: true,
        constraints: { min: 0, max: 1_000_000 },
        validators: ["IsOptional", "IsInt", "Min", "Max"],
        sourceFile: "src/item.dto.ts",
        line: 26,
      },
    ]);
  });

  it("resolves DTO import aliases and aliased built-in validation decorators", async () => {
    const projectDir = createTempProject({
      "src/dto/item.dto.ts": [
        `import {`,
        `  Min as MinQty,`,
        `  Max as MaxQty,`,
        `  IsInt as IntegerCheck,`,
        `  IsOptional as Opt,`,
        `} from "@bunest/validation/validator";`,
        ``,
        `export class CreateItemDto {`,
        `  @Opt()`,
        `  @IntegerCheck()`,
        `  @MinQty(1)`,
        `  @MaxQty(50)`,
        `  quantity?: number;`,
        `}`,
      ].join("\n"),
      "src/orders.controller.ts": [
        `import { Body, Controller, Post } from "@bunest/core";`,
        `import { CreateItemDto as ItemPayload } from "./dto/item.dto";`,
        ``,
        `@Controller("orders")`,
        `export class OrdersController {`,
        `  @Post("create")`,
        `  create(@Body() payload: ItemPayload) {`,
        `    return payload;`,
        `  }`,
        `}`,
      ].join("\n"),
    });

    const result = await scanRouteBodyContracts(projectDir);
    expect(result.routes).toHaveLength(1);

    const route = result.routes[0]!;
    expect(route.key).toBe("POST /orders/create");
    expect(route.dtoName).toBe("CreateItemDto");
    expect(route.dtoSourceFile).toBe("src/dto/item.dto.ts");
    expect(route.unsupportedReasons).toEqual([]);
    expect(route.fields).toHaveLength(1);
    expect(route.fields[0]).toEqual({
      name: "quantity",
      tsType: "number",
      tsOptional: true,
      isOptional: true,
      constraints: { min: 1, max: 50 },
      validators: ["IsOptional", "IsInt", "Min", "Max"],
      sourceFile: "src/dto/item.dto.ts",
      line: 13,
    });
  });

  it("preserves full DTO metadata when a single DTO serves multiple routes", async () => {
    const projectDir = createTempProject({
      "src/shared.dto.ts": [
        `import { IsString, MinLength, Min } from "@bunest/validation";`,
        ``,
        `export class UpsertOrderDto {`,
        `  @IsString()`,
        `  @MinLength(2)`,
        `  name!: string;`,
        ``,
        `  @Min(1)`,
        `  quantity!: number;`,
        `}`,
      ].join("\n"),
      "src/orders.controller.ts": [
        `import { Body, Controller, Post, Put } from "@bunest/core";`,
        `import { UpsertOrderDto } from "./shared.dto";`,
        ``,
        `@Controller("orders")`,
        `export class OrdersController {`,
        `  @Post()`,
        `  create(@Body() body: UpsertOrderDto) {`,
        `    return body;`,
        `  }`,
        ``,
        `  @Put(":id")`,
        `  replace(@Body() body: UpsertOrderDto) {`,
        `    return body;`,
        `  }`,
        `}`,
      ].join("\n"),
    });

    const result = await scanRouteBodyContracts(projectDir);
    expect(result.routes).toHaveLength(2);

    const postRoute = result.routes.find((r) => r.key === "POST /orders")!;
    const putRoute = result.routes.find((r) => r.key === "PUT /orders/:id")!;

    expect(postRoute).toBeDefined();
    expect(putRoute).toBeDefined();

    expect(postRoute.dtoName).toBe("UpsertOrderDto");
    expect(putRoute.dtoName).toBe("UpsertOrderDto");
    expect(postRoute.dtoSourceFile).toBe("src/shared.dto.ts");
    expect(putRoute.dtoSourceFile).toBe("src/shared.dto.ts");
    expect(postRoute.dtoLocation).toEqual(putRoute.dtoLocation);
    expect(postRoute.fields).toEqual(putRoute.fields);
    expect(postRoute.fields).toHaveLength(2);
    expect(postRoute.fields[1]!.constraints.min).toBe(1);
  });

  it("produces identical field constraints when a DTO class is renamed", async () => {
    const baseDir = createTempProject({
      "src/item.dto.ts": [
        `import { IsInt, Min, Max } from "@bunest/validation/validator";`,
        `export class CreateItemDto {`,
        `  @IsInt()`,
        `  @Min(0)`,
        `  @Max(100)`,
        `  quantity!: number;`,
        `}`,
      ].join("\n"),
      "src/orders.controller.ts": [
        `import { Body, Controller, Post } from "@bunest/core";`,
        `import { CreateItemDto } from "./item.dto";`,
        `@Controller("orders")`,
        `export class OrdersController {`,
        `  @Post()`,
        `  create(@Body() body: CreateItemDto) { return body; }`,
        `}`,
      ].join("\n"),
    });

    const renamedDir = createTempProject({
      "src/item.dto.ts": [
        `import { IsInt, Min, Max } from "@bunest/validation/validator";`,
        `export class OrderLinePayloadDto {`,
        `  @IsInt()`,
        `  @Min(0)`,
        `  @Max(100)`,
        `  quantity!: number;`,
        `}`,
      ].join("\n"),
      "src/orders.controller.ts": [
        `import { Body, Controller, Post } from "@bunest/core";`,
        `import { OrderLinePayloadDto } from "./item.dto";`,
        `@Controller("orders")`,
        `export class OrdersController {`,
        `  @Post()`,
        `  create(@Body() body: OrderLinePayloadDto) { return body; }`,
        `}`,
      ].join("\n"),
    });

    const baseResult = await scanRouteBodyContracts(baseDir);
    const renamedResult = await scanRouteBodyContracts(renamedDir);

    expect(baseResult.routes[0]!.dtoName).toBe("CreateItemDto");
    expect(renamedResult.routes[0]!.dtoName).toBe("OrderLinePayloadDto");
    expect(renamedResult.routes[0]!.fields).toEqual(baseResult.routes[0]!.fields);
  });

  it("ignores 3rd-party same-named @Min(99) imported from ./fake-validator and records it as custom-validator", async () => {
    const projectDir = createTempProject({
      "src/fake-validator.ts": [
        `export function Min(_n: number): PropertyDecorator {`,
        `  return () => {};`,
        `}`,
      ].join("\n"),
      "src/item.dto.ts": [
        `import { IsInt } from "@bunest/validation/validator";`,
        `import { Min } from "./fake-validator";`,
        ``,
        `export class CreateItemDto {`,
        `  @IsInt()`,
        `  @Min(99)`,
        `  quantity!: number;`,
        `}`,
      ].join("\n"),
      "src/orders.controller.ts": [
        `import { Body, Controller, Post } from "@bunest/core";`,
        `import { CreateItemDto } from "./item.dto";`,
        ``,
        `@Controller("orders")`,
        `export class OrdersController {`,
        `  @Post()`,
        `  create(@Body() body: CreateItemDto) {`,
        `    return body;`,
        `  }`,
        `}`,
      ].join("\n"),
    });

    const result = await scanRouteBodyContracts(projectDir);
    expect(result.routes).toHaveLength(1);

    const route = result.routes[0]!;
    const qtyField = route.fields.find((f) => f.name === "quantity")!;
    expect(qtyField.validators).toEqual(["IsInt"]);
    expect(qtyField.constraints).toEqual({});
    expect(qtyField.constraints.min).toBeUndefined();

    expect(route.unsupportedReasons).toHaveLength(1);
    expect(route.unsupportedReasons[0]!.kind).toBe("custom-validator");
    expect(route.unsupportedReasons[0]!.field).toBe("quantity");
    expect(route.unsupportedReasons[0]!.reason).toContain("./fake-validator");
    expect(route.unsupportedReasons[0]!.sourceFile).toBe("src/item.dto.ts");
    expect(route.unsupportedReasons[0]!.line).toBe(6);
  });

  it("records explicit unsupportedReasons for groups, @Transform, @ValidateNested, PartialType, non-literal @Min, and dynamic pipes", async () => {
    const projectDir = createTempProject({
      "src/limits.ts": `export const MIN_QTY = 5;`,
      "src/address.dto.ts": [
        `import { IsString } from "@bunest/validation/validator";`,
        `export class AddressDto {`,
        `  @IsString()`,
        `  street!: string;`,
        `}`,
      ].join("\n"),
      "src/complex.dto.ts": [
        `import { IsString, Min, ValidateNested } from "class-validator";`,
        `import { Transform } from "class-transformer";`,
        `import { MIN_QTY } from "./limits";`,
        `import { AddressDto } from "./address.dto";`,
        ``,
        `export class BaseOrderDto {`,
        `  @IsString({ groups: ["admin"] })`,
        `  code!: string;`,
        ``,
        `  @Transform(({ value }) => Number(value))`,
        `  @Min(MIN_QTY)`,
        `  quantity!: number;`,
        ``,
        `  @ValidateNested()`,
        `  address!: AddressDto;`,
        `}`,
      ].join("\n"),
      "src/partial.dto.ts": [
        `import { PartialType } from "@bunest/openapi";`,
        `import { BaseOrderDto } from "./complex.dto";`,
        ``,
        `export class UpdateOrderDto extends PartialType(BaseOrderDto) {}`,
      ].join("\n"),
      "src/orders.controller.ts": [
        `import { Body, Controller, Patch, Post, UsePipes, ValidationPipe } from "@bunest/core";`,
        `import { BaseOrderDto } from "./complex.dto";`,
        `import { UpdateOrderDto } from "./partial.dto";`,
        ``,
        `const dynamicPipeOptions = { whitelist: true };`,
        ``,
        `@Controller("orders")`,
        `export class OrdersController {`,
        `  @Post()`,
        `  @UsePipes(new ValidationPipe(dynamicPipeOptions))`,
        `  create(@Body() body: BaseOrderDto) {`,
        `    return body;`,
        `  }`,
        ``,
        `  @Patch(":id")`,
        `  update(@Body() body: UpdateOrderDto) {`,
        `    return body;`,
        `  }`,
        `}`,
      ].join("\n"),
    });

    const result = await scanRouteBodyContracts(projectDir);
    expect(result.routes).toHaveLength(2);

    const createRoute = result.routes.find((r) => r.key === "POST /orders")!;
    const createKinds = createRoute.unsupportedReasons.map((r) => r.kind);
    expect(createKinds).toContain("validation-groups");
    expect(createKinds).toContain("transform");
    expect(createKinds).toContain("non-literal-arg");
    expect(createKinds).toContain("nested-dto");
    expect(createKinds).toContain("dynamic-pipe");

    const groupsReason = createRoute.unsupportedReasons.find(
      (r) => r.kind === "validation-groups",
    )!;
    expect(groupsReason.field).toBe("code");
    expect(groupsReason.sourceFile).toBe("src/complex.dto.ts");

    const nonLiteralReason = createRoute.unsupportedReasons.find(
      (r) => r.kind === "non-literal-arg",
    )!;
    expect(nonLiteralReason.field).toBe("quantity");
    expect(nonLiteralReason.reason).toContain("MIN_QTY");

    const transformReason = createRoute.unsupportedReasons.find(
      (r) => r.kind === "transform",
    )!;
    expect(transformReason.field).toBe("quantity");

    const nestedReason = createRoute.unsupportedReasons.find(
      (r) => r.kind === "nested-dto",
    )!;
    expect(nestedReason.field).toBe("address");

    const patchRoute = result.routes.find((r) => r.key === "PATCH /orders/:id")!;
    expect(patchRoute.unsupportedReasons.map((r) => r.kind)).toContain(
      "mapped-type",
    );
  });
});
