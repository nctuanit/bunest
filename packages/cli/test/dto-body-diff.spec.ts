import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  diffBodyContracts,
  formatBodyContractDiffJson,
  formatBodyContractDiffPretty,
  type ReplayEvidenceRecord,
  type RouteBodyContract,
} from "../src/analyzer/body-contract-diff";

function makeOrdersRoute(
  overrides: {
    dtoName?: string;
    quantityMin?: number;
    quantityMax?: number;
    quantityOptional?: boolean;
    quantityTsOptional?: boolean;
    nameMinLength?: number;
    nameMaxLength?: number;
    extraFields?: RouteBodyContract["fields"];
    omitDescription?: boolean;
    unsupportedReasons?: RouteBodyContract["unsupportedReasons"];
  } = {},
): RouteBodyContract {
  const fields = [
    {
      name: "name",
      tsType: "string",
      tsOptional: false,
      isOptional: false,
      constraints: {
        minLength: overrides.nameMinLength ?? 1,
        maxLength: overrides.nameMaxLength ?? 200,
      },
      validators: ["IsString", "MinLength", "MaxLength"],
      sourceFile: "src/item.dto.ts",
      line: 15,
    },
    ...(!overrides.omitDescription
      ? [
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
        ]
      : []),
    {
      name: "quantity",
      tsType: "number",
      tsOptional: overrides.quantityTsOptional ?? true,
      isOptional: overrides.quantityOptional ?? true,
      constraints: {
        min: overrides.quantityMin ?? 0,
        max: overrides.quantityMax ?? 1_000_000,
      },
      validators: [
        ...((overrides.quantityOptional ?? true) ? ["IsOptional"] : []),
        "IsInt",
        "Min",
        "Max",
      ],
      sourceFile: "src/item.dto.ts",
      line: 26,
    },
    ...(overrides.extraFields ?? []),
  ];

  return {
    method: "POST",
    path: "/orders",
    dtoName: overrides.dtoName ?? "CreateItemDto",
    dtoSourceFile: "src/item.dto.ts",
    dtoLocation: { sourceFile: "src/item.dto.ts", line: 11 },
    fields,
    unsupportedReasons: overrides.unsupportedReasons ?? [],
  };
}

