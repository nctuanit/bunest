import { cond, normalizePath } from "@bunest/core/common";

export interface BodyFieldConstraints {
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
}

export interface BodySourceLocation {
  readonly filePath?: string;
  readonly sourceFile?: string;
  readonly line: number;
  readonly column?: number;
}

export interface BodyFieldContract {
  readonly name: string;
  readonly tsType?: string;
  readonly tsOptional?: boolean;
  readonly isOptional?: boolean;
  readonly constraints?: BodyFieldConstraints;
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly validators?: readonly string[];
  readonly sourceFile?: string;
  readonly line?: number;
  readonly sampleValue?: unknown;
}

export type BodyUnsupportedKind =
  | "custom-validator"
  | "validation-groups"
  | "transform"
  | "mapped-type"
  | "nested-dto"
  | "non-literal-arg"
  | "dynamic-pipe"
  | "unresolvable-dto"
  | (string & {});

export interface BodyUnsupportedReason {
  readonly kind: BodyUnsupportedKind;
  readonly field?: string;
  readonly reason: string;
  readonly sourceFile?: string;
  readonly line?: number;
}

export interface BodyContractPayload {
  readonly dtoName?: string;
  readonly dtoSourceFile?: string;
  readonly dtoLocation?: BodySourceLocation;
  readonly fields?: readonly BodyFieldContract[];
  readonly unsupportedReasons?: readonly BodyUnsupportedReason[];
}

export interface RouteBodyContract {
  readonly method: string;
  readonly path: string;
  readonly version?: string;
  readonly controller?: string;
  readonly handler?: string;
  readonly dtoName?: string;
  readonly dtoSourceFile?: string;
  readonly dtoLocation?: BodySourceLocation;
  readonly fields?: readonly BodyFieldContract[];
  readonly unsupportedReasons?: readonly BodyUnsupportedReason[];
  readonly body?: BodyContractPayload | null;
}

export interface PipeProfileInfo {
  readonly name?: string;
  readonly whitelist?: boolean;
  readonly forbidNonWhitelisted?: boolean;
  readonly transform?: boolean;
  readonly validationPipeApplied?: boolean;
}

export type ReplayVerdict =
  | "confirmed-breaking"
  | "stripped-accepted"
  | "no-http-change"
  | "environment-error";

export interface ReplayEvidenceRecord {
  readonly method: string;
  readonly path: string;
  readonly version?: string;
  readonly payload: unknown;
  readonly targetField?: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly baseStatus: number;
  readonly headStatus: number;
  readonly baseErrorFields?: readonly string[];
  readonly headErrorFields?: readonly string[];
  readonly pipeProfile?: PipeProfileInfo;
  readonly verdict: ReplayVerdict;
  readonly environmentError?: string;
}

export type BodyContractChangeKind =
  | "constraint-tightened"
  | "optional-removed"
  | "required-field-added"
  | "field-removed"
  | "constraint-relaxed"
  | "ts-only-change"
  | "dto-renamed"
  | "unsupported-needs-review"
  | "missing-body-metadata";

export type BodyContractSeverity =
  | "breaking-candidate"
  | "behavior-change"
  | "non-breaking"
  | "needs-review"
  | "metadata-missing";

export type UnknownPropertyBehavior =
  | "reject-400"
  | "silent-strip"
  | "pass-through"
  | "unknown";

export type ConstraintName = "min" | "max" | "minLength" | "maxLength";

export interface CandidatePayload {
  readonly label: string;
  readonly description: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly canonicalJson: string;
}

export interface BodyContractDiffFinding {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly version?: string;
  readonly field?: string;
  readonly changeKind: BodyContractChangeKind;
  readonly severity: BodyContractSeverity;
  readonly constraint?: ConstraintName;
  readonly before?: string | number | boolean | null;
  readonly after?: string | number | boolean | null;
  readonly unknownPropertyBehavior?: UnknownPropertyBehavior;
  readonly unsupportedKind?: BodyUnsupportedKind;
  readonly dtoName?: string;
  readonly sourceFile?: string;
  readonly line?: number;
  readonly message: string;
  readonly candidatePayloads: readonly CandidatePayload[];
}

export interface VerifiedReplayEvidence {
  readonly findingId: string;
  readonly candidateLabel?: string;
  readonly record: ReplayEvidenceRecord;
}

export interface ReplayEvidenceSection {
  readonly verified: readonly VerifiedReplayEvidence[];
  readonly rejectedEvidenceCount: number;
  readonly warnings: readonly string[];
}

export type BodyContractDiffStatus =
  | "breaking-candidates"
  | "needs-review"
  | "behavior-changes"
  | "metadata-missing"
  | "safe";

export interface BodyContractDiffSummary {
  readonly baseRouteCount: number;
  readonly headRouteCount: number;
  readonly comparedRouteCount: number;
  readonly totalFindings: number;
  readonly breakingCandidates: number;
  readonly behaviorChanges: number;
  readonly nonBreaking: number;
  readonly needsReview: number;
  readonly metadataMissing: number;
  readonly verifiedEvidenceCount: number;
  readonly rejectedEvidenceCount: number;
}

