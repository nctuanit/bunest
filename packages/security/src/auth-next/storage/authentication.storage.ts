import { Inject, Injectable, Logger, Optional } from "@bunest/core";
import { InMemoryEmailTokenStore } from "../account/in-memory-email-token.store";
import { AUTHENTICATION_STORAGE_REQUIREMENTS } from "../authentication.constants";
import type {
  AuthenticationStorageContract,
  AuthenticationStorageRegisterOptions,
  AuthenticationStorageSources,
} from "../interfaces/authentication-storage.interface";
import type { EmailTokenStore } from "../interfaces/email-token-store.interface";
import type { MagicLinkStore } from "../interfaces/magic-link-store.interface";
import type { MfaStore } from "../interfaces/mfa-store.interface";
import type { OidcStateStore } from "../interfaces/oidc-state-store.interface";
import type { RefreshTokenStore } from "../interfaces/refresh-token-store.interface";
import type { SessionStore } from "../interfaces/session-store.interface";
import { InMemoryRefreshTokenStore } from "../jwt/in-memory-refresh-token.store";
import { InMemoryMagicLinkStore } from "../magic-link/in-memory-magic-link.store";
import { InMemoryMfaStore } from "../mfa/in-memory-mfa.store";
import { InMemoryOidcStateStore } from "../oidc/in-memory-oidc-state.store";
import { InMemorySessionStore } from "../session/in-memory-session.store";

/**
 * @internal What each feature reads or writes, audited against the code
 * paths: the production guard's rule.
 */
export const CONTRACTS_BY_FEATURE = {
  sessionCookie: ["sessions"],
  refreshToken: ["refreshTokens"],
  mfa: ["mfa"],
  magicLink: ["sessions", "magicLinks"],
  oidc: ["sessions", "oidcStates"],
  passwordReset: ["sessions", "emailTokens"],
  emailVerification: ["emailTokens"],
} as const satisfies Record<string, readonly AuthenticationStorageContract[]>;

/** @internal */
export type AuthenticationFeature = keyof typeof CONTRACTS_BY_FEATURE;

/** @internal The contracts the features use, in the order messages list them. */
export function contractsUsedBy(
  features: Iterable<AuthenticationFeature>,
): AuthenticationStorageContract[] {
  const used = new Set<AuthenticationStorageContract>();
  for (const feature of features) {
    for (const contract of CONTRACTS_BY_FEATURE[feature]) {
      used.add(contract);
    }
  }
  return CONTRACT_NAMES.filter((contract) => used.has(contract));
}

/** @internal What the configured features need from storage, computed by the module from its options. */
export interface AuthenticationStorageRequirements {
  contracts: AuthenticationStorageContract[];
  allowInMemoryStorage: boolean;
}

interface ContractSpec {
  interfaceName: string;
  holds: string;
  methods: readonly string[];
  inMemory: () => object;
}

/** @internal Every contract, in the order they are listed in messages. */
export const STORAGE_CONTRACTS: Record<
  AuthenticationStorageContract,
  ContractSpec
> = {
  sessions: {
    interfaceName: "SessionStore",
    holds: "sessions",
    methods: [
      "getSession",
      "createSession",
      "touchSession",
      "deleteSession",
      "listUserSessions",
      "deleteUserSessions",
    ],
    inMemory: () => new InMemorySessionStore(),
  },
  refreshTokens: {
    interfaceName: "RefreshTokenStore",
    holds: "refresh tokens",
    methods: [
      "getRefreshToken",
      "saveRefreshToken",
      "markRefreshTokenUsed",
      "revokeRefreshTokenFamily",
      "isRefreshTokenFamilyRevoked",
      "revokeUserRefreshTokens",
    ],
    inMemory: () => new InMemoryRefreshTokenStore(),
  },
  mfa: {
    interfaceName: "MfaStore",
    holds: "authenticators and recovery codes",
    methods: [
      "getTotp",
      "saveTotp",
      "claimTotpStep",
      "saveRecoveryCodes",
      "consumeRecoveryCode",
      "countRecoveryCodes",
      "recordMfaFailure",
      "countMfaFailures",
      "clearMfaFailures",
    ],
    inMemory: () => new InMemoryMfaStore(),
  },
  magicLinks: {
    interfaceName: "MagicLinkStore",
    holds: "pending magic links",
    methods: ["saveMagicLink", "consumeMagicLink"],
    inMemory: () => new InMemoryMagicLinkStore(),
  },
  oidcStates: {
    interfaceName: "OidcStateStore",
    holds: "OIDC logins in progress",
    methods: ["saveOidcState", "consumeOidcState"],
    inMemory: () => new InMemoryOidcStateStore(),
  },
  emailTokens: {
    interfaceName: "EmailTokenStore",
    holds: "password reset and verification links",
    methods: ["saveEmailToken", "consumeEmailToken", "deleteUserEmailTokens"],
    inMemory: () => new InMemoryEmailTokenStore(),
  },
};

