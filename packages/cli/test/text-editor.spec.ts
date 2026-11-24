import { describe, expect, it } from "bun:test";
import { TextEditor } from "../src/analyzer/text-editor";

describe("TextEditor (zero-dep surgical text editor)", () => {
  it("supports appendLeft, prependLeft, appendRight, prependRight with exact boundary ordering", () => {
    const s = new TextEditor("abcdef");
    s.appendLeft(3, "[AL1]");
    s.appendLeft(3, "[AL2]");
    s.prependLeft(3, "[PL1]");
    s.appendRight(3, "[AR1]");
    s.appendRight(3, "[AR2]");
    s.prependRight(3, "[PR1]");

    expect(s.toString()).toBe("abc[PL1][AL1][AL2][PR1][AR1][AR2]def");
    expect(s.hasChanged()).toBe(true);
    expect(s.original).toBe("abcdef");
  });

  it("supports prepend and append around index 0 and end boundaries", () => {
    const s = new TextEditor("hello");
    s.prepend("1:");
    s.prepend("0:");
    s.appendLeft(0, "2:");
    s.prependLeft(0, "-1:");
    s.appendRight(0, "3:");
    s.appendLeft(5, ":4");
    s.appendRight(5, ":5");
    s.append(":6");

    expect(s.toString()).toBe("-1:0:1:2:3:hello:4:5:6");
  });

  it("handles empty original string cleanly across all insertion and no-op remove methods", () => {
    const s = new TextEditor("");
    expect(s.isEmpty()).toBe(true);
    expect(s.hasChanged()).toBe(false);

    s.remove(0, 0);
    s.prepend("A");
    s.append("B");
    s.appendLeft(0, "C");
    s.prependLeft(0, "D");
    s.appendRight(0, "E");
    s.prependRight(0, "F");

    expect(s.toString()).toBe("DACFBE");
    expect(s.isEmpty()).toBe(false);
    expect(s.hasChanged()).toBe(true);
  });

  it("supports adjacent and out-of-order overwrites and removals without offset drift", () => {
    const src = "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n";
    const s = new TextEditor(src);

    const gammaStart = src.indexOf("gamma");
    const alphaStart = src.indexOf("alpha");
    const betaLineStart = src.indexOf("const beta");
    const betaLineEnd = src.indexOf("\n", betaLineStart) + 1;

    // Apply in mixed order: overwrite last, remove middle, overwrite first
    s.overwrite(gammaStart, gammaStart + "gamma".length, "GAMMA_RENAMED");
    s.remove(betaLineStart, betaLineEnd);
    s.overwrite(alphaStart, alphaStart + "alpha".length, "A");

    expect(s.toString()).toBe("const A = 1;\nconst GAMMA_RENAMED = 3;\n");
  });

  it("supports adjacent overwrites sharing exact boundaries [0,3] and [3,6]", () => {
    const s = new TextEditor("foobar");
    s.overwrite(3, 6, "BAZ");
    s.overwrite(0, 3, "QUX");
    expect(s.toString()).toBe("QUXBAZ");

    // Re-overwriting an exact already-edited chunk succeeds
    s.overwrite(0, 3, "NEW");
    expect(s.toString()).toBe("NEWBAZ");
  });

  it("preserves outer insertions around overwritten or removed ranges and clears interior insertions", () => {
    const s = new TextEditor("0123456789");
    // Outside boundaries:
    s.appendLeft(2, "<BEFORE>");
    s.appendRight(8, "<AFTER>");
    // Inside range [2, 8]:
    s.appendRight(5, "<INSIDE>");
    // Overwrite [2, 8]
    s.overwrite(2, 8, "XXXX");

    expect(s.toString()).toBe("01<BEFORE>XXXX<AFTER>89");
  });

  it("supports appendRight immediately at the start of a removed range (sync-di pattern)", () => {
    const src = "class Foo {\n  private readonly dep!: Dep;\n}\n";
    const s = new TextEditor(src);
    const propLineStart = src.indexOf("  private");
    const propLineEnd = src.indexOf("\n", propLineStart) + 1;
    const openBrace = src.indexOf("{");

    s.remove(propLineStart, propLineEnd);
    s.appendRight(openBrace + 1, "\n  constructor(private readonly dep: Dep) {}\n");

    expect(s.toString()).toBe(
      "class Foo {\n  constructor(private readonly dep: Dep) {}\n\n}\n",
    );
  });

  it("supports contentOnly option on overwrite", () => {
    const s = new TextEditor("abcdef");
    s.appendRight(2, "(");
    s.appendLeft(4, ")");
    s.overwrite(2, 4, "CD", { contentOnly: true });
    expect(s.toString()).toBe("ab(CD)ef");
  });

  it("supports negative indices", () => {
    const s = new TextEditor("hello world");
    s.overwrite(-5, 11, "bunest");
    s.appendLeft(-6, "!");
    expect(s.toString()).toBe("hello! bunest");
  });

  it("throws on invalid ranges or splitting already-edited chunks", () => {
    const s = new TextEditor("0123456789");
    expect(() => s.overwrite(3, 3, "x")).toThrow(/zero-length/);
    expect(() => s.overwrite(5, 2, "x")).toThrow(/greater than start/);
    expect(() => s.remove(5, 2)).toThrow(/greater than start/);
    expect(() => s.appendLeft(99, "x")).toThrow(RangeError);

    s.overwrite(2, 8, "REPLACED");
    expect(() => s.overwrite(4, 6, "INNER")).toThrow(/already been edited/);
    expect(() => s.remove(3, 7)).toThrow(/already been edited/);
  });

  it("handles multiple interleaved decorator removals + class tail appendLeft (delombok pattern)", () => {
    const src = [
      "@Data()",
      "@Builder()",
      "@FieldNameConstants()",
      "export class User {",
      "  id!: number;",
      "}",
      "",
    ].join("\n");

    const s = new TextEditor(src);
    const d1 = src.indexOf("@Data()\n");
    const d3 = src.indexOf("@FieldNameConstants()\n");
    const closeBrace = src.lastIndexOf("}");

    s.remove(d1, d1 + "@Data()\n".length);
    s.remove(d3, d3 + "@FieldNameConstants()\n".length);
    s.appendLeft(closeBrace, "\n  static readonly Fields = { id: \"id\" } as const;\n");

    expect(s.toString()).toBe(
      [
        "@Builder()",
        "export class User {",
        "  id!: number;",
        "",
        "  static readonly Fields = { id: \"id\" } as const;",
        "}",
        "",
      ].join("\n"),
    );
  });
});
