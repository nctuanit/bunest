import { describe, expect, it } from "bun:test";
import { ValidationPipe } from "../src/index";
import { Type, defaultMetadataStorage } from "../src/transformer/index";
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "../src/validator/index";

describe("@ValidateNested() enhanced DX", () => {
  class LineItemDto {
    @IsString()
    sku!: string;

    @IsInt()
    @Min(1)
    qty!: number;
  }

  class ShippingAddressDto {
    @IsString()
    street!: string;
  }

  class CreateOrderDto {
    // Single nested DTO: infers ShippingAddressDto from design:type without @Type()
    @ValidateNested()
    shipping!: ShippingAddressDto;

    // Array nested DTO: inline `type: () => LineItemDto` without separate @Type()
    @IsArray()
    @ValidateNested({ each: true, type: () => LineItemDto })
    items!: LineItemDto[];
  }

  it("instantiates single nested DTO via design:type and array elements via inline type resolver", async () => {
    const pipe = new ValidationPipe();
    const result = (await pipe.transform(
      {
        shipping: { street: "123 Nguyen Trai" },
        items: [
          { sku: "SKU-1", qty: 2 },
          { sku: "SKU-2", qty: 5 },
        ],
      },
      { type: "body", metatype: CreateOrderDto },
    )) as CreateOrderDto;

    expect(result).toBeInstanceOf(CreateOrderDto);
    expect(result.shipping).toBeInstanceOf(ShippingAddressDto);
    expect(result.shipping.street).toBe("123 Nguyen Trai");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toBeInstanceOf(LineItemDto);
    expect(result.items[1]).toBeInstanceOf(LineItemDto);
  });

  it("validates nested constraints and rejects invalid nested payloads", async () => {
    const pipe = new ValidationPipe();

    await expect(
      pipe.transform(
        {
          shipping: { street: 123 },
          items: [{ sku: "SKU-1", qty: 0 }],
        },
        { type: "body", metatype: CreateOrderDto },
      ),
    ).rejects.toThrow();
  });

  it("respects explicit @Type() regardless of decorator order (above or below @ValidateNested)", async () => {
    class DetailedAddressDto extends ShippingAddressDto {
      @IsString()
      zip!: string;
    }

    class TypeAboveDto {
      @Type(() => DetailedAddressDto)
      @ValidateNested()
      shipping!: ShippingAddressDto;
    }

    class TypeBelowDto {
      @ValidateNested()
      @Type(() => DetailedAddressDto)
      shipping!: ShippingAddressDto;
    }

    const pipe = new ValidationPipe();
    for (const Cls of [TypeAboveDto, TypeBelowDto]) {
      const res = (await pipe.transform(
        { shipping: { street: "Main St", zip: "10000" } },
        { type: "body", metatype: Cls },
      )) as TypeAboveDto;
      expect(res.shipping).toBeInstanceOf(DetailedAddressDto);
      expect((res.shipping as DetailedAddressDto).zip).toBe("10000");
    }
  });

  it("allows subclass narrowing with @ValidateNested() without being blocked by parent TypeMetadata", async () => {
    class DetailedAddressDto extends ShippingAddressDto {
      @IsString()
      zip!: string;
    }

    class BaseOrderDto {
      @ValidateNested()
      shipping!: ShippingAddressDto;
    }

    class DetailedOrderDto extends BaseOrderDto {
      @ValidateNested()
      override shipping: DetailedAddressDto =
        undefined as unknown as DetailedAddressDto;
    }

    const pipe = new ValidationPipe();
    const res = (await pipe.transform(
      { shipping: { street: "Main St", zip: "10000" } },
      { type: "body", metatype: DetailedOrderDto },
    )) as DetailedOrderDto;
    expect(res.shipping).toBeInstanceOf(DetailedAddressDto);
    expect(res.shipping.zip).toBe("10000");
  });

  it("does not auto-register @Type() for built-in non-DTO design types (URL, Uint8Array, Error)", () => {
    class BuiltinHolderDto {
      @IsOptional()
      @ValidateNested()
      endpoint?: URL;

      @IsOptional()
      @ValidateNested()
      bytes?: Uint8Array;

      @IsOptional()
      @ValidateNested()
      err?: Error;
    }

    const ownMap = defaultMetadataStorage.getOwnTypeMap(BuiltinHolderDto);
    expect(ownMap?.has("endpoint") ?? false).toBe(false);
    expect(ownMap?.has("bytes") ?? false).toBe(false);
    expect(ownMap?.has("err") ?? false).toBe(false);
  });
});
