import {
  Body,
  Controller,
  Get,
  Post,
  join,
  mkdirSyncPath,
  readTextSync,
  removePath,
  writeTextSync,
} from "@bunest/core";
import { afterEach, describe, expect, it } from "bun:test";
import { Test } from "../../testing/src";
import { ValidationPipe } from "../../validation/src";
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "../../validation/src/validator";
import {
  replayBodyContractCandidates,
  runCli,
  type CliIO,
  type ReplayTargetInstance,
  type RouteDiffReport,
  type RouteSnapshotManifest,
} from "../src";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: string[] = [];

function makeTempProject(prefix: string): string {
  const dir = join(
    TMP_DIR,
    `bunest-dto-body-e2e-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSyncPath(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function createCapturedIO(cwd?: string): {
  io: CliIO;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      cwd,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    },
  };
}

function writeOrderProject(dir: string, minQuantity: number): void {
  mkdirSyncPath(join(dir, "src", "orders"), { recursive: true });
  writeTextSync(
    join(dir, "src", "orders", "create-order.dto.ts"),
    `import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "@bunest/validation/validator";

export class CreateOrderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(${minQuantity})
  @Max(1000000)
  quantity?: number;
}
`,
  );
  writeTextSync(
    join(dir, "src", "orders", "orders.controller.ts"),
    `import { Body, Controller, Get, Post } from "@bunest/core";
import { CreateOrderDto } from "./create-order.dto";

@Controller("orders")
export class OrdersController {
  @Get()
  list() {
    return [];
  }

  @Post()
  create(@Body() dto: CreateOrderDto) {
    return { id: 1, ...dto };
  }
}
`,
  );
}

class RuntimeBaseCreateOrderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  quantity?: number;
}

class RuntimeHeadCreateOrderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity?: number;
}

@Controller("orders")
class RuntimeBaseOrdersController {
  @Post()
  create(@Body() dto: RuntimeBaseCreateOrderDto) {
    return { id: 1, name: dto.name, quantity: dto.quantity };
  }
}

@Controller("orders")
class RuntimeHeadOrdersController {
  @Post()
  create(@Body() dto: RuntimeHeadCreateOrderDto) {
    return { id: 1, name: dto.name, quantity: dto.quantity };
  }
}

async function createRuntimeTarget(
  controller: typeof RuntimeBaseOrdersController | typeof RuntimeHeadOrdersController,
): Promise<ReplayTargetInstance> {
  const moduleRef = await Test.createTestingModule({
    controllers: [controller],
  }).compile();
  const app = moduleRef.createBunestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return {
    fetch: (request: Request) => app.fetch(request),
    close: () => app.close(),
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      await removePath(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  }
});

describe("DTO Body Contract CLI E2E (Sprint DX 2026-12-11 Wave B)", () => {
  it("runs snapshot -> replay -> diff --body --evidence end-to-end for @Min(0) -> @Min(1)", async () => {
    const baseDir = makeTempProject("base");
    const headDir = makeTempProject("head");
    const artifactsDir = makeTempProject("artifacts");

    writeOrderProject(baseDir, 0);
    writeOrderProject(headDir, 1);

    const baseJson = join(artifactsDir, "base.json");
    const headJson = join(artifactsDir, "head.json");
    const evidenceJson = join(artifactsDir, "evidence.json");

    // 1. Snapshot base & head manifests with --body
    const baseSnapCap = createCapturedIO(baseDir);
    const baseSnapRes = await runCli(
      ["routes", "snapshot", "--body", "--commit", "base-sha-001", "--out", baseJson],
      baseSnapCap.io,
    );
    expect(baseSnapRes.exitCode).toBe(0);

    const headSnapCap = createCapturedIO(headDir);
    const headSnapRes = await runCli(
      ["routes", "snapshot", "--body", "--commit", "head-sha-002", "--out", headJson],
      headSnapCap.io,
    );
    expect(headSnapRes.exitCode).toBe(0);

    const parsedBaseSnap = JSON.parse(readTextSync(baseJson)) as RouteSnapshotManifest;
    expect(parsedBaseSnap.bodyMetadataIncluded).toBe(true);
    expect(parsedBaseSnap.commit).toBe("base-sha-001");
    const postBase = parsedBaseSnap.routes.find(
      (r) => r.method === "POST" && r.path === "/orders",
    );
    expect(postBase?.body?.dtoName).toBe("CreateOrderDto");
    expect(
      postBase?.body?.fields?.find((f) => f.name === "quantity")?.constraints?.min,
    ).toBe(0);

    // 2. Replay {"name":"Notebook","quantity":0} against real base & head apps
    const evidenceRecords = await replayBodyContractCandidates({
      base: () => createRuntimeTarget(RuntimeBaseOrdersController),
      head: () => createRuntimeTarget(RuntimeHeadOrdersController),
      baseCommit: "base-sha-001",
      headCommit: "head-sha-002",
      pipeProfile: { applied: true, whitelist: true, transform: true },
      candidates: [
        {
          method: "POST",
          path: "/orders",
          targetField: "quantity",
          payload: { name: "Notebook", quantity: 0 },
        },
      ],
    });
    expect(evidenceRecords).toHaveLength(1);
    expect(evidenceRecords[0]?.baseStatus).toBe(201);
    expect(evidenceRecords[0]?.headStatus).toBe(400);
    expect(evidenceRecords[0]?.verdict).toBe("confirmed-breaking");
    writeTextSync(evidenceJson, JSON.stringify(evidenceRecords, null, 2));

    // 3. Pretty CLI diff with --body --evidence
    const prettyCap = createCapturedIO(artifactsDir);
    const prettyRes = await runCli(
      ["routes", "diff", baseJson, headJson, "--body", "--evidence", evidenceJson],
      prettyCap.io,
    );
    expect(prettyRes.exitCode).toBe(0);
    const prettyOut = prettyCap.stdout.join("\n");
    expect(prettyOut).toContain("POST /orders");
    expect(prettyOut).toContain("body.quantity");
    expect(prettyOut).toContain("min: 0 -> 1");
    expect(prettyOut).toContain('{"name":"Notebook","quantity":0}');
    expect(prettyOut).toContain("base 201 -> head 400");

    // 4. JSON CLI diff separates staticFindings from replayEvidence
    const jsonCap = createCapturedIO(artifactsDir);
    const jsonRes = await runCli(
      [
        "routes",
        "diff",
        baseJson,
        headJson,
        "--body",
        "--evidence",
        evidenceJson,
        "--format",
        "json",
      ],
      jsonCap.io,
    );
    expect(jsonRes.exitCode).toBe(0);
    const report = JSON.parse(jsonCap.stdout.join("\n")) as RouteDiffReport;
    expect(report.hasChanges).toBe(true);
    expect(report.bodyDiff).toBeDefined();
    expect(report.bodyDiff?.status).toBe("breaking-candidates");
    expect(report.bodyDiff?.staticFindings).toHaveLength(1);
    expect(report.bodyDiff?.staticFindings[0]?.changeKind).toBe(
      "constraint-tightened",
    );
    expect(report.bodyDiff?.staticFindings[0]?.field).toBe("quantity");
    expect(report.bodyDiff?.staticFindings[0]?.before).toBe(0);
    expect(report.bodyDiff?.staticFindings[0]?.after).toBe(1);
    expect(report.bodyDiff?.replayEvidence.verified).toHaveLength(1);
    expect(report.bodyDiff?.replayEvidence.rejectedEvidenceCount).toBe(0);
    expect(report.bodyDiff?.replayEvidence.verified[0]?.record.baseStatus).toBe(
      201,
    );
    expect(report.bodyDiff?.replayEvidence.verified[0]?.record.headStatus).toBe(
      400,
    );

    // 5. Rejects evidence with mismatched commit SHA
    const badEvidenceJson = join(artifactsDir, "bad-evidence.json");
    writeTextSync(
      badEvidenceJson,
      JSON.stringify(
        [{ ...evidenceRecords[0], headCommit: "wrong-head-sha" }],
        null,
        2,
      ),
    );
    const badEvCap = createCapturedIO(artifactsDir);
    const badEvRes = await runCli(
      [
        "routes",
        "diff",
        baseJson,
        headJson,
        "--body",
        "--evidence",
        badEvidenceJson,
        "--format",
        "json",
      ],
      badEvCap.io,
    );
    expect(badEvRes.exitCode).toBe(0);
    const badEvReport = JSON.parse(badEvCap.stdout.join("\n")) as RouteDiffReport;
    expect(badEvReport.bodyDiff?.replayEvidence.verified).toHaveLength(0);
    expect(badEvReport.bodyDiff?.replayEvidence.rejectedEvidenceCount).toBe(1);
  });

  it("supports `routes diff --base <base.json> --body` by scanning the current project", async () => {
    const baseDir = makeTempProject("live-base");
    const headDir = makeTempProject("live-head");
    writeOrderProject(baseDir, 0);
    writeOrderProject(headDir, 1);

    const baseJson = join(headDir, "base-routes.json");
    const snapCap = createCapturedIO(baseDir);
    const snapRes = await runCli(
      ["routes", "snapshot", "--body", "--out", baseJson],
      snapCap.io,
    );
    expect(snapRes.exitCode).toBe(0);

    const diffCap = createCapturedIO(headDir);
    const diffRes = await runCli(
      ["routes", "diff", "--base", "base-routes.json", "--body", "--format", "json"],
      diffCap.io,
    );
    expect(diffRes.exitCode).toBe(0);
    const report = JSON.parse(diffCap.stdout.join("\n")) as RouteDiffReport;
    expect(report.bodyDiff?.status).toBe("breaking-candidates");
    expect(report.bodyDiff?.staticFindings).toHaveLength(1);
    expect(report.bodyDiff?.staticFindings[0]?.field).toBe("quantity");
    expect(report.bodyDiff?.staticFindings[0]?.before).toBe(0);
    expect(report.bodyDiff?.staticFindings[0]?.after).toBe(1);
  });

  it("handles legacy manifests without body metadata cleanly and reports missing-body-metadata", async () => {
    const headDir = makeTempProject("legacy-head");
    writeOrderProject(headDir, 1);

    const legacyBaseJson = join(headDir, "legacy-base.json");
    writeTextSync(
      legacyBaseJson,
      JSON.stringify(
        {
          routes: [
            { method: "GET", path: "/orders" },
            { method: "POST", path: "/orders" },
            { method: "DELETE", path: "/orders/:id" },
          ],
        },
        null,
        2,
      ),
    );

    const headJson = join(headDir, "head.json");
    const headSnapCap = createCapturedIO(headDir);
    const headSnapRes = await runCli(
      ["routes", "snapshot", "--body", "--out", headJson],
      headSnapCap.io,
    );
    expect(headSnapRes.exitCode).toBe(0);

    const jsonCap = createCapturedIO(headDir);
    const jsonRes = await runCli(
      ["routes", "diff", legacyBaseJson, headJson, "--body", "--format", "json"],
      jsonCap.io,
    );
    expect(jsonRes.exitCode).toBe(0);
    const report = JSON.parse(jsonCap.stdout.join("\n")) as RouteDiffReport;
    // Normal route diff still works
    expect(
      report.removed.some((r) => r.method === "DELETE" && r.path === "/orders/:id"),
    ).toBe(true);
    // Body diff reports missing-body-metadata cleanly without crashing
    expect(report.bodyDiff).toBeDefined();
    expect(report.bodyDiff?.status).toBe("metadata-missing");
    expect(
      report.bodyDiff?.staticFindings.some(
        (f) => f.changeKind === "missing-body-metadata",
      ),
    ).toBe(true);

    const prettyCap = createCapturedIO(headDir);
    const prettyRes = await runCli(
      ["routes", "diff", legacyBaseJson, headJson, "--body"],
      prettyCap.io,
    );
    expect(prettyRes.exitCode).toBe(0);
    expect(prettyCap.stdout.join("\n")).toContain("metadata-missing");
  });
});