const CONTRACT_NAMES = Object.keys(
  STORAGE_CONTRACTS,
) as AuthenticationStorageContract[];
const KNOWN = CONTRACT_NAMES.map(
  (name) => `${name} (${STORAGE_CONTRACTS[name].interfaceName})`,
).join(", ");
const DEFAULT =
  "in-memory stores (the default: state is lost on restart and not shared between instances)";

/** @internal Locks the registry. `AuthenticationModule.onModuleInit()` and the first read call it. */
export const LOCK_STORAGE: unique symbol = Symbol("AuthenticationStorage.lock");

/**
 * Where the module keeps its state. The app registers its own stores here,
 * from the constructor of an ordinary provider.
 */
@Injectable()
export class AuthenticationStorage {
  private static readonly logger = new Logger("AuthenticationModule");
  private readonly registered = new Map<
    AuthenticationStorageContract,
    object
  >();
  private readonly active = new Map<AuthenticationStorageContract, object>();
  private locked = false;

  constructor(
    @Optional()
    @Inject(AUTHENTICATION_STORAGE_REQUIREMENTS)
    private readonly requirements?: AuthenticationStorageRequirements,
  ) {}

  /**
   * Registers stores by contract: `{ sessions: this, refreshTokens: this }`.
   */
  registerSource(
    sources: AuthenticationStorageSources,
    options: AuthenticationStorageRegisterOptions = {},
  ): void {
    const entries = validate(sources);
    if (this.locked) {
      throw new Error(
        `AuthenticationStorage.registerSource(): ${describe(entries)} registered after AuthenticationModule initialized ` +
          `(or after its storage was first read), which already uses ${this.summary(CONTRACT_NAMES)}. Register from ` +
          "the constructor of a singleton provider: providers of lazy-loaded modules, request-scoped and transient " +
          "providers, and lifecycle hooks run too late.",
      );
    }
    if (!options.replace) {
      for (const [contract, source] of entries) {
        const previous = this.registered.get(contract);
        if (previous) {
          throw new Error(
            `AuthenticationStorage.registerSource(): ${nameOf(source)} can't register \`${contract}\`, ` +
              `${previous === source ? "it already did (the same instance, twice)" : `${nameOf(previous)} already did`}. ` +
              "Register each contract once, or pass { replace: true } to replace it on purpose (tests, wrappers).",
          );
        }
      }
    }
    for (const [contract, source] of entries) {
      this.registered.set(contract, source);
    }
  }

  /** The active session store: the registered one, else the in-memory default. Reading it locks the registry. */
  get sessions(): SessionStore {
    return this.source("sessions") as SessionStore;
  }

  get refreshTokens(): RefreshTokenStore {
    return this.source("refreshTokens") as RefreshTokenStore;
  }

  get mfa(): MfaStore {
    return this.source("mfa") as MfaStore;
  }

  get magicLinks(): MagicLinkStore {
    return this.source("magicLinks") as MagicLinkStore;
  }

  get oidcStates(): OidcStateStore {
    return this.source("oidcStates") as OidcStateStore;
  }

  get emailTokens(): EmailTokenStore {
    return this.source("emailTokens") as EmailTokenStore;
  }

  /**
   * @internal Freezes the sources, logs them, and enforces the production guard.
   */
  [LOCK_STORAGE]({ log = true }: { log?: boolean } = {}): void {
    if (this.locked) {
      return;
    }
    const inUse = this.requirements?.contracts ?? [];
    const missing = inUse.filter((contract) => !this.registered.has(contract));
    if (missing.length > 0 && this.refusesInMemory()) {
      throw new Error(productionError(missing));
    }
    this.locked = true;
    for (const [contract, source] of this.registered) {
      this.active.set(contract, source);
    }
    if (log) {
      AuthenticationStorage.logger.log(
        `AuthenticationStorage: ${this.summary(inUse)}`,
      );
    }
  }

  private source(contract: AuthenticationStorageContract): object {
    this[LOCK_STORAGE]();
    let source = this.active.get(contract);
    if (!source) {
      if (this.refusesInMemory()) {
        throw new Error(productionError([contract]));
      }
      source = STORAGE_CONTRACTS[contract].inMemory();
      this.active.set(contract, source);
    }
    return source;
  }

  private refusesInMemory(): boolean {
    return (
      process.env.NODE_ENV?.trim().toLowerCase() === "production" &&
      !this.requirements?.allowInMemoryStorage
    );
  }

