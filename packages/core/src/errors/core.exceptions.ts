import { Scope } from "@bunest/common";
import { formatToken } from "./token-formatter";

export class CoreBootstrapException extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface UnknownDependencyDetails {
  requester: string;
  token: unknown;
  moduleName: string;
  index?: number;
  propertyKey?: string | symbol;
  resolutionPath?: readonly string[];
}

export class UnknownDependencyException extends CoreBootstrapException {
  public readonly details: UnknownDependencyDetails;

  constructor(details: UnknownDependencyDetails) {
    const tokenLabel = formatToken(details.token);
    const location =
      details.propertyKey !== undefined
        ? `property "${String(details.propertyKey)}"`
        : details.index !== undefined
          ? `constructor parameter #${details.index}`
          : "dependency";
    const pathLine =
      details.resolutionPath && details.resolutionPath.length > 0
        ? `\nResolution path: ${details.resolutionPath.join(" -> ")}`
        : "";

    super(
      `UnknownDependencyException: Cannot resolve ${location} (${tokenLabel}) of "${details.requester}" in module "${details.moduleName}".${pathLine}\n` +
        `Fix: Register ${tokenLabel} in "${details.moduleName}.providers", export it from an imported module, or decorate the parameter with @Optional().`,
    );
    this.details = details;
  }
}

export interface CircularDependencyDetails {
  chain: readonly string[];
  kind: "provider" | "module";
  reason?: string;
}

export class CircularDependencyException extends CoreBootstrapException {
  public readonly chain: readonly string[];
  public readonly kind: "provider" | "module";

  constructor(details: CircularDependencyDetails) {
    const reasonSuffix = details.reason ? ` (${details.reason})` : "";
    const hint =
      details.kind === "module"
        ? `Use forwardRef(() => TargetModule) in at least one module's imports array.`
        : `Use @Inject(forwardRef(() => TargetClass)) on at least one constructor dependency, or extract shared logic into a third service.`;

    super(
      `CircularDependencyException: Circular ${details.kind} dependency detected: ${details.chain.join(" -> ")}${reasonSuffix}.\nHint: ${hint}`,
    );
    this.chain = [...details.chain];
    this.kind = details.kind;
  }
}

export interface ScopeChainNode {
  name: string;
  scope: Scope;
}

export class ScopeLeakException extends CoreBootstrapException {
  public readonly consumer: ScopeChainNode;
  public readonly dependency: ScopeChainNode;
  public readonly chain: readonly ScopeChainNode[];

  constructor(chain: readonly ScopeChainNode[]) {
    const consumer = chain[0] ?? { name: "<unknown>", scope: Scope.SINGLETON };
    const dependency = chain[chain.length - 1] ?? {
      name: "<unknown>",
      scope: Scope.REQUEST,
    };

    const formattedChain = chain
      .map((node) => `${node.name} [${node.scope}]`)
      .join(" -> ");
    const nonRequestNodes = chain
      .filter((node) => node.scope !== Scope.REQUEST)
      .map((node) => `"${node.name}"`);
    const targetList =
      nonRequestNodes.length > 0
        ? nonRequestNodes.join(" and ")
        : `"${consumer.name}"`;

    super(
      `ScopeLeakException: ${consumer.scope} "${consumer.name}" cannot depend on ${dependency.scope}-scoped "${dependency.name}".\n` +
        `Chain: ${formattedChain}\n` +
        `Fix: Mark ${targetList} with { scope: Scope.REQUEST }, or read ambient RequestContext inside request handlers.`,
    );
    this.consumer = consumer;
    this.dependency = dependency;
    this.chain = [...chain];
  }
}

export interface AmbiguousProviderDetails {
  token: unknown;
  moduleName: string;
  conflictingModules: readonly string[];
  source: "imports" | "global";
}

export class AmbiguousProviderException extends CoreBootstrapException {
  public readonly details: AmbiguousProviderDetails;

  constructor(details: AmbiguousProviderDetails) {
    const tokenLabel = formatToken(details.token);
    const sourceDesc =
      details.source === "imports" ? "imported modules" : "@Global() modules";
    super(
      `AmbiguousProviderException: Token ${tokenLabel} in module "${details.moduleName}" is exported by multiple ${sourceDesc}: ${details.conflictingModules.join(", ")}.\n` +
        `Fix: Override ${tokenLabel} locally in "${details.moduleName}.providers" or use distinct injection tokens.`,
    );
    this.details = details;
  }
}

export class InvalidModuleException extends CoreBootstrapException {
  constructor(target: unknown, reason?: string) {
    const label = formatToken(target);
    const detail = reason ? `: ${reason}` : " is missing @Module() metadata";
    super(`InvalidModuleException: Module ${label}${detail}.`);
  }
}

export class DuplicateProviderException extends CoreBootstrapException {
  public readonly token: unknown;
  public readonly moduleName: string;

  constructor(token: unknown, moduleName: string) {
    super(
      `DuplicateProviderException: Provider token ${formatToken(token)} is declared more than once in module "${moduleName}".`,
    );
    this.token = token;
    this.moduleName = moduleName;
  }
}

export class InvalidExportException extends CoreBootstrapException {
  public readonly token: unknown;
  public readonly moduleName: string;

  constructor(token: unknown, moduleName: string, reason: string) {
    super(
      `InvalidExportException: Module "${moduleName}" cannot export ${formatToken(token)}: ${reason}.`,
    );
    this.token = token;
    this.moduleName = moduleName;
  }
}
