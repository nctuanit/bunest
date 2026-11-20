import type { InjectionToken, Type } from "@bunest/common";
import type { NormalizedProvider } from "../interfaces/core-types.interface";

/**
 * Represents one registered static or dynamic module in the scanned module graph.
 */
export class ModuleNode {
  public readonly imports: ModuleNode[] = [];
  public readonly controllers: Type<unknown>[] = [];
  public readonly providers = new Map<InjectionToken, NormalizedProvider>();
  public readonly multiProviders = new Map<
    InjectionToken,
    NormalizedProvider[]
  >();
  public readonly exportedTokens = new Set<InjectionToken>();
  public readonly reExportedModules: ModuleNode[] = [];
  public instance?: object;

  constructor(
    public readonly id: string,
    public readonly metatype: Type<unknown>,
    public readonly isGlobal: boolean,
    public readonly isDynamic: boolean,
  ) {}

  get name(): string {
    return this.metatype.name || this.id;
  }

  /**
   * Resolves all tokens effectively exported by this module (direct exports + transitive re-exports),
   * mapping each exported token to the defining `ModuleNode`(s) that provide it.
   */
  getEffectiveExports(
    visited = new Set<ModuleNode>(),
  ): Map<InjectionToken, Set<ModuleNode>> {
    const result = new Map<InjectionToken, Set<ModuleNode>>();
    if (visited.has(this)) {
      return result;
    }
    visited.add(this);

    const addOwner = (token: InjectionToken, owner: ModuleNode) => {
      let owners = result.get(token);
      if (!owners) {
        owners = new Set<ModuleNode>();
        result.set(token, owners);
      }
      owners.add(owner);
    };

    // 1. Direct token exports: owned by this module if locally declared, otherwise forwarded from direct imports
    for (const token of this.exportedTokens) {
      if (this.providers.has(token)) {
        addOwner(token, this);
      } else {
        for (const imported of this.imports) {
          const importedExports = imported.getEffectiveExports(
            new Set(visited),
          );
          const owners = importedExports.get(token);
          if (owners) {
            for (const owner of owners) {
              addOwner(token, owner);
            }
          }
        }
      }
    }

    // 2. Transitive re-exported modules
    for (const reExported of this.reExportedModules) {
      const subExports = reExported.getEffectiveExports(new Set(visited));
      for (const [token, owners] of subExports.entries()) {
        for (const owner of owners) {
          addOwner(token, owner);
        }
      }
    }

    return result;
  }
}
