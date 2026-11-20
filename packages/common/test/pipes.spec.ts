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
} from "../src";

describe("Built-in Pipes", () => {
  describe("ParseIntPipe", () => {
    const pipe = new ParseIntPipe();

    it("parses valid integers, normalizes -0 to 0, and rejects malformed input", () => {
      expect(pipe.transform("42")).toBe(42);
      expect(pipe.transform("-7")).toBe(-7);
      expect(pipe.transform("+10")).toBe(10);
      expect(pipe.transform("0")).toBe(0);
      expect(Object.is(pipe.transform("-0"), 0)).toBe(true);
      expect(Object.is(pipe.transform(-0), 0)).toBe(true);
      expect(pipe.transform(99)).toBe(99);

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
        expect(() => pipe.transform(bad)).toThrow(HttpException);
      }
    });

    it("supports optional, custom status, and exceptionFactory", () => {
      const opt = new ParseIntPipe({ optional: true });
      expect(opt.transform(undefined)).toBeUndefined();
      expect(opt.transform(null)).toBeUndefined();

      const custom = new ParseIntPipe({
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      try {
        custom.transform("bad");
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

    it("parses valid floats, normalizes -0 to 0, and rejects garbage", () => {
      expect(pipe.transform("3.14")).toBe(3.14);
      expect(pipe.transform("-0.5")).toBe(-0.5);
      expect(pipe.transform(".25")).toBe(0.25);
      expect(pipe.transform("1e3")).toBe(1000);
      expect(Object.is(pipe.transform("-0"), 0)).toBe(true);
      expect(Object.is(pipe.transform("-0.0"), 0)).toBe(true);
      expect(Object.is(pipe.transform(-0), 0)).toBe(true);
      expect(pipe.transform(42.5)).toBe(42.5);

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
        expect(() => pipe.transform(bad)).toThrow(HttpException);
      }
    });
  });

  describe("ParseBoolPipe (strict)", () => {
    const pipe = new ParseBoolPipe();

    it("parses ONLY true/false booleans and 'true'/'false' strings", () => {
      expect(pipe.transform(true)).toBe(true);
      expect(pipe.transform("true")).toBe(true);
      expect(pipe.transform(false)).toBe(false);
      expect(pipe.transform("false")).toBe(false);

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
        expect(() => pipe.transform(bad)).toThrow(HttpException);
      }

      const optionalPipe = new ParseBoolPipe({ optional: true });
      expect(optionalPipe.transform(undefined)).toBeUndefined();
    });
  });

  describe("ParseUUIDPipe", () => {
    const v4 = "550e8400-e29b-41d4-a716-446655440000";
    const v7 = "018f6b4b-7d9c-7b6a-9c5d-8e7f6a5b4c3d";

    it("validates UUID versions strictly", () => {
      const anyUuid = new ParseUUIDPipe();
      expect(anyUuid.transform(v4)).toBe(v4);
      expect(anyUuid.transform(v7)).toBe(v7);

      const v4Only = new ParseUUIDPipe({ version: "4" });
      expect(v4Only.transform(v4)).toBe(v4);
      expect(() => v4Only.transform(v7)).toThrow(HttpException);

      const v7Only = new ParseUUIDPipe({ version: "7" });
      expect(v7Only.transform(v7)).toBe(v7);
      expect(() => v7Only.transform(v4)).toThrow(HttpException);

      expect(() => anyUuid.transform("not-a-uuid")).toThrow(HttpException);
      expect(() => anyUuid.transform(12345)).toThrow(HttpException);
    });
  });

  describe("ParseArrayPipe", () => {
    it("parses comma-separated strings, arrays, typed items, and custom itemPipe", async () => {
      const strPipe = new ParseArrayPipe();
      expect(await strPipe.transform("a,b,c")).toEqual(["a", "b", "c"]);
      expect(await strPipe.transform("")).toEqual([]);
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
      await expect(boolPipe.transform("true,yes")).rejects.toThrow(HttpException);
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

    it("validates string, numeric, and heterogeneous enums while rejecting numeric reverse-mapping keys", () => {
      const statusPipe = new ParseEnumPipe(Status);
      expect(statusPipe.transform("active")).toBe(Status.ACTIVE);
      expect(() => statusPipe.transform("ACTIVE")).toThrow(HttpException);
      expect(() => statusPipe.transform("unknown")).toThrow(HttpException);

      const priorityPipe = new ParseEnumPipe(Priority);
      expect(priorityPipe.transform(Priority.LOW)).toBe(Priority.LOW);
      expect(priorityPipe.transform("1")).toBe(Priority.HIGH);
      // Reverse mapping key names ("LOW", "HIGH") MUST be rejected
      expect(() => priorityPipe.transform("LOW")).toThrow(HttpException);
      expect(() => priorityPipe.transform("HIGH")).toThrow(HttpException);
      expect(() => priorityPipe.transform(99)).toThrow(HttpException);

      // Heterogeneous enum where a string value ("B") collides with another member's key name
      const heteroPipe = new ParseEnumPipe(Hetero);
      expect(heteroPipe.transform("B")).toBe(Hetero.A);
      expect(heteroPipe.transform(1)).toBe(Hetero.B);
      expect(heteroPipe.transform("1")).toBe(Hetero.B);
      expect(() => heteroPipe.transform("A")).toThrow(HttpException);
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
