import { existsSyncPath, relative, resolve, statPath } from "@bunest/core";
import type { CliIO } from "../types";

export type CronCommandOutputFormat = "pretty" | "json";

const OS_CRON_TITLE_RE = /^[A-Za-z0-9_-]+$/;

export interface CronParseCommandOptions {
  readonly expression: string;
  readonly tz?: string;
  readonly from?: string | number | Date;
  readonly count?: number;
  readonly format?: CronCommandOutputFormat;
  readonly silent?: boolean;
}

export interface CronParseCommandResult {
  readonly exitCode: number;
  readonly expression: string;
  readonly timeZone?: string;
  readonly from: string;
  readonly occurrences: readonly string[];
  readonly error?: string;
}

export interface CronRegisterCommandOptions {
  readonly file: string;
  readonly schedule: string;
  readonly title: string;
  readonly cwd?: string;
  readonly dryRun?: boolean;
  readonly format?: CronCommandOutputFormat;
  readonly silent?: boolean;
  readonly registerFn?: (
    path: string,
    schedule: string,
    title: string,
  ) => Promise<void>;
}

export interface CronRegisterCommandResult {
  readonly exitCode: number;
  readonly title: string;
  readonly schedule: string;
  readonly path: string;
  readonly nextRun?: string;
  readonly dryRun: boolean;
  readonly error?: string;
}

export interface CronRemoveCommandOptions {
  readonly title: string;
  readonly dryRun?: boolean;
  readonly format?: CronCommandOutputFormat;
  readonly silent?: boolean;
  readonly removeFn?: (title: string) => Promise<void>;
}

export interface CronRemoveCommandResult {
  readonly exitCode: number;
  readonly title: string;
  readonly dryRun: boolean;
  readonly error?: string;
}

export interface CronRunCommandOptions {
  readonly file: string;
  readonly schedule?: string;
  readonly scheduledTime?: string | number | Date;
  readonly cwd?: string;
  readonly format?: CronCommandOutputFormat;
  readonly silent?: boolean;
}

export interface CronRunCommandResult {
  readonly exitCode: number;
  readonly path: string;
  readonly controller: {
    readonly type: "scheduled";
    readonly cron: string;
    readonly scheduledTime: number;
  };
  readonly durationMs: number;
  readonly error?: string;
}

