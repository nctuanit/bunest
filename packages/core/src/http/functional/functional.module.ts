import type { ContractTree } from "../../client/contract";
import {
  Module,
  type DynamicModule,
  type ModuleExport,
  type ModuleImport,
  type Provider,
} from "../../common/index";
import {
  compileFunctionalGroupToController,
  isFunctionalRouteGroup,
  type FunctionalModuleOptions,
  type FunctionalRouteGroup,
} from "./define-routes";
import {
  implementContract,
  type ContractHandlers,
  type ImplementContractOptions,
} from "./implement-contract";

/** Options accepted by `FunctionalModule.forContract(contract, handlers, options?)`. */
export interface FunctionalContractModuleOptions
  extends ImplementContractOptions {
  readonly imports?: ModuleImport[];
  readonly providers?: Provider[];
  readonly exports?: ModuleExport[];
}

let functionalModuleSeq = 0;

/**
 * Dynamic module mounting `defineRoutes()` functional route groups or
 * `defineContract()` server implementations directly into Bunest's native
 * 11-stage HTTP pipeline & router with full DI support.
 */
@Module({})
export class FunctionalModule {
  static forRoutes(
    ...routeGroups: readonly (
      | FunctionalRouteGroup
      | readonly FunctionalRouteGroup[]
      | FunctionalModuleOptions
    )[]
  ): DynamicModule {
    const groups: FunctionalRouteGroup[] = [];
    const imports: ModuleImport[] = [];
    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];

    for (const item of routeGroups) {
      if (Array.isArray(item)) {
        for (const sub of item) {
          if (!isFunctionalRouteGroup(sub)) {
            throw new TypeError(
              "FunctionalModule.forRoutes() expects route groups created by defineRoutes().",
            );
          }
          groups.push(sub);
        }
      } else if (isFunctionalRouteGroup(item)) {
        groups.push(item);
      } else if (
        item &&
        typeof item === "object" &&
        "routes" in item &&
        Array.isArray((item as FunctionalModuleOptions).routes)
      ) {
        const opts = item as FunctionalModuleOptions;
        for (const sub of opts.routes) {
          if (!isFunctionalRouteGroup(sub)) {
            throw new TypeError(
              "FunctionalModule.forRoutes({ routes }) expects route groups created by defineRoutes().",
            );
          }
          groups.push(sub);
        }
        if (opts.imports) imports.push(...opts.imports);
        if (opts.providers) providers.push(...opts.providers);
        if (opts.exports) exportsList.push(...opts.exports);
      } else {
        throw new TypeError(
          "FunctionalModule.forRoutes() expects route groups created by defineRoutes().",
        );
      }
    }

    const controllers = groups.map(compileFunctionalGroupToController);
    const modSeq = ++functionalModuleSeq;
    @Module({})
    class DynamicFunctionalRoutesModule extends FunctionalModule {}
    Object.defineProperty(DynamicFunctionalRoutesModule, "name", {
      value: `FunctionalModule_${modSeq}`,
      configurable: true,
    });

    return {
      module: DynamicFunctionalRoutesModule,
      ...(imports.length > 0 ? { imports } : {}),
      controllers,
      ...(providers.length > 0 ? { providers } : {}),
      ...(exportsList.length > 0 ? { exports: exportsList } : {}),
    };
  }

  /**
   * Mounts a shared `defineContract()` tree and its type-checked server `handlers`
   * directly as a Bunest dynamic module with optional `imports`, `providers`, `exports`,
   * and shared guards/interceptors/filters.
   */
  static forContract<TRoutes extends ContractTree>(
    contract: TRoutes,
    handlers: ContractHandlers<TRoutes>,
    options: FunctionalContractModuleOptions = {},
  ): DynamicModule {
    const { imports, providers, exports: exportsList, ...contractOpts } =
      options;
    const routes = implementContract(contract, handlers, contractOpts);
    return FunctionalModule.forRoutes({
      routes,
      ...(imports ? { imports } : {}),
      ...(providers ? { providers } : {}),
      ...(exportsList ? { exports: exportsList } : {}),
    });
  }
}