export interface BodyContractDiffReport {
  readonly schemaVersion: "1.0";
  readonly status: BodyContractDiffStatus;
  readonly baseCommit?: string;
  readonly headCommit?: string;
  readonly pipeProfile?: PipeProfileInfo;
  readonly summary: BodyContractDiffSummary;
  readonly staticFindings: readonly BodyContractDiffFinding[];
  readonly replayEvidence: ReplayEvidenceSection;
  readonly rejectedEvidenceCount: number;
  readonly warnings: readonly string[];
}

export interface DiffBodyContractsOptions {
  readonly replayEvidence?: readonly ReplayEvidenceRecord[];
  readonly baseCommit?: string;
  readonly headCommit?: string;
  readonly pipeProfile?: PipeProfileInfo;
  readonly sampleValues?: Readonly<Record<string, unknown>>;
}

interface NormalizedRouteBody {
  readonly method: string;
  readonly path: string;
  readonly version?: string;
  readonly hasBodyMetadata: boolean;
  readonly dtoName?: string;
  readonly dtoSourceFile?: string;
  readonly dtoLocation?: BodySourceLocation;
  readonly fields: readonly BodyFieldContract[];
  readonly unsupportedReasons: readonly BodyUnsupportedReason[];
}

const REMOVED_FIELD_BEHAVIOR_LABELS: Readonly<
  Record<UnknownPropertyBehavior, string>
> = {
  "silent-strip": "silent-strip (not HTTP 400)",
  "reject-400": "HTTP 400 rejection",
  "pass-through": "pass-through",
  unknown: "pipe behavior unconfigured",
};

function normalizeMethod(method: string): string {
  return method.trim().toUpperCase();
}