function parseReferenceDate(input: string | number | Date | undefined): Date {
  if (input === undefined) {
    return new Date();
  }
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      throw new Error("Invalid reference Date value.");
    }
    return new Date(input.getTime());
  }
  if (typeof input === "number") {
    const d = new Date(input);
    if (!Number.isFinite(input) || Number.isNaN(d.getTime())) {
      throw new Error(`Invalid timestamp "${String(input)}".`);
    }
    return d;
  }
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    const num = Number.parseInt(trimmed, 10);
    const d = new Date(num);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid epoch timestamp "${input}".`);
    }
    return d;
  }
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    throw new Error(
      `Invalid date/time "${input}": expected an ISO-8601 date string or epoch milliseconds.`,
    );
  }
  return d;
}

function validateCronTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0 || !OS_CRON_TITLE_RE.test(trimmed)) {
    throw new Error(
      `Invalid cron title "${title}": expected only alphanumeric characters, hyphens, and underscores (/^[A-Za-z0-9_-]+$/).`,
    );
  }
  return trimmed;
}

/**
 * Parses a 5-field cron expression or nickname via native `Bun.cron.parse()`
 * and previews upcoming execution timestamps (`bunest cron parse <expr>`).
 */
export async function runCronParseCommand(
  options: CronParseCommandOptions,
  io?: CliIO,
): Promise<CronParseCommandResult> {
  const format = options.format ?? "pretty";
  const count = options.count ?? 5;
  const expression = options.expression.trim();

  try {
    if (!expression) {
      throw new Error("Cron expression cannot be empty.");
    }
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      throw new Error(
        `Invalid --count value "${String(count)}": expected an integer between 1 and 100.`,
      );
    }

    const fromDate = parseReferenceDate(options.from);
    const parseOpts = options.tz ? { tz: options.tz } : undefined;
    const occurrences: string[] = [];

    let cursor: Date = fromDate;
    for (let i = 0; i < count; i += 1) {
      const next = parseOpts
        ? Bun.cron.parse(expression, cursor, parseOpts)
        : Bun.cron.parse(expression, cursor);
      if (next === null) {
        if (i === 0) {
          throw new Error(
            `Cron expression "${expression}" has no matching date within 8 years.`,
          );
        }
        break;
      }
      occurrences.push(next.toISOString());
      cursor = next;
    }

    const result: CronParseCommandResult = {
      exitCode: 0,
      expression,
      ...(options.tz ? { timeZone: options.tz } : {}),
      from: fromDate.toISOString(),
      occurrences,
    };

    if (io && !options.silent) {
      if (format === "json") {
        io.stdout(JSON.stringify(result, null, 2));
      } else {
        const tzLabel = options.tz ?? "local";
        io.stdout(
          `Cron "${expression}" (tz=${tzLabel}, from=${result.from}) — next ${occurrences.length} run(s):`,
        );
        for (let i = 0; i < occurrences.length; i += 1) {
          io.stdout(`  ${i + 1}. ${occurrences[i]}`);
        }
      }
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: CronParseCommandResult = {
      exitCode: 1,
      expression,
      ...(options.tz ? { timeZone: options.tz } : {}),
      from: new Date().toISOString(),
      occurrences: [],
      error: message,
    };
    if (io && !options.silent) {
      if (format === "json") {
        io.stdout(JSON.stringify(result, null, 2));
      } else {
        io.stderr(`Error: ${message}`);
      }
    }
    return result;
  }
}

/**
 * Registers an OS-level cron job via native `Bun.cron(path, schedule, title)`
 * (`bunest cron register <file> "<schedule>" <title>`).
 */
export async function runCronRegisterCommand(
  options: CronRegisterCommandOptions,
  io?: CliIO,
): Promise<CronRegisterCommandResult> {
  const cwd = options.cwd ?? io?.cwd ?? process.cwd();
  const format = options.format ?? "pretty";
  const dryRun = options.dryRun ?? false;
  const resolvedPath = resolve(cwd, options.file);

  try {
    const title = validateCronTitle(options.title);
    const schedule = options.schedule.trim();
    if (!schedule) {
      throw new Error("Cron schedule cannot be empty.");
    }

    if (!existsSyncPath(resolvedPath)) {
      throw new Error(`Cron module file not found: ${resolvedPath}`);
    }
    const info = await statPath(resolvedPath);
    if (!info.isFile()) {
      throw new Error(`Cron module path is not a file: ${resolvedPath}`);
    }

    const next = Bun.cron.parse(schedule, new Date());
    if (next === null) {
      throw new Error(
        `Cron schedule "${schedule}" has no matching date within 8 years.`,
      );
    }

    if (!dryRun) {
      const registerFn =
        options.registerFn ??
        ((p: string, s: string, t: string) => Bun.cron(p, s, t));
      await registerFn(resolvedPath, schedule, title);
    }

    const result: CronRegisterCommandResult = {
      exitCode: 0,
      title,
      schedule,
      path: resolvedPath,
      nextRun: next.toISOString(),
      dryRun,
    };

    if (io && !options.silent) {
      if (format === "json") {
        io.stdout(JSON.stringify(result, null, 2));
      } else {
        const rel = relative(cwd, resolvedPath).replace(/\\/g, "/");
        const prefix = dryRun ? "[dry-run] Would register" : "Registered";
        io.stdout(
          `${prefix} OS cron "${title}" (${schedule}) -> ${rel} (next: ${result.nextRun})`,
        );
      }
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: CronRegisterCommandResult = {
      exitCode: 1,
      title: options.title,
      schedule: options.schedule,
      path: resolvedPath,
      dryRun,
      error: message,
    };
    if (io && !options.silent) {
      if (format === "json") {
        io.stdout(JSON.stringify(result, null, 2));
      } else {
        io.stderr(`Error: ${message}`);
      }
    }
    return result;
  }
}

/**
 * Unregisters an OS-level cron job via native `Bun.cron.remove(title)`
 * (`bunest cron remove <title>`).
 */
export async function runCronRemoveCommand(
  options: CronRemoveCommandOptions,
  io?: CliIO,
): Promise<CronRemoveCommandResult> {
  const format = options.format ?? "pretty";
  const dryRun = options.dryRun ?? false;

  try {
    const title = validateCronTitle(options.title);
    if (!dryRun) {
      const removeFn =
        options.removeFn ?? ((t: string) => Bun.cron.remove(t));
      await removeFn(title);
    }

    const result: CronRemoveCommandResult = {
      exitCode: 0,
      title,
      dryRun,
    };

    if (io && !options.silent) {
      if (format === "json") {
        io.stdout(JSON.stringify(result, null, 2));
      } else {
        const prefix = dryRun ? "[dry-run] Would remove" : "Removed";
        io.stdout(`${prefix} OS cron "${title}".`);
      }
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: CronRemoveCommandResult = {
      exitCode: 1,
      title: options.title,
      dryRun,
      error: message,
    };
    if (io && !options.silent) {
      if (format === "json") {
        io.stdout(JSON.stringify(result, null, 2));
      } else {
        io.stderr(`Error: ${message}`);
      }
    }
    return result;
  }
}

/**
 * Locally invokes an OS-level cron module's `default.scheduled(controller)`
 * handler on demand (`bunest cron run <file> [--schedule <expr>] [--time <iso|ms>]`).
 */
export async function runCronRunCommand(
  options: CronRunCommandOptions,
  io?: CliIO,
): Promise<CronRunCommandResult> {
  const cwd = options.cwd ?? io?.cwd ?? process.cwd();
  const format = options.format ?? "pretty";
  const resolvedPath = resolve(cwd, options.file);
  const cronExpr = options.schedule?.trim() || "* * * * *";

  let scheduledTime = Date.now();
  try {
    scheduledTime = parseReferenceDate(options.scheduledTime).getTime();
    if (!existsSyncPath(resolvedPath)) {
      throw new Error(`Cron module file not found: ${resolvedPath}`);
    }
    const info = await statPath(resolvedPath);
    if (!info.isFile()) {
      throw new Error(`Cron module path is not a file: ${resolvedPath}`);
    }

    const controller = {
      type: "scheduled" as const,
      cron: cronExpr,
      scheduledTime,
    };

    const startMs = performance.now();
    const mod = (await import(Bun.pathToFileURL(resolvedPath).href)) as {
      default?: {
        scheduled?: (ctrl: typeof controller) => unknown | Promise<unknown>;
      };
    };

    if (!mod.default || typeof mod.default.scheduled !== "function") {
      throw new Error(
        `Cron module "${resolvedPath}" must export a default object with a scheduled(controller) method (e.g. export default defineOsCronJob(...)).`,
      );
    }

    await mod.default.scheduled(controller);
    const durationMs = Math.round((performance.now() - startMs) * 100) / 100;

    const result: CronRunCommandResult = {
      exitCode: 0,
      path: resolvedPath,
      controller,
      durationMs,
    };

    if (io && !options.silent) {
      if (format === "json") {
        io.stdout(JSON.stringify(result, null, 2));
      } else {
        const rel = relative(cwd, resolvedPath).replace(/\\/g, "/");
        io.stdout(
          `Executed scheduled() in ${rel} (cron="${cronExpr}", duration=${durationMs.toFixed(1)}ms).`,
        );
      }
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: CronRunCommandResult = {
      exitCode: 1,
      path: resolvedPath,
      controller: {
        type: "scheduled",
        cron: cronExpr,
        scheduledTime,
      },
      durationMs: 0,
      error: message,
    };
    if (io && !options.silent) {
      if (format === "json") {
        io.stdout(JSON.stringify(result, null, 2));
      } else {
        io.stderr(`Error: ${message}`);
      }
    }
    return result;
  }
}
