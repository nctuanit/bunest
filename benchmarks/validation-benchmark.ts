import * as upstreamCT from "class-transformer";
import * as upstreamCV from "class-validator";
import * as nativeCT from "../packages/validation/src/transformer";
import * as nativeCV from "../packages/validation/src/validator";
import {
  existsSyncPath,
  join,
  readDirSyncEntries,
  resolve,
  statSyncPath,
  ValidationPipe,
} from "../packages/core/src";

// --- Native DTOs ---
class NativeAddressDto {
  @nativeCV.IsString()
  @nativeCV.MinLength(2)
  city!: string;

  @nativeCV.IsString()
  @nativeCV.MinLength(2)
  country!: string;
}

class NativeCreateUserDto {
  @nativeCV.IsEmail()
  email!: string;

  @nativeCV.IsString()
  @nativeCV.MinLength(2)
  @nativeCV.MaxLength(80)
  name!: string;

  @nativeCV.IsInt()
  @nativeCV.Min(18)
  @nativeCV.Max(120)
  age!: number;
}

class NativeNestedUserDto extends NativeCreateUserDto {
  @nativeCV.ValidateNested()
  @nativeCT.Type(() => NativeAddressDto)
  address!: NativeAddressDto;
}

class NativeUserEntity {
  @nativeCT.Expose()
  id!: string;

  @nativeCT.Expose({ name: "email_address" })
  email!: string;

  @nativeCT.Exclude()
  passwordHash!: string;

  @nativeCT.Expose()
  get label(): string {
    return `${this.id}:${this.email}`;
  }
}

// --- Upstream DTOs ---
class UpstreamAddressDto {
  @upstreamCV.IsString()
  @upstreamCV.MinLength(2)
  city!: string;

  @upstreamCV.IsString()
  @upstreamCV.MinLength(2)
  country!: string;
}

class UpstreamCreateUserDto {
  @upstreamCV.IsEmail()
  email!: string;

  @upstreamCV.IsString()
  @upstreamCV.MinLength(2)
  @upstreamCV.MaxLength(80)
  name!: string;

  @upstreamCV.IsInt()
  @upstreamCV.Min(18)
  @upstreamCV.Max(120)
  age!: number;
}

class UpstreamNestedUserDto extends UpstreamCreateUserDto {
  @upstreamCV.ValidateNested()
  @upstreamCT.Type(() => UpstreamAddressDto)
  address!: UpstreamAddressDto;
}

class UpstreamUserEntity {
  @upstreamCT.Expose()
  id!: string;

  @upstreamCT.Expose({ name: "email_address" })
  email!: string;

  @upstreamCT.Exclude()
  passwordHash!: string;

  @upstreamCT.Expose()
  get label(): string {
    return `${this.id}:${this.email}`;
  }
}

const FLAT_PAYLOAD = {
  email: "alice@bunest.dev",
  name: "Alice Lovelace",
  age: 29,
};

const INVALID_FLAT_PAYLOAD = {
  email: "not-an-email",
  name: "A",
  age: 12,
};

const NESTED_PAYLOAD = {
  email: "alice@bunest.dev",
  name: "Alice Lovelace",
  age: 29,
  address: { city: "Ho Chi Minh", country: "VN" },
};

interface BenchRow {
  readonly label: string;
  readonly nativeOpsSec: number;
  readonly upstreamOpsSec: number;
  readonly speedup: number;
}

function benchSync(iterations: number, warmup: number, fn: () => void): number {
  for (let i = 0; i < warmup; i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsedSec = (performance.now() - start) / 1000;
  return Math.round(iterations / elapsedSec);
}

async function benchAsync(
  iterations: number,
  warmup: number,
  fn: () => Promise<unknown>,
): Promise<number> {
  for (let i = 0; i < warmup; i++) await fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const elapsedSec = (performance.now() - start) / 1000;
  return Math.round(iterations / elapsedSec);
}

function dirSizeKb(dir: string): number {
  if (!existsSyncPath(dir)) return 0;
  let total = 0;
  for (const entry of readDirSyncEntries(dir)) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeKb(full) * 1024;
    else if (entry.isFile()) total += statSyncPath(full).size;
  }
  return Math.round((total / 1024) * 10) / 10;
}

