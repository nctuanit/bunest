import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  Body,
  Controller,
  Get,
  MetadataRegistry,
  Param,
  Post,
  Query,
} from "../src";
import {
  AddressDto,
  CreateSpikeUserDto,
  ImportedSpikeRepository,
  ImportedSpikeService,
  SpikeUserResult,
} from "./fixtures/spike.dto";

function PropertyMarker(): PropertyDecorator {
  return () => {};
}

@Controller("/spike-users")
class SpikeUsersController {
  @PropertyMarker()
  serviceRef!: ImportedSpikeService;

  constructor(
    public readonly service: ImportedSpikeService,
    public readonly repo: ImportedSpikeRepository,
  ) {}

  @Post()
  create(
    @Body() dto: CreateSpikeUserDto,
    @Query("notify") notify?: string,
  ): SpikeUserResult {
    return new SpikeUserResult("u_1", dto.email);
  }

  @Get(":id")
  async findOne(@Param("id") id: string): Promise<SpikeUserResult> {
    return new SpikeUserResult(id, "user@example.com");
  }
}

describe("Bun 1.4.3 Decorator Metadata Runtime Spike", () => {
  it("emits and reads design:paramtypes for constructor parameters including imported classes", () => {
    const ctorParamTypes = MetadataRegistry.getParamTypes(SpikeUsersController);
    expect(ctorParamTypes).toBeDefined();
    expect(ctorParamTypes).toEqual([
      ImportedSpikeService,
      ImportedSpikeRepository,
    ]);

    const serviceParamTypes =
      MetadataRegistry.getParamTypes(ImportedSpikeService);
    expect(serviceParamTypes).toEqual([ImportedSpikeRepository]);
  });

  it("emits and reads design:paramtypes for method parameters including imported DTO classes", () => {
    const createParamTypes = MetadataRegistry.getParamTypes(
      SpikeUsersController.prototype,
      "create",
    );
    expect(createParamTypes).toEqual([CreateSpikeUserDto, String]);

    const resolvedParams = MetadataRegistry.getRouteParameters(
      SpikeUsersController,
      "create",
    );
    expect(resolvedParams).toHaveLength(2);
    expect(resolvedParams[0]?.index).toBe(0);
    expect(resolvedParams[0]?.source).toBe("body");
    expect(resolvedParams[0]?.metatype).toBe(CreateSpikeUserDto);
    expect(resolvedParams[1]?.index).toBe(1);
    expect(resolvedParams[1]?.source).toBe("query");
    expect(resolvedParams[1]?.key).toBe("notify");
    expect(resolvedParams[1]?.metatype).toBe(String);
  });

  it("emits and reads design:type and design:returntype on decorated properties and methods", () => {
    const propType = MetadataRegistry.getType(
      SpikeUsersController.prototype,
      "serviceRef",
    );
    expect(propType).toBe(ImportedSpikeService);

    const methodType = MetadataRegistry.getType(
      SpikeUsersController.prototype,
      "create",
    );
    expect(methodType).toBe(Function);

    const syncReturnType = MetadataRegistry.getReturnType(
      SpikeUsersController.prototype,
      "create",
    );
    expect(syncReturnType).toBe(SpikeUserResult);

    const asyncReturnType = MetadataRegistry.getReturnType(
      SpikeUsersController.prototype,
      "findOne",
    );
    expect(asyncReturnType).toBe(Promise);
  });

  it("integrates design:paramtypes metatype with class-transformer and class-validator (including nested & async validators)", async () => {
    const [bodyParam] = MetadataRegistry.getRouteParameters(
      SpikeUsersController,
      "create",
    );
    const DtoClass = bodyParam?.metatype as typeof CreateSpikeUserDto;
    expect(DtoClass).toBe(CreateSpikeUserDto);

    // Valid payload with nested DTO and explicit numeric transform
    const validInstance = plainToInstance(DtoClass, {
      email: "alice@example.com",
      name: "Alice",
      age: "25",
      address: { city: "Hanoi", country: "VN" },
    });
    expect(validInstance).toBeInstanceOf(CreateSpikeUserDto);
    expect(validInstance.address).toBeInstanceOf(AddressDto);
    expect(validInstance.age).toBe(25);

    const validErrors = await validate(validInstance, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    });
    expect(validErrors).toHaveLength(0);

    // Invalid payload: blocked email (async validator), short name, age < 18, extra unknown property, invalid nested city
    const invalidInstance = plainToInstance(DtoClass, {
      email: "spam@blocked.test",
      name: "Al",
      age: "15",
      address: { city: "A", country: "VN" },
      extraField: "not-allowed",
    });

    const invalidErrors = await validate(invalidInstance, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    });

    const failedProps = invalidErrors.map((e) => e.property).sort();
    expect(failedProps).toEqual([
      "address",
      "age",
      "email",
      "extraField",
      "name",
    ]);
  });
});