describe("body-contract-diff (Sprint DX 2026-12-11 Branch B)", () => {
  test("Rule 1: detects tightened min/max/minLength/maxLength and generates valid boundary payloads", () => {
    const base = [
      makeOrdersRoute({
        quantityMin: 0,
        quantityMax: 100,
        nameMinLength: 1,
        nameMaxLength: 200,
      }),
    ];
    const head = [
      makeOrdersRoute({
        quantityMin: 1,
        quantityMax: 50,
        nameMinLength: 3,
        nameMaxLength: 10,
      }),
    ];

    const report = diffBodyContracts(base, head, {
      sampleValues: { name: "Notebook" },
    });

    expect(report.status).toBe("breaking-candidates");
    expect(report.summary.breakingCandidates).toBe(4);

    const minFinding = report.staticFindings.find(
      (f) => f.field === "quantity" && f.constraint === "min",
    );
    expect(minFinding).toBeDefined();
    expect(minFinding?.changeKind).toBe("constraint-tightened");
    expect(minFinding?.severity).toBe("breaking-candidate");
    expect(minFinding?.before).toBe(0);
    expect(minFinding?.after).toBe(1);
    expect(minFinding?.sourceFile).toBe("src/item.dto.ts");
    expect(minFinding?.line).toBe(26);
    expect(minFinding?.candidatePayloads).toHaveLength(1);
    expect(minFinding?.candidatePayloads[0]?.payload).toEqual({
      name: "Notebook",
      quantity: 0,
    });

    const maxFinding = report.staticFindings.find(
      (f) => f.field === "quantity" && f.constraint === "max",
    );
    expect(maxFinding?.before).toBe(100);
    expect(maxFinding?.after).toBe(50);
    expect(maxFinding?.candidatePayloads[0]?.payload).toEqual({
      name: "Notebook",
      quantity: 51,
    });

    const minLenFinding = report.staticFindings.find(
      (f) => f.field === "name" && f.constraint === "minLength",
    );
    expect(minLenFinding?.before).toBe(1);
    expect(minLenFinding?.after).toBe(3);
    expect(minLenFinding?.candidatePayloads[0]?.payload.name).toBe("a");

    const maxLenFinding = report.staticFindings.find(
      (f) => f.field === "name" && f.constraint === "maxLength",
    );
    expect(maxLenFinding?.before).toBe(200);
    expect(maxLenFinding?.after).toBe(10);
    expect(
      (maxLenFinding?.candidatePayloads[0]?.payload.name as string).length,
    ).toBe(11);
  });

  test("Rule 2: removing @IsOptional() on a validated field emits TWO separate payloads (omit + null)", () => {
    const base = [makeOrdersRoute({ quantityOptional: true })];
    const head = [makeOrdersRoute({ quantityOptional: false })];

    const report = diffBodyContracts(base, head, {
      sampleValues: { name: "Notebook" },
    });

    const finding = report.staticFindings.find(
      (f) => f.changeKind === "optional-removed",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("breaking-candidate");
    expect(finding?.field).toBe("quantity");
    expect(finding?.candidatePayloads).toHaveLength(2);

    const omitCandidate = finding?.candidatePayloads.find(
      (c) => c.label === "omit-field",
    );
    const nullCandidate = finding?.candidatePayloads.find(
      (c) => c.label === "null-field",
    );

    expect(omitCandidate?.payload).toEqual({ name: "Notebook" });
    expect("quantity" in (omitCandidate?.payload ?? {})).toBe(false);
    expect(nullCandidate?.payload).toEqual({
      name: "Notebook",
      quantity: null,
    });
  });

  test("Rule 3: added required field and removed old field distinguish whitelist silent-strip from HTTP 400", () => {
    const base = [
      makeOrdersRoute({
        extraFields: [
          {
            name: "legacyCode",
            tsType: "string",
            tsOptional: true,
            isOptional: true,
            validators: ["IsOptional", "IsString"],
            sourceFile: "src/item.dto.ts",
            line: 30,
          },
        ],
      }),
    ];
    const head = [
      makeOrdersRoute({
        extraFields: [
          {
            name: "sku",
            tsType: "string",
            tsOptional: false,
            isOptional: false,
            validators: ["IsString", "MinLength"],
            constraints: { minLength: 3 },
            sourceFile: "src/item.dto.ts",
            line: 32,
          },
        ],
      }),
    ];

    // Profile A: whitelist: true, forbidNonWhitelisted: false -> silent-strip (behavior-change, NOT HTTP 400)
    const silentStripReport = diffBodyContracts(base, head, {
      pipeProfile: { whitelist: true, forbidNonWhitelisted: false },
      sampleValues: { name: "Notebook", legacyCode: "OLD-1" },
    });

    const addedReq = silentStripReport.staticFindings.find(
      (f) => f.changeKind === "required-field-added",
    );
    expect(addedReq?.field).toBe("sku");
    expect(addedReq?.severity).toBe("breaking-candidate");
    expect(addedReq?.candidatePayloads[0]?.payload).toEqual({
      name: "Notebook",
    });

    const removedSilent = silentStripReport.staticFindings.find(
      (f) => f.changeKind === "field-removed",
    );
    expect(removedSilent?.field).toBe("legacyCode");
    expect(removedSilent?.severity).toBe("behavior-change");
    expect(removedSilent?.unknownPropertyBehavior).toBe("silent-strip");
    expect(removedSilent?.message).toContain("silently stripped");
    expect(removedSilent?.candidatePayloads[0]?.payload).toEqual({
      name: "Notebook",
      legacyCode: "OLD-1",
    });

    // Profile B: whitelist: true, forbidNonWhitelisted: true -> HTTP 400 rejection (breaking-candidate)
    const forbidReport = diffBodyContracts(base, head, {
      pipeProfile: { whitelist: true, forbidNonWhitelisted: true },
      sampleValues: { name: "Notebook", legacyCode: "OLD-1" },
    });

    const removedForbid = forbidReport.staticFindings.find(
      (f) => f.changeKind === "field-removed",
    );
    expect(removedForbid?.field).toBe("legacyCode");
    expect(removedForbid?.severity).toBe("breaking-candidate");
    expect(removedForbid?.unknownPropertyBehavior).toBe("reject-400");
    expect(removedForbid?.message).toContain("HTTP 400");
  });

  test("Rule 4: relaxed bounds, TS-only `?` change, and DTO class rename are non-breaking", () => {
    const base = [
      makeOrdersRoute({
        dtoName: "CreateItemDto",
        quantityMin: 5,
        quantityMax: 100,
        quantityOptional: true,
        quantityTsOptional: true,
      }),
    ];
    const head = [
      makeOrdersRoute({
        dtoName: "CreateOrderItemPayloadDto",
        quantityMin: 0,
        quantityMax: 500,
        quantityOptional: true,
        quantityTsOptional: false, // TS-only `?` removed, @IsOptional() unchanged
      }),
    ];

    const report = diffBodyContracts(base, head);

    expect(report.status).toBe("safe");
    expect(report.summary.breakingCandidates).toBe(0);
    expect(report.summary.nonBreaking).toBe(4);

    const kinds = report.staticFindings.map((f) => f.changeKind);
    expect(kinds).toContain("dto-renamed");
    expect(kinds).toContain("constraint-relaxed");
    expect(kinds).toContain("ts-only-change");

    for (const f of report.staticFindings) {
      expect(f.severity).toBe("non-breaking");
    }
  });

  test("Rule 5: unsupported/dynamic validators emit needs-review and NEVER claim contract is safe", () => {
    const base = [makeOrdersRoute()];
    const head = [
      makeOrdersRoute({
        unsupportedReasons: [
          {
            kind: "custom-validator",
            field: "couponCode",
            reason: "Custom validator @IsValidCoupon cannot be statically bounded.",
            sourceFile: "src/item.dto.ts",
            line: 35,
          },
          {
            kind: "dynamic-pipe",
            reason: "ValidationPipe options are constructed dynamically at runtime.",
            sourceFile: "src/main.ts",
            line: 18,
          },
        ],
      }),
    ];

    const report = diffBodyContracts(base, head);

    expect(report.status).toBe("needs-review");
    expect(report.status).not.toBe("safe");
    expect(report.summary.needsReview).toBe(2);
    expect(report.staticFindings).toHaveLength(2);
    expect(report.staticFindings[0]?.changeKind).toBe("unsupported-needs-review");
    expect(report.staticFindings[0]?.severity).toBe("needs-review");
    expect(report.staticFindings[0]?.field).toBe("couponCode");
    expect(report.staticFindings[0]?.sourceFile).toBe("src/item.dto.ts");
    expect(report.staticFindings[0]?.line).toBe(35);

    const pretty = formatBodyContractDiffPretty(report);
    expect(pretty).toContain("needs-review:custom-validator");
    expect(pretty).toContain("Manual review required");
    expect(pretty).not.toContain("No body contract changes");
  });

  test("Rule 6: legacy manifests missing body metadata emit metadata-missing without crashing", () => {
    const legacyBase: RouteBodyContract[] = [
      { method: "POST", path: "/orders" },
      { method: "GET", path: "/orders" },
    ];
    const head: RouteBodyContract[] = [
      makeOrdersRoute({ quantityMin: 1 }),
      { method: "GET", path: "/orders" },
    ];

    const report = diffBodyContracts(legacyBase, head);

    expect(report.status).toBe("metadata-missing");
    expect(report.summary.comparedRouteCount).toBe(2);
    expect(report.summary.metadataMissing).toBe(2);
    expect(
      report.staticFindings.every(
        (f) =>
          f.changeKind === "missing-body-metadata" &&
          f.severity === "metadata-missing",
      ),
    ).toBe(true);
  });

  test("Strict replay evidence matching: attaches only exact commit+route+canonical-payload matches and rejects mismatches", () => {
    const base = [makeOrdersRoute({ quantityMin: 0 })];
    const head = [makeOrdersRoute({ quantityMin: 1 })];

    const evidence: ReplayEvidenceRecord[] = [
      // 1. Valid match (even with reversed JSON key order!)
      {
        method: "post",
        path: "/orders/",
        payload: { quantity: 0, name: "Notebook" },
        targetField: "quantity",
        baseCommit: "aaa1111",
        headCommit: "bbb2222",
        baseStatus: 201,
        headStatus: 400,
        headErrorFields: ["quantity"],
        verdict: "confirmed-breaking",
      },
      // 2. Mismatched head commit -> MUST be rejected
      {
        method: "POST",
        path: "/orders",
        payload: { name: "Notebook", quantity: 0 },
        targetField: "quantity",
        baseCommit: "aaa1111",
        headCommit: "ccc9999",
        baseStatus: 201,
        headStatus: 400,
        verdict: "confirmed-breaking",
      },
      // 3. Mismatched payload -> MUST be rejected
      {
        method: "POST",
        path: "/orders",
        payload: { name: "Notebook", quantity: 5 },
        targetField: "quantity",
        baseCommit: "aaa1111",
        headCommit: "bbb2222",
        baseStatus: 201,
        headStatus: 201,
        verdict: "no-http-change",
      },
      // 4. Mismatched route path -> MUST be rejected
      {
        method: "POST",
        path: "/items",
        payload: { name: "Notebook", quantity: 0 },
        targetField: "quantity",
        baseCommit: "aaa1111",
        headCommit: "bbb2222",
        baseStatus: 201,
        headStatus: 400,
        verdict: "confirmed-breaking",
      },
    ];

    expect(canonicalJson({ quantity: 0, name: "Notebook" })).toBe(
      canonicalJson({ name: "Notebook", quantity: 0 }),
    );

    const report = diffBodyContracts(base, head, {
      baseCommit: "aaa1111",
      headCommit: "bbb2222",
      sampleValues: { name: "Notebook" },
      replayEvidence: evidence,
    });

    expect(report.replayEvidence.verified).toHaveLength(1);
    expect(report.rejectedEvidenceCount).toBe(3);
    expect(report.replayEvidence.rejectedEvidenceCount).toBe(3);
    expect(report.warnings).toHaveLength(3);
    expect(report.warnings[0]).toContain("commit mismatch");
    expect(report.warnings[1]).toContain("no static finding matched");
    expect(report.warnings[2]).toContain("no static finding matched");

    // Pretty output with verified evidence includes exact reviewer-first lines
    const prettyWithEvidence = formatBodyContractDiffPretty(report);
    expect(prettyWithEvidence).toContain(
      "POST /orders   body.quantity   min: 0 -> 1",
    );
    expect(prettyWithEvidence).toContain(
      'Payload to try: {"name":"Notebook","quantity":0}',
    );
    expect(prettyWithEvidence).toContain(
      "Fixture evidence: base 201 -> head 400",
    );

    // Pretty output WITHOUT verified evidence omits "Fixture evidence:"
    const reportNoEvidence = diffBodyContracts(base, head, {
      sampleValues: { name: "Notebook" },
    });
    const prettyWithoutEvidence = formatBodyContractDiffPretty(reportNoEvidence);
    expect(prettyWithoutEvidence).toContain(
      "POST /orders   body.quantity   min: 0 -> 1",
    );
    expect(prettyWithoutEvidence).toContain(
      'Payload to try: {"name":"Notebook","quantity":0}',
    );
    expect(prettyWithoutEvidence).not.toContain("Fixture evidence:");

    // JSON output cleanly separates staticFindings from replayEvidence
    const parsedJson = JSON.parse(formatBodyContractDiffJson(report));
    expect(Array.isArray(parsedJson.staticFindings)).toBe(true);
    expect(parsedJson.replayEvidence).toBeDefined();
    expect(parsedJson.replayEvidence.verified).toHaveLength(1);
    expect(parsedJson.replayEvidence.rejectedEvidenceCount).toBe(3);
    expect(parsedJson.staticFindings[0].replayEvidence).toBeUndefined();
  });

  test("Rejects replay evidence when report baseCommit/headCommit are missing", () => {
    const base = [makeOrdersRoute({ quantityMin: 0 })];
    const head = [makeOrdersRoute({ quantityMin: 1 })];

    const report = diffBodyContracts(base, head, {
      sampleValues: { name: "Notebook" },
      replayEvidence: [
        {
          method: "POST",
          path: "/orders",
          payload: { name: "Notebook", quantity: 0 },
          baseCommit: "aaa1111",
          headCommit: "bbb2222",
          baseStatus: 201,
          headStatus: 400,
          verdict: "confirmed-breaking",
        },
      ],
    });

    expect(report.replayEvidence.verified).toHaveLength(0);
    expect(report.rejectedEvidenceCount).toBe(1);
    expect(report.warnings[0]).toContain("baseCommit/headCommit");
  });
});
