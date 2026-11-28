import type { ConfigObject } from "./interfaces/config.interface";

/**
 * Structural subset of Bun's OS keychain API (`Bun.secrets`) allowing clean
 * dependency injection / mocking in tests without touching the host keychain.
 */
export interface BunSecretsBackend {
  get(options: { readonly service: string; readonly name: string }): Promise<string | null>;
  set(options: {
    readonly service: string;
    readonly name: string;
    readonly value: string;
  }): Promise<void>;
  delete(options: { readonly service: string; readonly name: string }): Promise<boolean>;
}

const DANGEROUS_SECRET_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function getDefaultSecretsBackend(): BunSecretsBackend {
  const secrets =
    typeof Bun !== "undefined"
      ? (Bun as unknown as { secrets?: BunSecretsBackend }).secrets
      : undefined;
  if (!secrets || typeof secrets.get !== "function") {
    throw new Error(
      "Bun.secrets is unavailable in the current runtime (requires Bun >= 1.4.5 with OS keychain support).",
    );
  }
  return secrets;
}

/**
 * Reads a secret from the OS keychain via `Bun.secrets.get({ service, name })`.
 */
export async function getKeychainSecret(
  service: string,
  name: string,
  backend: BunSecretsBackend = getDefaultSecretsBackend(),
): Promise<string | null> {
  return await backend.get({ service, name });
}

/**
 * Stores a secret in the OS keychain via `Bun.secrets.set({ service, name, value })`.
 */
export async function setKeychainSecret(
  service: string,
  name: string,
  value: string,
  backend: BunSecretsBackend = getDefaultSecretsBackend(),
): Promise<void> {
  await backend.set({ service, name, value });
}

/**
 * Deletes a secret from the OS keychain via `Bun.secrets.delete({ service, name })`.
 */
export async function deleteKeychainSecret(
  service: string,
  name: string,
  backend: BunSecretsBackend = getDefaultSecretsBackend(),
): Promise<boolean> {
  return await backend.delete({ service, name });
}

export interface LoadKeychainSecretsOptions {
  /** OS keychain service identifier (e.g. `"com.acme.my-api"`). */
  readonly service: string;
  /**
   * Secret names to read from the keychain. Pass an array (`["API_KEY"]`) to
   * keep identical config keys, or a record (`{ apiKey: "API_KEY" }`) to map
   * keychain names to config keys.
   */
  readonly keys: readonly string[] | Readonly<Record<string, string>>;
  /**
   * When `true` (default), silently omits secrets that fail to read (e.g. headless
   * CI environments without an OS keychain) instead of failing bootstrap.
   * @default true
   */
  readonly ignoreErrors?: boolean;
  /** Optional custom `Bun.secrets`-compatible backend (primarily for testing). */
  readonly backend?: BunSecretsBackend;
}

/**
 * Creates a `ConfigFactory` for `ConfigModule.forRoot({ load: [loadKeychainSecrets(...)] })`
 * that loads secrets directly from the OS keychain via `Bun.secrets.get()`.
 */
export function loadKeychainSecrets(
  options: LoadKeychainSecretsOptions,
): () => Promise<ConfigObject> {
  const ignoreErrors = options.ignoreErrors ?? true;
  const entries: ReadonlyArray<readonly [string, string]> = Array.isArray(
    options.keys,
  )
    ? options.keys.map((k) => [k, k] as const)
    : Object.entries(options.keys);

  return async (): Promise<ConfigObject> => {
    const out: ConfigObject = {};
    let backend: BunSecretsBackend;
    try {
      backend = options.backend ?? getDefaultSecretsBackend();
    } catch (err) {
      if (ignoreErrors) return out;
      throw err;
    }

    await Promise.all(
      entries.map(async ([configKey, secretName]) => {
        try {
          if (DANGEROUS_SECRET_KEYS.has(configKey)) {
            return;
          }
          const val = await backend.get({
            service: options.service,
            name: secretName,
          });
          if (val !== null && val !== undefined) {
            Object.defineProperty(out, configKey, {
              value: val,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }
        } catch (err) {
          if (!ignoreErrors) {
            throw err;
          }
        }
      }),
    );

    return out;
  };
}