  private summary(inUse: readonly AuthenticationStorageContract[]): string {
    const sources = new Set(this.registered.values());
    if (sources.size === 0) {
      return DEFAULT;
    }
    if (sources.size === 1 && this.registered.size === CONTRACT_NAMES.length) {
      return nameOf([...sources][0]);
    }
    const listed = CONTRACT_NAMES.filter(
      (contract) => inUse.includes(contract) || this.registered.has(contract),
    );
    const groups = new Map<string, AuthenticationStorageContract[]>();
    for (const contract of [
      ...listed.filter((c) => this.registered.has(c)),
      ...listed.filter((c) => !this.registered.has(c)),
    ]) {
      const source = this.registered.get(contract);
      const name = source ? nameOf(source) : "in-memory";
      groups.set(name, [...(groups.get(name) ?? []), contract]);
    }
    return [...groups]
      .map(([name, contracts]) => `${name} (${contracts.join(", ")})`)
      .join("; ");
  }
}

function validate(sources: unknown): [AuthenticationStorageContract, object][] {
  if (sources === null || typeof sources !== "object") {
    throw new TypeError(
      `AuthenticationStorage.registerSource(): the contracts go by name, and got ${nameOf(sources)}. ${usage()}`,
    );
  }
  const obj = sources as Record<string, unknown>;
  const implemented = CONTRACT_NAMES.filter((contract) =>
    STORAGE_CONTRACTS[contract].methods.some(
      (method) => typeof obj[method] === "function",
    ),
  );
  if (implemented.length > 0) {
    throw new TypeError(
      `AuthenticationStorage.registerSource(): the contracts go by name, and ${nameOf(sources)} was passed as itself. ` +
        `Name what it implements: \`registerSource({ ${implemented.map((contract) => `${contract}: this`).join(", ")} })\`.`,
    );
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    throw new TypeError(
      `AuthenticationStorage.registerSource(): the contracts go by name, and got none. ${usage()}`,
    );
  }
  const unknown = keys.filter((key) => !Object.hasOwn(STORAGE_CONTRACTS, key));
  if (unknown.length > 0) {
    throw new TypeError(
      `AuthenticationStorage.registerSource(): unknown contract ${unknown.map((key) => `\`${key}\``).join(", ")}. ` +
        `The contracts are ${KNOWN}.`,
    );
  }
  return keys.map((key) => {
    const contract = key as AuthenticationStorageContract;
    const source = obj[contract];
    const { interfaceName, methods } = STORAGE_CONTRACTS[contract];
    if (source === null || typeof source !== "object") {
      throw new TypeError(
        `AuthenticationStorage.registerSource(): expected an object implementing ${interfaceName} as \`${contract}\`, ` +
          `got ${nameOf(source)}.`,
      );
    }
    const record = source as Record<string, unknown>;
    const missing = methods.filter(
      (method) => typeof record[method] !== "function",
    );
    if (missing.length > 0) {
      throw new TypeError(
        `AuthenticationStorage.registerSource(): ${nameOf(source)} doesn't implement ${interfaceName} for \`${contract}\`: ` +
          `${missing.map((method) => `${method}()`).join(", ")} ${missing.length === 1 ? "is" : "are"} missing.`,
      );
    }
    return [contract, source];
  });
}

function usage(): string {
  return `Pass the stores a provider implements: \`registerSource({ sessions: this, refreshTokens: this })\`. The contracts are ${KNOWN}.`;
}

function productionError(missing: AuthenticationStorageContract[]): string {
  const specs = missing.map((contract) => STORAGE_CONTRACTS[contract]);
  const example = missing.map((contract) => `${contract}: this`).join(", ");
  return (
    `AuthenticationStorage: no store is registered for ${and(missing.map((contract, i) => `\`${contract}\` (${specs[i]!.interfaceName})`))}, ` +
    `and NODE_ENV is "production": in memory, ${and(specs.map((spec) => spec.holds))} would be lost on restart and not ` +
    `shared between instances. Implement ${and(specs.map((spec) => spec.interfaceName))} in a provider that injects ` +
    `AuthenticationStorage and calls \`storage.registerSource({ ${example} })\` in its constructor, or set ` +
    "`allowInMemoryStorage: true` in the AuthenticationModule options to run in memory anyway."
  );
}

function and(items: string[]): string {
  if (items.length <= 2) {
    return items.join(" and ");
  }
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function nameOf(value: unknown): string {
  if (typeof value === "function") {
    return `the class ${value.name || "(anonymous)"} (pass an instance)`;
  }
  if (value === null || typeof value !== "object") {
    return String(value);
  }
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name && name !== "Object" ? name : "an object";
}

function describe(entries: [AuthenticationStorageContract, object][]): string {
  const names = [...new Set(entries.map(([, source]) => nameOf(source)))].join(
    ", ",
  );
  return `${names} (${entries.map(([contract]) => contract).join(", ")})`;
}
