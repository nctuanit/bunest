import { describe, expect, it } from "bun:test";
import {
  DefaultValuePipe,
  HttpException,
  HttpStatus,
  ParseArrayPipe,
  ParseBoolPipe,
  ParseEnumPipe,
  ParseFloatPipe,
  ParseIntPipe,
  ParseUUIDPipe,
} from "../../src/common";

describe("Built-in Pipes", () => {
  describe("ParseIntPipe", () => {
    const pipe = new ParseIntPipe();

    it("parses valid integers, normalizes -0 to 0, and rejects malformed input", async () => {
      expect(await pipe.transform("42")).toBe(42);
      expect(await pipe.transform("-7")).toBe(-7);
      expect(await pipe.transform("+10")).toBe(10);
      expect(await pipe.transform("0")).toBe(0);
      expect(Object.is(await pipe.transform("-0"), 0)).toBe(true);
      expect(Object.is(await pipe.transform(-0), 0)).toBe(true);
      expect(await pipe.transform(99)).toBe(99);

      for (const bad of [
        "12.5",
        "123abc",
        "",
        " ",
        "NaN",
        "Infinity",
        12.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        null,
        undefined,
        {},
        true,
      ]) {
        await expect(pipe.transform(bad)).rejects.toThrow(HttpException);
      }
    });

    it("supports optional, custom status, and exceptionFactory", async () => {
      const opt = new ParseIntPipe({ optional: true });
      expect(await opt.transform(undefined)).toBeUndefined();
      expect(await opt.transform(null)).toBeUndefined();

      const custom = new ParseIntPipe({
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      try {
        await custom.transform("bad");
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const httpErr = err as HttpException;
        expect(httpErr.getStatus()).toBe(422);
        expect(httpErr.toJSON().error).toBe("Unprocessable Entity");
      }
    });
  });

  describe("ParseFloatPipe", () => {
    const pipe = new ParseFloatPipe();

    it("parses valid floats, normalizes -0 to 0, and rejects garbage", async () => {
      expect(await pipe.transform("3.14")).toBe(3.14);
      expect(await pipe.transform("-0.5")).toBe(-0.5);
      expect(await pipe.transform(".25")).toBe(0.25);
      expect(await pipe.transform("1e3")).toBe(1000);
      expect(Object.is(await pipe.transform("-0"), 0)).toBe(true);
      expect(Object.is(await pipe.transform("-0.0"), 0)).toBe(true);
      expect(Object.is(await pipe.transform(-0), 0)).toBe(true);
      expect(await pipe.transform(42.5)).toBe(42.5);

      for (const bad of [
        "3.14px",
        "",
        "NaN",
        "Infinity",
        Number.NaN,
        Number.POSITIVE_INFINITY,
        null,
        undefined,
        false,
      ]) {
        await expect(pipe.transform(bad)).rejects.toThrow(HttpException);
      }
    });
  });

  describe("ParseBoolPipe (strict)", () => {
    const pipe = new ParseBoolPipe();

    it("parses ONLY true/false booleans and 'true'/'false' strings", async () => {
      expect(await pipe.transform(true)).toBe(true);
      expect(await pipe.transform("true")).toBe(true);
      expect(await pipe.transform(false)).toBe(false);
      expect(await pipe.transform("false")).toBe(false);

      for (const bad of [
        "1",
        "0",
        "yes",
        "no",
        "TRUE",
        "FALSE",
        "True",
        "False",
        "",
        " ",
        1,
        0,
        null,
        undefined,
        {},
        [],
      ]) {
        await expect(pipe.transform(bad)).rejects.toThrow(HttpException);
      }

      const optionalPipe = new ParseBoolPipe({ optional: true });
      expect(await optionalPipe.transform(undefined)).toBeUndefined();
    });
  });

  describe("ParseUUIDPipe", () => {
    const v4 = "550e8400-e29b-41d4-a716-446655440000";
    const v7 = "018f6b4b-7d9c-7b6a-9c5d-8e7f6a5b4c3d";

    it("validates UUID versions strictly", async () => {
      const anyUuid = new ParseUUIDPipe();
      expect(await anyUuid.transform(v4)).toBe(v4);
      expect(await anyUuid.transform(v7)).toBe(v7);

      const v4Only = new ParseUUIDPipe({ version: "4" });
      expect(await v4Only.transform(v4)).toBe(v4);
      await expect(v4Only.transform(v7)).rejects.toThrow(HttpException);

      const v7Only = new ParseUUIDPipe({ version: "7" });
      expect(await v7Only.transform(v7)).toBe(v7);
      await expect(v7Only.transform(v4)).rejects.toThrow(HttpException);

      await expect(anyUuid.transform("not-a-uuid")).rejects.toThrow(
        HttpException,
      );
      await expect(anyUuid.transform(12345)).rejects.toThrow(HttpException);
    });
  });

  describe("ParseArrayPipe", () => {
    it("parses comma-separated strings, arrays, typed items, and custom itemPipe", async () => {
      const strPipe = new ParseArrayPipe();
      expect(await strPipe.transform("a,b,c")).toEqual(["a", "b", "c"]);
      expect(await strPipe.transform("")).toEqual([""]);
      expect(await strPipe.transform(["x", "y"])).toEqual(["x", "y"]);

      const numPipe = new ParseArrayPipe({ items: Number, separator: "|" });
      expect(await numPipe.transform("1|2.5|-3")).toEqual([1, 2.5, -3]);
      await expect(numPipe.transform("1|abc")).rejects.toThrow(HttpException);

      const boolPipe = new ParseArrayPipe({ items: Boolean });
      expect(await boolPipe.transform("true, false, true")).toEqual([
        true,
        false,
        true,
      ]);
      await expect(boolPipe.transform("true,yes")).rejects.toThrow(
        HttpException,
      );
      await expect(boolPipe.transform("true, TRUE")).rejects.toThrow(
        HttpException,
      );

      const withItemPipe = new ParseArrayPipe({
        itemPipe: new ParseIntPipe(),
      });
      expect(await withItemPipe.transform("10,20,30")).toEqual([10, 20, 30]);
      await expect(withItemPipe.transform("10,20.5")).rejects.toThrow(
        HttpException,
      );

      const optPipe = new ParseArrayPipe({ optional: true });
      expect(await optPipe.transform(undefined)).toBeUndefined();
    });
  });

  describe("ParseEnumPipe", () => {
    enum Status {
      ACTIVE = "active",
      INACTIVE = "inactive",
    }

    enum Priority {
      LOW = 0,
      HIGH = 1,
    }

    enum Hetero {
      A = "B",
      B = 1,
    }

    it("validates string, numeric, and heterogeneous enums while rejecting numeric reverse-mapping keys", async () => {
      const statusPipe = new ParseEnumPipe(Status);
      expect(await statusPipe.transform("active")).toBe(Status.ACTIVE);
      await expect(statusPipe.transform("ACTIVE")).rejects.toThrow(
        HttpException,
      );
      await expect(statusPipe.transform("unknown")).rejects.toThrow(
        HttpException,
      );

      const priorityPipe = new ParseEnumPipe(Priority);
      expect(await priorityPipe.transform(Priority.LOW)).toBe(Priority.LOW);
      expect(await priorityPipe.transform("1")).toBe(Priority.HIGH);
      // Reverse mapping key names ("LOW", "HIGH") MUST be rejected
      await expect(priorityPipe.transform("LOW")).rejects.toThrow(
        HttpException,
      );
      await expect(priorityPipe.transform("HIGH")).rejects.toThrow(
        HttpException,
      );
      await expect(priorityPipe.transform(99)).rejects.toThrow(HttpException);

      // Heterogeneous enum where a string value ("B") collides with another member's key name
      const heteroPipe = new ParseEnumPipe(Hetero);
      expect(await heteroPipe.transform("B")).toBe(Hetero.A);
      expect(await heteroPipe.transform(1)).toBe(Hetero.B);
      expect(await heteroPipe.transform("1")).toBe(Hetero.B);
      await expect(heteroPipe.transform("A")).rejects.toThrow(HttpException);
    });
  });

  describe("DefaultValuePipe", () => {
    it("substitutes default only for undefined, null, or NaN while preserving falsy values", () => {
      const pipe = new DefaultValuePipe("fallback");
      expect(pipe.transform(undefined)).toBe("fallback");
      expect(pipe.transform(null)).toBe("fallback");
      expect(pipe.transform(Number.NaN)).toBe("fallback");

      expect(pipe.transform("")).toBe("");
      expect(pipe.transform(0)).toBe(0);
      expect(pipe.transform(false)).toBe(false);
      expect(pipe.transform("provided")).toBe("provided");
    });
  });
});