function normalizeVersion(version?: string): string | undefined {
  if (version === undefined) return undefined;
  const trimmed = version.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function routeKey(method: string, path: string, version?: string): string {
  return `${normalizeMethod(method)} ${normalizePath(path)} ${normalizeVersion(version) ?? ""}`;
}

/**
 * Deterministic canonical JSON string with recursively sorted object keys.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`);
  return `{${entries.join(",")}}`;
}

function normalizeRouteBody(route: RouteBodyContract): NormalizedRouteBody {
  const method = normalizeMethod(route.method);
  const path = normalizePath(route.path);
  const version = normalizeVersion(route.version);

  const nested = route.body ?? undefined;
  const fields = route.fields ?? nested?.fields;
  const unsupportedReasons =
    route.unsupportedReasons ?? nested?.unsupportedReasons ?? [];
  const dtoName = route.dtoName ?? nested?.dtoName;
  const dtoLocation = route.dtoLocation ?? nested?.dtoLocation;
  const dtoSourceFile =
    route.dtoSourceFile ??
    nested?.dtoSourceFile ??
    dtoLocation?.sourceFile ??
    dtoLocation?.filePath;

  const hasBodyMetadata =
    fields !== undefined || unsupportedReasons.length > 0;

  return {
    method,
    path,
    version,
    hasBodyMetadata,
    dtoName,
    dtoSourceFile,
    dtoLocation,
    fields: fields ?? [],
    unsupportedReasons,
  };
}

function getConstraints(field: BodyFieldContract): BodyFieldConstraints {
  return {
    min: field.constraints?.min ?? field.min,
    max: field.constraints?.max ?? field.max,
    minLength: field.constraints?.minLength ?? field.minLength,
    maxLength: field.constraints?.maxLength ?? field.maxLength,
  };
}

function hasAnyValidator(field: BodyFieldContract): boolean {
  const c = getConstraints(field);
  if (
    c.min !== undefined ||
    c.max !== undefined ||
    c.minLength !== undefined ||
    c.maxLength !== undefined
  ) {
    return true;
  }
  if (!field.validators || field.validators.length === 0) return false;
  return field.validators.some((v) => v !== "IsOptional");
}

function isFieldInteger(field: BodyFieldContract): boolean {
  return field.validators?.includes("IsInt") ?? false;
}

function isFieldNumber(field: BodyFieldContract): boolean {
  const c = getConstraints(field);
  if (c.min !== undefined || c.max !== undefined) return true;
  if (
    field.validators?.some(
      (v) => v === "IsInt" || v === "IsNumber" || v === "Min" || v === "Max",
    )
  ) {
    return true;
  }
  const t = field.tsType?.trim().toLowerCase();
  return t === "number";
}

function isFieldBoolean(field: BodyFieldContract): boolean {
  if (field.validators?.includes("IsBoolean")) return true;
  return field.tsType?.trim().toLowerCase() === "boolean";
}

function isFieldEmail(field: BodyFieldContract): boolean {
  return field.validators?.includes("IsEmail") ?? false;
}

function isFieldString(field: BodyFieldContract): boolean {
  const c = getConstraints(field);
  if (c.minLength !== undefined || c.maxLength !== undefined) return true;
  if (
    field.validators?.some(
      (v) =>
        v === "IsString" ||
        v === "IsEmail" ||
        v === "IsNotEmpty" ||
        v === "MinLength" ||
        v === "MaxLength",
    )
  ) {
    return true;
  }
  const t = field.tsType?.trim().toLowerCase();
  return t === "string";
}

function isFieldRequiredForPayload(field: BodyFieldContract): boolean {
  if (field.isOptional === true) return false;
  if (field.tsOptional === true && !hasAnyValidator(field)) return false;
  return true;
}

function clampStringLength(
  seed: string,
  minLength?: number,
  maxLength?: number,
): string {
  let out = seed;
  if (maxLength !== undefined && out.length > maxLength) {
    out = out.slice(0, Math.max(0, maxLength));
  }
  if (minLength !== undefined && out.length < minLength) {
    out = out + "a".repeat(minLength - out.length);
  }
  return out;
}

function buildValidSampleValue(
  field: BodyFieldContract,
  counterpart?: BodyFieldContract,
  sampleValues?: Readonly<Record<string, unknown>>,
): unknown {
  if (sampleValues && Object.prototype.hasOwnProperty.call(sampleValues, field.name)) {
    return sampleValues[field.name];
  }
  if (field.sampleValue !== undefined) {
    return field.sampleValue;
  }
  if (counterpart?.sampleValue !== undefined) {
    return counterpart.sampleValue;
  }

  const c1 = getConstraints(field);
  const c2 = counterpart ? getConstraints(counterpart) : {};

  if (isFieldBoolean(field)) {
    return true;
  }

  if (isFieldNumber(field)) {
    const minBound =
      c1.min !== undefined && c2.min !== undefined
        ? Math.max(c1.min, c2.min)
        : (c1.min ?? c2.min);
    const maxBound =
      c1.max !== undefined && c2.max !== undefined
        ? Math.min(c1.max, c2.max)
        : (c1.max ?? c2.max);
    const isInt = isFieldInteger(field) || (counterpart ? isFieldInteger(counterpart) : false);

    let candidate = 1;
    if (minBound !== undefined && candidate < minBound) {
      candidate = isInt ? Math.ceil(minBound) : minBound;
    }
    if (maxBound !== undefined && candidate > maxBound) {
      candidate = isInt ? Math.floor(maxBound) : maxBound;
    }
    return candidate;
  }

  if (isFieldEmail(field)) {
    return "user@example.com";
  }

  if (isFieldString(field)) {
    const minLen =
      c1.minLength !== undefined && c2.minLength !== undefined
        ? Math.max(c1.minLength, c2.minLength)
        : (c1.minLength ?? c2.minLength);
    const maxLen =
      c1.maxLength !== undefined && c2.maxLength !== undefined
        ? Math.min(c1.maxLength, c2.maxLength)
        : (c1.maxLength ?? c2.maxLength);
    const effectiveMin =
      minLen ??
      (field.validators?.includes("IsNotEmpty") ||
      counterpart?.validators?.includes("IsNotEmpty")
        ? 1
        : undefined);
    return clampStringLength("sample", effectiveMin, maxLen);
  }

  const t = field.tsType?.trim().toLowerCase();
  if (t?.endsWith("[]") || t?.startsWith("array<")) {
    return [];
  }
  return "sample";
}

function buildPayloadWithSiblings(
  primaryFields: readonly BodyFieldContract[],
  counterpartByName: ReadonlyMap<string, BodyFieldContract>,
  overrides: Readonly<Record<string, unknown>>,
  omitFields: ReadonlySet<string>,
  sampleValues?: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of primaryFields) {
    if (omitFields.has(field.name)) continue;
    if (Object.prototype.hasOwnProperty.call(overrides, field.name)) {
      payload[field.name] = overrides[field.name];
      continue;
    }
    if (isFieldRequiredForPayload(field)) {
      payload[field.name] = buildValidSampleValue(
        field,
        counterpartByName.get(field.name),
        sampleValues,
      );
    }
  }
  // Ensure any override key not present in primaryFields is still included
  for (const [k, v] of Object.entries(overrides)) {
    if (!omitFields.has(k) && !Object.prototype.hasOwnProperty.call(payload, k)) {
      payload[k] = v;
    }
  }
  return payload;
}

function makeCandidate(
  label: string,
  description: string,
  payload: Record<string, unknown>,
): CandidatePayload {
  return {
    label,
    description,
    payload,
    canonicalJson: canonicalJson(payload),
  };
}

function computeTightenedBoundaryValue(
  constraint: ConstraintName,
  baseVal: number | undefined,
  headVal: number,
  field: BodyFieldContract,
): unknown {
  const isInt = isFieldInteger(field);
  if (constraint === "min") {
    if (baseVal !== undefined) {
      const candidate = headVal - 1;
      if (candidate >= baseVal) {
        return isInt ? Math.floor(candidate) : candidate;
      }
      return isInt ? Math.ceil(baseVal) : baseVal;
    }
    return isInt ? Math.floor(headVal) - 1 : headVal - 1;
  }

  if (constraint === "max") {
    if (baseVal !== undefined) {
      const candidate = headVal + 1;
      if (candidate <= baseVal) {
        return isInt ? Math.ceil(candidate) : candidate;
      }
      return isInt ? Math.floor(baseVal) : baseVal;
    }
    return isInt ? Math.ceil(headVal) + 1 : headVal + 1;
  }

  if (constraint === "minLength") {
    const targetLen =
      baseVal !== undefined
        ? Math.max(0, Math.min(headVal - 1, baseVal))
        : Math.max(0, headVal - 1);
    return targetLen === 0 ? "" : "a".repeat(targetLen);
  }

  // maxLength
  const targetLen = headVal + 1;
  return "a".repeat(Math.max(1, targetLen));
}

function resolveFieldSource(
  field: BodyFieldContract | undefined,
  route: NormalizedRouteBody,
): { readonly sourceFile?: string; readonly line?: number } {
  const sourceFile =
    field?.sourceFile ??
    route.dtoSourceFile ??
    route.dtoLocation?.sourceFile ??
    route.dtoLocation?.filePath;
  const line = field?.line ?? route.dtoLocation?.line;
  return {
    ...(sourceFile !== undefined ? { sourceFile } : {}),
    ...(line !== undefined ? { line } : {}),
  };
}

function classifyRemovedField(pipeProfile?: PipeProfileInfo): {
  readonly severity: BodyContractSeverity;
  readonly unknownPropertyBehavior: UnknownPropertyBehavior;
  readonly detail: string;
} {
  if (pipeProfile?.whitelist === true && pipeProfile?.forbidNonWhitelisted === true) {
    return {
      severity: "breaking-candidate",
      unknownPropertyBehavior: "reject-400",
      detail:
        "Pipe has whitelist: true, forbidNonWhitelisted: true — old clients sending this field will receive HTTP 400.",
    };
  }
  if (pipeProfile?.whitelist === true && !pipeProfile?.forbidNonWhitelisted) {
    return {
      severity: "behavior-change",
      unknownPropertyBehavior: "silent-strip",
      detail:
        "Pipe has whitelist: true, forbidNonWhitelisted: false — request is accepted (2xx) and this field is silently stripped (not HTTP 400).",
    };
  }
  if (pipeProfile?.whitelist === false) {
    return {
      severity: "behavior-change",
      unknownPropertyBehavior: "pass-through",
      detail:
        "Pipe has whitelist: false — old field is passed through without HTTP 400, though no longer declared on the DTO.",
    };
  }
  return {
    severity: "behavior-change",
    unknownPropertyBehavior: "unknown",
    detail:
      "Removed field behavior depends on ValidationPipe config (whitelist/forbidNonWhitelisted): silent strip vs HTTP 400.",
  };
}

function findingId(
  method: string,
  path: string,
  version: string | undefined,
  field: string | undefined,
  suffix: string,
): string {
  const ver = version ? `@v${version}` : "";
  const fld = field ?? "(dto)";
  return `${method} ${path}${ver}::${fld}::${suffix}`;
}

function formatBoundValue(val: number | undefined): string {
  return val === undefined ? "none" : String(val);
}

/**
 * Pure body contract diff between base and head route body metadata,
 * with boundary payload generation and strict replay evidence verification.
 */
export function diffBodyContracts(
  baseRoutes: readonly RouteBodyContract[],
  headRoutes: readonly RouteBodyContract[],
  options: DiffBodyContractsOptions = {},
): BodyContractDiffReport {
  const normBase = baseRoutes.map(normalizeRouteBody);
  const normHead = headRoutes.map(normalizeRouteBody);

  const headByKey = new Map<string, NormalizedRouteBody>();
  for (const h of normHead) {
    headByKey.set(routeKey(h.method, h.path, h.version), h);
  }

  const staticFindings: BodyContractDiffFinding[] = [];
  let comparedRouteCount = 0;

  for (const base of normBase) {
    const key = routeKey(base.method, base.path, base.version);
    const head = headByKey.get(key);
    if (!head) continue;
    comparedRouteCount++;

    // Rule 6: Legacy manifests missing body metadata
    if (!base.hasBodyMetadata || !head.hasBodyMetadata) {
      const missingSide = cond(
        [
          [
            !base.hasBodyMetadata && !head.hasBodyMetadata,
            "base and head manifests",
          ],
          [!base.hasBodyMetadata, "base manifest"],
        ],
        "head manifest",
      );
      const src = resolveFieldSource(undefined, head.hasBodyMetadata ? head : base);
      staticFindings.push({
        id: findingId(
          base.method,
          base.path,
          base.version,
          undefined,
          "missing-body-metadata",
        ),
        method: base.method,
        path: base.path,
        ...(base.version !== undefined ? { version: base.version } : {}),
        changeKind: "missing-body-metadata",
        severity: "metadata-missing",
        ...(head.dtoName ?? base.dtoName
          ? { dtoName: head.dtoName ?? base.dtoName }
          : {}),
        ...src,
        message: `Body metadata missing in ${missingSide}; route-level diff still works, but body constraints cannot be verified.`,
        candidatePayloads: [],
      });
      continue;
    }

    // Rule 5: Unsupported / dynamic validators (never claim safe)
    const seenUnsupported = new Set<string>();
    const combinedUnsupported: Array<{
      reason: BodyUnsupportedReason;
      route: NormalizedRouteBody;
    }> = [
      ...head.unsupportedReasons.map((reason) => ({ reason, route: head })),
      ...base.unsupportedReasons.map((reason) => ({ reason, route: base })),
    ];

    for (const { reason, route } of combinedUnsupported) {
      const dedupeKey = `${reason.kind}::${reason.field ?? ""}::${reason.reason}`;
      if (seenUnsupported.has(dedupeKey)) continue;
      seenUnsupported.add(dedupeKey);
      const sourceFile =
        reason.sourceFile ??
        route.dtoSourceFile ??
        route.dtoLocation?.sourceFile ??
        route.dtoLocation?.filePath;
      const line = reason.line ?? route.dtoLocation?.line;

      staticFindings.push({
        id: findingId(
          base.method,
          base.path,
          base.version,
          reason.field,
          `unsupported:${reason.kind}:${seenUnsupported.size}`,
        ),
        method: base.method,
        path: base.path,
        ...(base.version !== undefined ? { version: base.version } : {}),
        ...(reason.field !== undefined ? { field: reason.field } : {}),
        changeKind: "unsupported-needs-review",
        severity: "needs-review",
        unsupportedKind: reason.kind,
        ...(route.dtoName ? { dtoName: route.dtoName } : {}),
        ...(sourceFile !== undefined ? { sourceFile } : {}),
        ...(line !== undefined ? { line } : {}),
        message: reason.reason,
        candidatePayloads: [],
      });
    }

    // Rule 4c: DTO class rename (non-breaking)
    if (base.dtoName && head.dtoName && base.dtoName !== head.dtoName) {
      const src = resolveFieldSource(undefined, head);
      staticFindings.push({
        id: findingId(
          base.method,
          base.path,
          base.version,
          undefined,
          "dto-renamed",
        ),
        method: base.method,
        path: base.path,
        ...(base.version !== undefined ? { version: base.version } : {}),
        changeKind: "dto-renamed",
        severity: "non-breaking",
        before: base.dtoName,
        after: head.dtoName,
        dtoName: head.dtoName,
        ...src,
        message: `DTO class renamed from ${base.dtoName} to ${head.dtoName} (non-breaking).`,
        candidatePayloads: [],
      });
    }

    const baseFieldMap = new Map<string, BodyFieldContract>();
    for (const f of base.fields) baseFieldMap.set(f.name, f);
    const headFieldMap = new Map<string, BodyFieldContract>();
    for (const f of head.fields) headFieldMap.set(f.name, f);

    // Compare shared fields
    for (const headField of head.fields) {
      const baseField = baseFieldMap.get(headField.name);
      if (!baseField) continue;

      const src = resolveFieldSource(headField, head);
      const bc = getConstraints(baseField);
      const hc = getConstraints(headField);

      // Rule 1 & Rule 4a: Literal bounds (min, max, minLength, maxLength)
      const boundChecks: Array<{
        name: ConstraintName;
        baseVal: number | undefined;
        headVal: number | undefined;
        tightened: boolean;
        relaxed: boolean;
      }> = [
        {
          name: "min",
          baseVal: bc.min,
          headVal: hc.min,
          tightened:
            hc.min !== undefined && (bc.min === undefined || hc.min > bc.min),
          relaxed:
            bc.min !== undefined && (hc.min === undefined || hc.min < bc.min),
        },
        {
          name: "max",
          baseVal: bc.max,
          headVal: hc.max,
          tightened:
            hc.max !== undefined && (bc.max === undefined || hc.max < bc.max),
          relaxed:
            bc.max !== undefined && (hc.max === undefined || hc.max > bc.max),
        },
        {
          name: "minLength",
          baseVal: bc.minLength,
          headVal: hc.minLength,
          tightened:
            hc.minLength !== undefined &&
            ((bc.minLength === undefined && hc.minLength > 0) ||
              (bc.minLength !== undefined && hc.minLength > bc.minLength)),
          relaxed:
            bc.minLength !== undefined &&
            (hc.minLength === undefined || hc.minLength < bc.minLength),
        },
        {
          name: "maxLength",
          baseVal: bc.maxLength,
          headVal: hc.maxLength,
          tightened:
            hc.maxLength !== undefined &&
            (bc.maxLength === undefined || hc.maxLength < bc.maxLength),
          relaxed:
            bc.maxLength !== undefined &&
            (hc.maxLength === undefined || hc.maxLength > bc.maxLength),
        },
      ];

      for (const check of boundChecks) {
        if (check.tightened && check.headVal !== undefined) {
          const boundaryVal = computeTightenedBoundaryValue(
            check.name,
            check.baseVal,
            check.headVal,
            headField,
          );
          const payloadObj = buildPayloadWithSiblings(
            head.fields,
            baseFieldMap,
            { [headField.name]: boundaryVal },
            new Set(),
            options.sampleValues,
          );
          staticFindings.push({
            id: findingId(
              base.method,
              base.path,
              base.version,
              headField.name,
              `constraint-tightened:${check.name}`,
            ),
            method: base.method,
            path: base.path,
            ...(base.version !== undefined ? { version: base.version } : {}),
            field: headField.name,
            changeKind: "constraint-tightened",
            severity: "breaking-candidate",
            constraint: check.name,
            before: check.baseVal ?? null,
            after: check.headVal,
            ...(head.dtoName ? { dtoName: head.dtoName } : {}),
            ...src,
            message: `${check.name}: ${formatBoundValue(check.baseVal)} -> ${formatBoundValue(check.headVal)}`,
            candidatePayloads: [
              makeCandidate(
                "boundary",
                `Boundary value for ${headField.name} (${check.name}: ${formatBoundValue(check.baseVal)} -> ${formatBoundValue(check.headVal)})`,
                payloadObj,
              ),
            ],
          });
        } else if (check.relaxed) {
          staticFindings.push({
            id: findingId(
              base.method,
              base.path,
              base.version,
              headField.name,
              `constraint-relaxed:${check.name}`,
            ),
            method: base.method,
            path: base.path,
            ...(base.version !== undefined ? { version: base.version } : {}),
            field: headField.name,
            changeKind: "constraint-relaxed",
            severity: "non-breaking",
            constraint: check.name,
            before: check.baseVal ?? null,
            after: check.headVal ?? null,
            ...(head.dtoName ? { dtoName: head.dtoName } : {}),
            ...src,
            message: `${check.name}: ${formatBoundValue(check.baseVal)} -> ${formatBoundValue(check.headVal)} (relaxed, non-breaking)`,
            candidatePayloads: [],
          });
        }
      }

      // Rule 2: Removed @IsOptional() on validated field
      const baseIsOpt = baseField.isOptional === true;
      const headIsOpt = headField.isOptional === true;
      if (baseIsOpt && !headIsOpt && (hasAnyValidator(headField) || hasAnyValidator(baseField))) {
        const omitPayload = buildPayloadWithSiblings(
          head.fields,
          baseFieldMap,
          {},
          new Set([headField.name]),
          options.sampleValues,
        );
        const nullPayload = buildPayloadWithSiblings(
          head.fields,
          baseFieldMap,
          { [headField.name]: null },
          new Set(),
          options.sampleValues,
        );
        staticFindings.push({
          id: findingId(
            base.method,
            base.path,
            base.version,
            headField.name,
            "optional-removed",
          ),
          method: base.method,
          path: base.path,
          ...(base.version !== undefined ? { version: base.version } : {}),
          field: headField.name,
          changeKind: "optional-removed",
          severity: "breaking-candidate",
          before: "@IsOptional()",
          after: "required",
          ...(head.dtoName ? { dtoName: head.dtoName } : {}),
          ...src,
          message: `@IsOptional() removed on validated field "${headField.name}"; test omitting the field and sending null separately.`,
          candidatePayloads: [
            makeCandidate(
              "omit-field",
              `Omit "${headField.name}" from request body`,
              omitPayload,
            ),
            makeCandidate(
              "null-field",
              `Set "${headField.name}" to null`,
              nullPayload,
            ),
          ],
        });
      } else if (!baseIsOpt && headIsOpt) {
        staticFindings.push({
          id: findingId(
            base.method,
            base.path,
            base.version,
            headField.name,
            "optional-added",
          ),
          method: base.method,
          path: base.path,
          ...(base.version !== undefined ? { version: base.version } : {}),
          field: headField.name,
          changeKind: "constraint-relaxed",
          severity: "non-breaking",
          before: "required",
          after: "@IsOptional()",
          ...(head.dtoName ? { dtoName: head.dtoName } : {}),
          ...src,
          message: `@IsOptional() added on "${headField.name}" (relaxed, non-breaking).`,
          candidatePayloads: [],
        });
      }

      // Rule 4b: TS-only `?` change (no @IsOptional() change)
      const baseTsOpt = baseField.tsOptional === true;
      const headTsOpt = headField.tsOptional === true;
      if (baseTsOpt !== headTsOpt && baseIsOpt === headIsOpt) {
        staticFindings.push({
          id: findingId(
            base.method,
            base.path,
            base.version,
            headField.name,
            "ts-only-change",
          ),
          method: base.method,
          path: base.path,
          ...(base.version !== undefined ? { version: base.version } : {}),
          field: headField.name,
          changeKind: "ts-only-change",
          severity: "non-breaking",
          before: baseTsOpt ? "optional (?)" : "required",
          after: headTsOpt ? "optional (?)" : "required",
          ...(head.dtoName ? { dtoName: head.dtoName } : {}),
          ...src,
          message: `TypeScript-only optionality change on "${headField.name}" (${baseTsOpt ? "?" : "required"} -> ${headTsOpt ? "?" : "required"}) with no runtime validation change.`,
          candidatePayloads: [],
        });
      }
    }

    // Rule 3a: Added required field in head
    for (const headField of head.fields) {
      if (baseFieldMap.has(headField.name)) continue;
      if (headField.isOptional === true) continue;
      const isValidatedOrRequired =
        hasAnyValidator(headField) ||
        (headField.validators === undefined && headField.tsOptional !== true);
      if (!isValidatedOrRequired) continue;

      const src = resolveFieldSource(headField, head);
      // Old client payload: valid base payload (naturally omits the newly added head field)
      const oldPayload = buildPayloadWithSiblings(
        base.fields,
        headFieldMap,
        {},
        new Set([headField.name]),
        options.sampleValues,
      );
      staticFindings.push({
        id: findingId(
          base.method,
          base.path,
          base.version,
          headField.name,
          "required-field-added",
        ),
        method: base.method,
        path: base.path,
        ...(base.version !== undefined ? { version: base.version } : {}),
        field: headField.name,
        changeKind: "required-field-added",
        severity: "breaking-candidate",
        before: null,
        after: "required",
        ...(head.dtoName ? { dtoName: head.dtoName } : {}),
        ...src,
        message: `New required field "${headField.name}" added; old payloads omitting it may be rejected.`,
        candidatePayloads: [
          makeCandidate(
            "old-payload",
            `Old client payload omitting newly required "${headField.name}"`,
            oldPayload,
          ),
        ],
      });
    }

    // Rule 3b: Removed old field from head
    for (const baseField of base.fields) {
      if (headFieldMap.has(baseField.name)) continue;

      const src = resolveFieldSource(baseField, base);
      const classification = classifyRemovedField(options.pipeProfile);
      const removedSample = buildValidSampleValue(
        baseField,
        undefined,
        options.sampleValues,
      );
      const oldPayload = buildPayloadWithSiblings(
        base.fields,
        headFieldMap,
        { [baseField.name]: removedSample },
        new Set(),
        options.sampleValues,
      );

      staticFindings.push({
        id: findingId(
          base.method,
          base.path,
          base.version,
          baseField.name,
          "field-removed",
        ),
        method: base.method,
        path: base.path,
        ...(base.version !== undefined ? { version: base.version } : {}),
        field: baseField.name,
        changeKind: "field-removed",
        severity: classification.severity,
        unknownPropertyBehavior: classification.unknownPropertyBehavior,
        before: baseField.name,
        after: null,
        ...(base.dtoName ? { dtoName: base.dtoName } : {}),
        ...src,
        message: `Field "${baseField.name}" removed from DTO. ${classification.detail}`,
        candidatePayloads: [
          makeCandidate(
            "old-payload-with-removed-field",
            `Old client payload still sending removed field "${baseField.name}"`,
            oldPayload,
          ),
        ],
      });
    }
  }

  // Strict replay evidence matching
  const verified: VerifiedReplayEvidence[] = [];
  const warnings: string[] = [];
  let rejectedEvidenceCount = 0;

  if (options.replayEvidence && options.replayEvidence.length > 0) {
    const expectedBase = options.baseCommit?.trim();
    const expectedHead = options.headCommit?.trim();

    for (let i = 0; i < options.replayEvidence.length; i++) {
      const record = options.replayEvidence[i]!;
      const recMethod = normalizeMethod(record.method);
      const recPath = normalizePath(record.path);
      const recVersion = normalizeVersion(record.version);
      const recPayloadCanon = canonicalJson(record.payload);

      if (!expectedBase || !expectedHead) {
        rejectedEvidenceCount++;
        warnings.push(
          `Rejected replay evidence #${i} (${recMethod} ${recPath}): report baseCommit/headCommit must be provided to verify evidence provenance.`,
        );
        continue;
      }

      if (
        record.baseCommit !== expectedBase ||
        record.headCommit !== expectedHead
      ) {
        rejectedEvidenceCount++;
        warnings.push(
          `Rejected replay evidence #${i} (${recMethod} ${recPath}): commit mismatch (expected ${expectedBase}..${expectedHead}, got ${record.baseCommit}..${record.headCommit}).`,
        );
        continue;
      }

      let matched = false;
      for (const finding of staticFindings) {
        if (
          finding.method !== recMethod ||
          finding.path !== recPath ||
          (finding.version ?? undefined) !== recVersion
        ) {
          continue;
        }
        if (
          record.targetField !== undefined &&
          finding.field !== undefined &&
          record.targetField !== finding.field
        ) {
          continue;
        }

        const matchedCandidate = finding.candidatePayloads.find(
          (c) => c.canonicalJson === recPayloadCanon,
        );
        if (matchedCandidate) {
          verified.push({
            findingId: finding.id,
            candidateLabel: matchedCandidate.label,
            record,
          });
          matched = true;
          break;
        }
      }

      if (!matched) {
        rejectedEvidenceCount++;
        warnings.push(
          `Rejected replay evidence #${i} (${recMethod} ${recPath}): no static finding matched method, path, and canonical payload ${recPayloadCanon}.`,
        );
      }
    }
  }

  const breakingCandidates = staticFindings.filter(
    (f) => f.severity === "breaking-candidate",
  ).length;
  const behaviorChanges = staticFindings.filter(
    (f) => f.severity === "behavior-change",
  ).length;
  const nonBreaking = staticFindings.filter(
    (f) => f.severity === "non-breaking",
  ).length;
  const needsReview = staticFindings.filter(
    (f) => f.severity === "needs-review",
  ).length;
  const metadataMissing = staticFindings.filter(
    (f) => f.severity === "metadata-missing",
  ).length;

  let status: BodyContractDiffStatus = "safe";
  if (breakingCandidates > 0) {
    status = "breaking-candidates";
  } else if (needsReview > 0) {
    status = "needs-review";
  } else if (metadataMissing > 0) {
    status = "metadata-missing";
  } else if (behaviorChanges > 0) {
    status = "behavior-changes";
  }

  return {
    schemaVersion: "1.0",
    status,
    ...(options.baseCommit !== undefined ? { baseCommit: options.baseCommit } : {}),
    ...(options.headCommit !== undefined ? { headCommit: options.headCommit } : {}),
    ...(options.pipeProfile !== undefined ? { pipeProfile: options.pipeProfile } : {}),
    summary: {
      baseRouteCount: normBase.length,
      headRouteCount: normHead.length,
      comparedRouteCount,
      totalFindings: staticFindings.length,
      breakingCandidates,
      behaviorChanges,
      nonBreaking,
      needsReview,
      metadataMissing,
      verifiedEvidenceCount: verified.length,
      rejectedEvidenceCount,
    },
    staticFindings,
    replayEvidence: {
      verified,
      rejectedEvidenceCount,
      warnings,
    },
    rejectedEvidenceCount,
    warnings,
  };
}

function formatEvidenceLine(record: ReplayEvidenceRecord): string {
  if (record.verdict === "environment-error") {
    const detail =
      record.environmentError ?? `base ${record.baseStatus} -> head ${record.headStatus}`;
    return `Fixture evidence: environment error (${detail})`;
  }
  if (record.verdict === "stripped-accepted") {
    return `Fixture evidence: base ${record.baseStatus} -> head ${record.headStatus} (field stripped, not HTTP 400)`;
  }
  return `Fixture evidence: base ${record.baseStatus} -> head ${record.headStatus}`;
}

function formatFindingHeadline(finding: BodyContractDiffFinding): string {
  const ver = finding.version ? ` (v${finding.version})` : "";
  const route = `${finding.method} ${finding.path}${ver}`;
  const target = finding.field ? `body.${finding.field}` : "body";

  switch (finding.changeKind) {
    case "constraint-tightened":
    case "constraint-relaxed":
      return finding.constraint
        ? `${route}   ${target}   ${finding.constraint}: ${finding.before ?? "none"} -> ${finding.after ?? "none"}`
        : `${route}   ${target}   ${finding.before ?? "none"} -> ${finding.after ?? "none"}`;
    case "optional-removed":
      return `${route}   ${target}   @IsOptional() removed`;
    case "required-field-added":
      return `${route}   ${target}   required field added`;
    case "field-removed": {
      const behaviorTag = finding.unknownPropertyBehavior
        ? REMOVED_FIELD_BEHAVIOR_LABELS[finding.unknownPropertyBehavior]
        : "pipe behavior unconfigured";
      return `${route}   ${target}   field removed (${behaviorTag})`;
    }
    case "ts-only-change":
      return `${route}   ${target}   TS-only change (${finding.before} -> ${finding.after}, non-breaking)`;
    case "dto-renamed":
      return `${route}   ${target}   DTO renamed (${finding.before} -> ${finding.after}, non-breaking)`;
    case "unsupported-needs-review":
      return `${route}   ${target}   [needs-review:${finding.unsupportedKind ?? "unsupported"}] ${finding.message}`;
    case "missing-body-metadata":
      return `${route}   ${target}   [metadata-missing] ${finding.message}`;
  }
}

/**
 * Formats a `BodyContractDiffReport` into concise reviewer-first terminal text.
 */
export function formatBodyContractDiffPretty(
  report: BodyContractDiffReport,
): string {
  if (report.staticFindings.length === 0) {
    return "No body contract changes detected.";
  }

  const evidenceByFinding = new Map<string, VerifiedReplayEvidence[]>();
  for (const ev of report.replayEvidence.verified) {
    const list = evidenceByFinding.get(ev.findingId);
    if (list) {
      list.push(ev);
    } else {
      evidenceByFinding.set(ev.findingId, [ev]);
    }
  }

  const blocks: string[] = [];

  for (const finding of report.staticFindings) {
    const lines: string[] = [];
    lines.push(formatFindingHeadline(finding));

    if (finding.sourceFile) {
      const loc =
        finding.line !== undefined
          ? `${finding.sourceFile}:${finding.line}`
          : finding.sourceFile;
      lines.push(`Source: ${loc}`);
    }

    const matchedEvs = evidenceByFinding.get(finding.id) ?? [];

    if (finding.candidatePayloads.length === 1) {
      const candidate = finding.candidatePayloads[0]!;
      lines.push(`Payload to try: ${JSON.stringify(candidate.payload)}`);
      const ev = matchedEvs.find(
        (e) => !e.candidateLabel || e.candidateLabel === candidate.label,
      );
      if (ev) {
        lines.push(formatEvidenceLine(ev.record));
      }
    } else if (finding.candidatePayloads.length > 1) {
      for (const candidate of finding.candidatePayloads) {
        lines.push(
          `Payload to try (${candidate.label}): ${JSON.stringify(candidate.payload)}`,
        );
        const ev = matchedEvs.find((e) => e.candidateLabel === candidate.label);
        if (ev) {
          lines.push(formatEvidenceLine(ev.record));
        }
      }
    }

    blocks.push(lines.join("\n"));
  }

  if (report.summary.needsReview > 0) {
    blocks.push(
      `Manual review required: ${report.summary.needsReview} unsupported/dynamic validator item(s) could not be statically verified as safe.`,
    );
  }

  if (report.warnings.length > 0) {
    blocks.push(
      `Warnings (${report.warnings.length}):\n${report.warnings.map((w) => `  - ${w}`).join("\n")}`,
    );
  }

  return blocks.join("\n\n");
}

/**
 * Formats a `BodyContractDiffReport` as structured JSON separating
 * `staticFindings` from `replayEvidence`.
 */
export function formatBodyContractDiffJson(
  report: BodyContractDiffReport,
): string {
  return JSON.stringify(report, null, 2);
}
