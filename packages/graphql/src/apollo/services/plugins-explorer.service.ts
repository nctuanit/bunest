import {
  Injectable,
  MetadataRegistry,
  Optional,
  Scope,
  type Type,
} from "@bunest/core";
import {
  DiscoveryService,
  ModulesContainer,
  type InstanceWrapper,
} from "@bunest/core";
import { BaseExplorerService, type GqlModuleOptions } from "../../index";
import { PLUGIN_METADATA } from "../constants/apollo.constants";

interface AnyInstanceWrapper<T = unknown> {
  instance?: T;
  metatype?: Function;
  scope?: Scope;
  isAlias?: boolean;
  isTransient?: boolean;
  isDependencyTreeStatic?: boolean | (() => boolean);
}

@Injectable()
export class PluginsExplorerService extends BaseExplorerService {
  constructor(
    @Optional() private readonly modulesContainer?: ModulesContainer,
    @Optional() private readonly discoveryService?: DiscoveryService,
  ) {
    super();
  }

  explore(options: Pick<GqlModuleOptions, "include"> = {}): unknown[] {
    const discovered: unknown[] = [];
    const seen = new Set<unknown>();

    if (this.discoveryService) {
      const discoveryOpts =
        options.include && options.include.length > 0
          ? { include: options.include as Type<unknown>[] }
          : undefined;
      for (const wrapper of this.discoveryService.getProviders(discoveryOpts)) {
        const plugin = this.filterPlugins(wrapper);
        if (plugin && !seen.has(plugin)) {
          seen.add(plugin);
          discovered.push(plugin);
        }
      }
    }

    if (this.modulesContainer) {
      const modules = this.getModules(
        this.modulesContainer,
        options.include || [],
      );
      const fromModules = this.flatMap(modules, (wrapper) =>
        this.filterPlugins(wrapper as AnyInstanceWrapper),
      );
      for (const plugin of fromModules) {
        if (plugin && !seen.has(plugin)) {
          seen.add(plugin);
          discovered.push(plugin);
        }
      }
    }

    return discovered;
  }

  filterPlugins<T = unknown>(
    wrapper: InstanceWrapper<T> | AnyInstanceWrapper<T>,
  ): T | undefined {
    if (!wrapper || typeof wrapper !== "object") {
      return undefined;
    }
    const w = wrapper as AnyInstanceWrapper<T>;
    if (w.isAlias) {
      return undefined;
    }

    const instance = w.instance;
    const ctor =
      instance && typeof instance === "object"
        ? (instance as { constructor?: Function }).constructor
        : typeof w.metatype === "function"
          ? w.metatype
          : undefined;

    if (!ctor || typeof ctor !== "function") {
      return undefined;
    }

    const metadata = MetadataRegistry.get<boolean>(PLUGIN_METADATA, ctor);
    if (!metadata) {
      return undefined;
    }

    const isStatic =
      typeof w.isDependencyTreeStatic === "function"
        ? w.isDependencyTreeStatic()
        : w.isDependencyTreeStatic !== false;
    const isTransient =
      w.isTransient === true ||
      w.scope === Scope.TRANSIENT ||
      w.scope === Scope.REQUEST;

    if (!isStatic || isTransient) {
      throw new Error(
        `"${ctor.name}" plugin is request or transient-scoped, or depends on a request-scoped provider. Classes annotated with the "@Plugin()" decorator must be static (singleton).`,
      );
    }

    if (!instance) {
      return undefined;
    }

    return instance;
  }
}
