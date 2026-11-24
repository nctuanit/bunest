import { describe, expect, it } from "bun:test";
import {
  Ternary,
  asyncBranch,
  branch,
  cond,
  evalTernary,
  evalTernaryAsync,
  isString,
  isTernary,
  isTernaryNode,
  labeledTernary,
  literal,
  mapTernary,
  ternary,
  ternaryFor,
  ternaryRule,
  traceTernary,
} from "../../src/common";

describe("Recursive Nested Ternary Struct", () => {
  it("handles deeply nested binary decision trees in both then and else branches", () => {
    const computeDiscount = (
      isMember: boolean,
      orderTotal: number,
      isVip: boolean,
      hasCoupon: boolean,
      isExpired: boolean,
    ): number =>
      ternary(isMember)
        .then(
          ternary(orderTotal > 100)
            .then(ternary(isVip).then(0.3).else(0.2))
            .else(0.1),
        )
        .else(
          ternary(hasCoupon)
            .then(ternary(isExpired).then(0).else(0.05))
            .else(0),
        )
        .eval();

    expect(computeDiscount(true, 150, true, false, false)).toBe(0.3);
    expect(computeDiscount(true, 150, false, false, false)).toBe(0.2);
    expect(computeDiscount(true, 50, true, false, false)).toBe(0.1);
    expect(computeDiscount(false, 50, false, true, false)).toBe(0.05);
    expect(computeDiscount(false, 50, false, true, true)).toBe(0);
    expect(computeDiscount(false, 50, false, false, false)).toBe(0);
  });

  it("handles right-nested elseIf chains and computes depth accurately", () => {
    const classifyScore = (score: number) =>
      ternary(score >= 90, "A")
        .elseIf(score >= 80, "B")
        .elseIf(score >= 70, "C")
        .elseIf(score >= 60, "D")
        .else("F");

    const tree = classifyScore(85);
    expect(isTernary(tree)).toBe(true);
    expect(isTernaryNode(tree.toNode())).toBe(true);
    expect(tree.depth()).toBe(4);
    expect(tree.eval()).toBe("B");
    expect(classifyScore(95).resolve()).toBe("A");
    expect(classifyScore(42).eval()).toBe("F");

    // Immediate shorthand .elseEval()
    const sign = (n: number): -1 | 0 | 1 =>
      ternary(n < 0, -1 as const)
        .elseIf(n > 0, 1 as const)
        .elseEval(0 as const);

    expect(sign(-5)).toBe(-1);
    expect(sign(0)).toBe(0);
    expect(sign(9)).toBe(1);
  });

  it("strictly short-circuits lazy conditions and untaken branches", () => {
    const evaluated: string[] = [];

    const result = ternary(() => {
      evaluated.push("cond1");
      return true;
    })
      .then(() => {
        evaluated.push("then1");
        return ternary(() => {
          evaluated.push("cond1-inner");
          return false;
        })
          .then(() => {
            evaluated.push("inner-then");
            return "bad";
          })
          .else(() => {
            evaluated.push("inner-else");
            return "winner";
          });
      })
      .else(() => {
        evaluated.push("else1");
        return "untaken";
      })
      .eval();

    expect(result).toBe("winner");
    expect(evaluated).toEqual(["cond1", "then1", "cond1-inner", "inner-else"]);
  });

  it("supports returning functions verbatim via literal()", () => {
    const add = (a: number, b: number) => a + b;
    const sub = (a: number, b: number) => a - b;

    const op = ternary(true).then(literal(add)).else(literal(sub)).eval();

    expect(op).toBe(add);
    expect(op(10, 4)).toBe(14);
  });

  it("records full decision traces and transforms trees with mapTernary / .map()", () => {
    const decision = labeledTernary("isMember", true)
      .then(labeledTernary("highOrder", false).then(30).else(10))
      .else(0);

    const traced = decision.trace();
    expect(traced.value).toBe(10);
    expect(traced.trace).toEqual([
      { depth: 0, label: "isMember", conditionResult: true, direction: "then" },
      {
        depth: 1,
        label: "highOrder",
        conditionResult: false,
        direction: "else",
      },
    ]);

    const mapped = decision.map((pct) => `${pct}%`);
    expect(mapped.eval()).toBe("10%");

    const rawNode = branch(false, 1, branch(true, 2, 3, "inner"), "outer");
    expect(evalTernary(mapTernary(rawNode, (n) => n * 10))).toBe(20);
    expect(traceTernary(rawNode).trace.map((s) => s.label)).toEqual([
      "outer",
      "inner",
    ]);
  });

  it("supports declarative cond(), async recursive evaluation, and maxDepth protection", async () => {
    const grade = cond(
      [
        [false, "A"],
        [() => true, ternary(false).then("B+").else("B")],
      ],
      "C",
    );
    expect(grade).toBe("B");

    const asyncTree = asyncBranch(
      async () => Promise.resolve(true),
      asyncBranch(
        async () => Promise.resolve(false),
        async () => "never",
        async () => "resolved-async",
      ),
      "fallback",
    );
    expect(await evalTernaryAsync(asyncTree)).toBe("resolved-async");

    // Cycle / infinite recursion protection
    const cyclic: Record<string, unknown> = {};
    const node = branch(true, () => cyclic.node, "end");
    cyclic.node = node;
    expect(() => evalTernary(node, { maxDepth: 25 })).toThrow(RangeError);
  });

  it("supports subject-bound ternaryFor() and reusable nested ternaryRule()", () => {
    const detectType = (fieldVal: unknown): string =>
      ternaryFor(fieldVal)
        .when((v): v is null => v === null, "null")
        .when(Array.isArray, "array")
        .when((v): v is Date => v instanceof Date, "date")
        .when(isString, (s) => `string(${s.length})`)
        .elseEval((v) => typeof v);

    expect(detectType(null)).toBe("null");
    expect(detectType([1, 2])).toBe("array");
    expect(detectType(new Date())).toBe("date");
    expect(detectType("bunest")).toBe("string(6)");
    expect(detectType(42)).toBe("number");
    expect(detectType(undefined)).toBe("undefined");

    interface User {
      active: boolean;
      role: "admin" | "member";
      verified: boolean;
    }

    const activeUserRule = ternaryRule<User>()
      .when((u) => u.role === "admin", "Active Admin", "isAdmin")
      .when((u) => u.verified, "Verified Member", "isVerified")
      .else("Unverified Member");

    const userBadgeRule = ternaryRule<User>()
      .when((u) => u.active, activeUserRule, "isActive")
      .else("Inactive");

    expect(
      userBadgeRule.eval({ active: true, role: "admin", verified: false }),
    ).toBe("Active Admin");
    expect(
      userBadgeRule.eval({ active: true, role: "member", verified: true }),
    ).toBe("Verified Member");
    expect(
      userBadgeRule.eval({ active: false, role: "admin", verified: true }),
    ).toBe("Inactive");

    const traceRes = userBadgeRule.trace({
      active: true,
      role: "member",
      verified: false,
    });
    expect(traceRes.value).toBe("Unverified Member");
    expect(traceRes.trace.map((t) => t.label)).toEqual([
      "isActive",
      "isAdmin",
      "isVerified",
    ]);

    expect(new Ternary(branch(true, 1, 2)).eval()).toBe(1);
  });
});
