import {
  Logger,
  Module,
  type DynamicModule,
  type ModuleExport,
  type ModuleImport,
} from "../common/index";
import { ConfigModule } from "./config.module";

function getInstanceName(instance: unknown): string {
  if (instance && typeof instance === "object") {
    if (
      "forwardRef" in instance &&
      typeof (instance as { forwardRef?: unknown }).forwardRef === "function"
    ) {
      const target = (
        instance as { forwardRef: () => { name?: string } | undefined }
      ).forwardRef();
      if (target?.name) return target.name;
    }
    if ("module" in instance) {
      const mod = (instance as { module?: { name?: string } }).module;
      if (mod?.name) return mod.name;
    }
  }
  if (typeof instance === "function" && instance.name) {
    return instance.name;
  }
  return String(instance);
}

export interface ConditionalModuleOptions {
  /**
   * Maximum milliseconds to wait for `ConfigModule.envVariablesLoaded` before rejecting.
   * Defaults to `5000`.
   */
  timeout?: number;
  /**
   * Log a debug message when a module is skipped because its condition evaluated to `false`.
   * Defaults to `true`.
   */
  debug?: boolean;
}

/**
 * Conditionally registers a NestJS/Bunest module based on an environment variable flag
 * or predicate after `ConfigModule.envVariablesLoaded` resolves.
 */
@Module({})
export class ConditionalModule {
  static async registerWhen(
    module: ModuleImport,
    condition: string | ((env: NodeJS.ProcessEnv) => boolean),
    options?: ConditionalModuleOptions,
  ): Promise<Required<Pick<DynamicModule, "exports" | "imports" | "module">>> {
    const { timeout = 5000, debug = true } = options ?? {};
    const moduleName = getInstanceName(module);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Bunest was not able to resolve the config variables within ${timeout} milliseconds. Because of this, the ConditionalModule was not able to determine if ${moduleName} should be registered or not`,
          ),
        );
      }, timeout);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    });

    const predicate: (env: NodeJS.ProcessEnv) => boolean =
      typeof condition === "string"
        ? (env) => env[condition]?.toLowerCase() !== "false"
        : condition;

    try {
      await Promise.race([ConfigModule.envVariablesLoaded, timeoutPromise]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    const imports: ModuleImport[] = [];
    const exportsList: ModuleExport[] = [];

    const evaluation = predicate(process.env);
    if (evaluation) {
      imports.push(module);
      exportsList.push(module);
    } else if (debug) {
      Logger.debug(
        `${predicate.toString()} evaluated to false. Skipping the registration of ${moduleName}`,
        ConditionalModule.name,
      );
    }

    return {
      module: ConditionalModule,
      imports,
      exports: exportsList,
    };
  }
}