async function main(): Promise<void> {
  const ITER = 50_000;
  const WARMUP = 5_000;
  const rows: BenchRow[] = [];

  // 1. plainToInstance (flat)
  {
    const nativeOps = benchSync(ITER, WARMUP, () => {
      nativeCT.plainToInstance(NativeCreateUserDto, FLAT_PAYLOAD);
    });
    const upstreamOps = benchSync(ITER, WARMUP, () => {
      upstreamCT.plainToInstance(UpstreamCreateUserDto, FLAT_PAYLOAD);
    });
    rows.push({
      label: "plainToInstance (flat DTO)",
      nativeOpsSec: nativeOps,
      upstreamOpsSec: upstreamOps,
      speedup: nativeOps / upstreamOps,
    });
  }

  // 2. validate (flat valid DTO, sync/maybeSync vs upstream async)
  {
    const nInst = nativeCT.plainToInstance(NativeCreateUserDto, FLAT_PAYLOAD);
    const uInst = upstreamCT.plainToInstance(
      UpstreamCreateUserDto,
      FLAT_PAYLOAD,
    );
    const opts = {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
    };
    const nativeOps = benchSync(ITER, WARMUP, () => {
      nativeCV.validateMaybeSync(nInst, opts);
    });
    const upstreamOps = await benchAsync(ITER, WARMUP, () =>
      upstreamCV.validate(uInst, opts),
    );
    rows.push({
      label: "validate (flat valid DTO)",
      nativeOpsSec: nativeOps,
      upstreamOpsSec: upstreamOps,
      speedup: nativeOps / upstreamOps,
    });
  }

  // 3. validate (flat invalid DTO — error path)
  {
    const nInst = nativeCT.plainToInstance(
      NativeCreateUserDto,
      INVALID_FLAT_PAYLOAD,
    );
    const uInst = upstreamCT.plainToInstance(
      UpstreamCreateUserDto,
      INVALID_FLAT_PAYLOAD,
    );
    const opts = {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
    };
    const nativeOps = benchSync(ITER, WARMUP, () => {
      nativeCV.validateMaybeSync(nInst, opts);
    });
    const upstreamOps = await benchAsync(ITER, WARMUP, () =>
      upstreamCV.validate(uInst, opts),
    );
    rows.push({
      label: "validate (flat invalid DTO)",
      nativeOpsSec: nativeOps,
      upstreamOpsSec: upstreamOps,
      speedup: nativeOps / upstreamOps,
    });
  }

  // 4. Combined ValidationPipe (flat DTO)
  {
    const pipe = new ValidationPipe();
    const nativeOps = await benchAsync(ITER, WARMUP, () =>
      pipe.transform(FLAT_PAYLOAD, {
        type: "body",
        metatype: NativeCreateUserDto,
      }),
    );
    const upstreamOps = await benchAsync(ITER, WARMUP, () =>
      pipe.transform(FLAT_PAYLOAD, {
        type: "body",
        metatype: UpstreamCreateUserDto,
      }),
    );
    rows.push({
      label: "ValidationPipe.transform (flat DTO)",
      nativeOpsSec: nativeOps,
      upstreamOpsSec: upstreamOps,
      speedup: nativeOps / upstreamOps,
    });
  }

  // 5. Combined ValidationPipe (nested DTO)
  {
    const pipe = new ValidationPipe();
    const nativeOps = await benchAsync(ITER, WARMUP, () =>
      pipe.transform(NESTED_PAYLOAD, {
        type: "body",
        metatype: NativeNestedUserDto,
      }),
    );
    const upstreamOps = await benchAsync(ITER, WARMUP, () =>
      pipe.transform(NESTED_PAYLOAD, {
        type: "body",
        metatype: UpstreamNestedUserDto,
      }),
    );
    rows.push({
      label: "ValidationPipe.transform (nested DTO)",
      nativeOpsSec: nativeOps,
      upstreamOpsSec: upstreamOps,
      speedup: nativeOps / upstreamOps,
    });
  }

  // 6. instanceToPlain (@Exclude + @Expose + getter)
  {
    const nEntity = Object.assign(new NativeUserEntity(), {
      id: "u1",
      email: "alice@bunest.dev",
      passwordHash: "secret",
    });
    const uEntity = Object.assign(new UpstreamUserEntity(), {
      id: "u1",
      email: "alice@bunest.dev",
      passwordHash: "secret",
    });
    const nativeOps = benchSync(ITER, WARMUP, () => {
      nativeCT.instanceToPlain(nEntity);
    });
    const upstreamOps = benchSync(ITER, WARMUP, () => {
      upstreamCT.instanceToPlain(uEntity);
    });
    rows.push({
      label: "instanceToPlain (@Exclude/@Expose/getter)",
      nativeOpsSec: nativeOps,
      upstreamOpsSec: upstreamOps,
      speedup: nativeOps / upstreamOps,
    });
  }

  console.log(`\nBunest Native Validation Engine vs Upstream (Bun v${Bun.version}, ${ITER.toLocaleString()} ops/benchmark)\n`);
  console.log("| Benchmark | @bunest/validation (ops/s) | Upstream CV+CT (ops/s) | Speedup |");
  console.log("|---|---:|---:|---:|");
  for (const r of rows) {
    console.log(
      `| ${r.label} | ${r.nativeOpsSec.toLocaleString()} | ${r.upstreamOpsSec.toLocaleString()} | **${r.speedup.toFixed(2)}x** |`,
    );
  }

  const root = resolve(import.meta.dir, "..");
  const nativeDistKb = dirSizeKb(join(root, "packages/validation/dist"));
  const upstreamDeps = [
    "class-validator",
    "class-transformer",
    "validator",
    "libphonenumber-js",
    "@types/validator",
  ];
  let upstreamTotalKb = 0;
  for (const dep of upstreamDeps) {
    upstreamTotalKb += dirSizeKb(join(root, "node_modules", dep));
  }
  console.log(
    `\nDisk footprint: @bunest/validation/dist = ${nativeDistKb.toFixed(1)} KB (0 external deps) vs upstream CV+CT closure = ${(upstreamTotalKb / 1024).toFixed(2)} MB (${upstreamDeps.length} npm pkgs) — ${((1 - nativeDistKb / upstreamTotalKb) * 100).toFixed(1)}% smaller\n`,
  );
}

await main();
