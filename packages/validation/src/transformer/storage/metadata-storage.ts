import { TransformationType } from "../enums/transformation-type.enum";
import type {
  CloneMetadataOptions,
  ExcludeMetadata,
  ExposeMetadata,
  TransformMetadata,
  TypeMetadata,
} from "../interfaces/metadata.interface";

export const BUNEST_TRANSFORMER_STORAGE_SYMBOL = Symbol.for(
  "bunest:class-transformer:storage",
);

export function matchesDirection(
  options: { toClassOnly?: boolean; toPlainOnly?: boolean } | undefined,
  transformationType: TransformationType,
): boolean {
  if (!options) return true;
  if (options.toClassOnly === true && options.toPlainOnly === true) return true;
  if (options.toClassOnly === true) {
    return (
      transformationType === TransformationType.PLAIN_TO_CLASS ||
      transformationType === TransformationType.CLASS_TO_CLASS
    );
  }
  if (options.toPlainOnly === true) {
    return transformationType === TransformationType.CLASS_TO_PLAIN;
  }
  return true;
}

/**
 * Single-realm, GC-safe (`WeakMap`-backed) metadata storage for `@bunest/validation/transformer`.
 * Tracks a monotonic mutation `epoch` so compiled per-class transformation plans
 * auto-invalidate whenever metadata is added or cloned (e.g. via `PartialType`).
 */
export class TransformMetadataStorage {
  private _typeMetadatas = new WeakMap<Function, Map<string, TypeMetadata>>();
  private _transformMetadatas = new WeakMap<
    Function,
    Map<string, TransformMetadata[]>
  >();
  private _exposeMetadatas = new WeakMap<
    Function,
    Map<string | undefined, ExposeMetadata>
  >();
  private _excludeMetadatas = new WeakMap<
    Function,
    Map<string | undefined, ExcludeMetadata>
  >();
  private _ancestorsMap = new WeakMap<Function, Function[]>();
  private _epoch = 1;

  get epoch(): number {
    return this._epoch;
  }

  private bumpEpoch(): void {
    this._epoch += 1;
  }

  addTypeMetadata(metadata: TypeMetadata): void {
    let map = this._typeMetadatas.get(metadata.target);
    if (!map) {
      map = new Map();
      this._typeMetadatas.set(metadata.target, map);
    }
    map.set(metadata.propertyName, metadata);
    this.bumpEpoch();
  }

  addTransformMetadata(metadata: TransformMetadata): void {
    let map = this._transformMetadatas.get(metadata.target);
    if (!map) {
      map = new Map();
      this._transformMetadatas.set(metadata.target, map);
    }
    let list = map.get(metadata.propertyName);
    if (!list) {
      list = [];
      map.set(metadata.propertyName, list);
    }
    list.push(metadata);
    this.bumpEpoch();
  }

  addExposeMetadata(metadata: ExposeMetadata): void {
    let map = this._exposeMetadatas.get(metadata.target);
    if (!map) {
      map = new Map();
      this._exposeMetadatas.set(metadata.target, map);
    }
    map.set(metadata.propertyName, metadata);
    this.bumpEpoch();
  }

  addExcludeMetadata(metadata: ExcludeMetadata): void {
    let map = this._excludeMetadatas.get(metadata.target);
    if (!map) {
      map = new Map();
      this._excludeMetadatas.set(metadata.target, map);
    }
    map.set(metadata.propertyName, metadata);
    this.bumpEpoch();
  }

  hasMetadataFor(target: Function): boolean {
    return this.hasTargetMetadata(target);
  }

  hasTargetMetadata(target: Function): boolean {
    if (
      this._typeMetadatas.has(target) ||
      this._transformMetadatas.has(target) ||
      this._exposeMetadatas.has(target) ||
      this._excludeMetadatas.has(target)
    ) {
      return true;
    }
    const ancestors = this.getAncestors(target);
    for (let i = 0; i < ancestors.length; i++) {
      const anc = ancestors[i]!;
      if (
        this._typeMetadatas.has(anc) ||
        this._transformMetadatas.has(anc) ||
        this._exposeMetadatas.has(anc) ||
        this._excludeMetadatas.has(anc)
      ) {
        return true;
      }
    }
    return false;
  }

  getOwnTypeMap(target: Function): ReadonlyMap<string, TypeMetadata> | undefined {
    return this._typeMetadatas.get(target);
  }

  getOwnTransformMap(
    target: Function,
  ): ReadonlyMap<string, readonly TransformMetadata[]> | undefined {
    return this._transformMetadatas.get(target);
  }

  getOwnExposeMap(
    target: Function,
  ): ReadonlyMap<string | undefined, ExposeMetadata> | undefined {
    return this._exposeMetadatas.get(target);
  }

  getOwnExcludeMap(
    target: Function,
  ): ReadonlyMap<string | undefined, ExcludeMetadata> | undefined {
    return this._excludeMetadatas.get(target);
  }

  getPrototypeChain(target: Function): readonly Function[] {
    const ancestors = this.getAncestors(target);
    if (ancestors.length === 0) return [target];
    const chain = new Array<Function>(ancestors.length + 1);
    for (let i = 0; i < ancestors.length; i++) {
      chain[i] = ancestors[ancestors.length - 1 - i]!;
    }
    chain[ancestors.length] = target;
    return chain;
  }

  getAncestors(target: Function): readonly Function[] {
    if (!target) return [];
    const cached = this._ancestorsMap.get(target);
    if (cached) return cached;
    const ancestors: Function[] = [];
    let baseClass: unknown = Object.getPrototypeOf(target);
    while (
      typeof baseClass === "function" &&
      baseClass !== Function.prototype &&
      baseClass !== Object &&
      baseClass.prototype !== undefined
    ) {
      ancestors.push(baseClass);
      baseClass = Object.getPrototypeOf(baseClass);
    }
    this._ancestorsMap.set(target, ancestors);
    return ancestors;
  }

  findTransformMetadatas(
    target: Function,
    propertyName: string,
    transformationType: TransformationType,
  ): TransformMetadata[] {
    const collected = this.collectTransformsForProperty(target, propertyName);
    if (collected.length === 0) return [];
    const result: TransformMetadata[] = [];
    for (let i = 0; i < collected.length; i++) {
      const meta = collected[i]!;
      if (matchesDirection(meta.options, transformationType)) {
        result.push(meta);
      }
    }
    return result;
  }

  findExcludeMetadata(
    target: Function,
    propertyName: string,
  ): ExcludeMetadata | undefined {
    const own = this._excludeMetadatas.get(target)?.get(propertyName);
    if (own) return own;
    const ancestors = this.getAncestors(target);
    for (let i = 0; i < ancestors.length; i++) {
      const found = this._excludeMetadatas.get(ancestors[i]!)?.get(propertyName);
      if (found) return found;
    }
    return undefined;
  }

  findExposeMetadata(
    target: Function,
    propertyName: string,
  ): ExposeMetadata | undefined {
    const own = this._exposeMetadatas.get(target)?.get(propertyName);
    if (own) return own;
    const ancestors = this.getAncestors(target);
    for (let i = 0; i < ancestors.length; i++) {
      const found = this._exposeMetadatas.get(ancestors[i]!)?.get(propertyName);
      if (found) return found;
    }
    return undefined;
  }

  findExposeMetadataByCustomName(
    target: Function,
    name: string,
  ): ExposeMetadata | undefined {
    const metadatas = this.getExposedMetadatas(target);
    for (let i = metadatas.length - 1; i >= 0; i--) {
      const meta = metadatas[i]!;
      if (meta.options && meta.options.name === name) return meta;
    }
    return undefined;
  }

  findTypeMetadata(
    target: Function,
    propertyName: string,
  ): TypeMetadata | undefined {
    const own = this._typeMetadatas.get(target)?.get(propertyName);
    if (own) return own;
    const ancestors = this.getAncestors(target);
    for (let i = 0; i < ancestors.length; i++) {
      const found = this._typeMetadatas.get(ancestors[i]!)?.get(propertyName);
      if (found) return found;
    }
    return undefined;
  }

  getStrategy(target: Function): "excludeAll" | "exposeAll" | "none" {
    const exclude = this._excludeMetadatas.get(target)?.get(undefined);
    const expose = this._exposeMetadatas.get(target)?.get(undefined);
    if ((exclude && expose) || (!exclude && !expose)) {
      const ancestors = this.getAncestors(target);
      for (let i = 0; i < ancestors.length; i++) {
        const anc = ancestors[i]!;
        const ancExclude = this._excludeMetadatas.get(anc)?.get(undefined);
        const ancExpose = this._exposeMetadatas.get(anc)?.get(undefined);
        if (ancExclude && !ancExpose) return "excludeAll";
        if (ancExpose && !ancExclude) return "exposeAll";
      }
      return "none";
    }
    return exclude ? "excludeAll" : "exposeAll";
  }

  getExposedMetadatas(target: Function): ExposeMetadata[] {
    const result: ExposeMetadata[] = [];
    const chain = this.getPrototypeChain(target);
    for (let i = 0; i < chain.length; i++) {
      const map = this._exposeMetadatas.get(chain[i]!);
      if (!map) continue;
      for (const [prop, meta] of map.entries()) {
        if (prop !== undefined) result.push(meta);
      }
    }
    return result;
  }

  getExcludedMetadatas(target: Function): ExcludeMetadata[] {
    const result: ExcludeMetadata[] = [];
    const chain = this.getPrototypeChain(target);
    for (let i = 0; i < chain.length; i++) {
      const map = this._excludeMetadatas.get(chain[i]!);
      if (!map) continue;
      for (const [prop, meta] of map.entries()) {
        if (prop !== undefined) result.push(meta);
      }
    }
    return result;
  }

  getExposedProperties(
    target: Function,
    transformationType: TransformationType,
  ): string[] {
    const metas = this.getExposedMetadatas(target);
    const out: string[] = [];
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i]!;
      if (
        meta.propertyName !== undefined &&
        matchesDirection(meta.options, transformationType)
      ) {
        out.push(meta.propertyName);
      }
    }
    return out;
  }

  getExcludedProperties(
    target: Function,
    transformationType: TransformationType,
  ): string[] {
    const metas = this.getExcludedMetadatas(target);
    const out: string[] = [];
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i]!;
      if (
        meta.propertyName !== undefined &&
        matchesDirection(meta.options, transformationType)
      ) {
        out.push(meta.propertyName);
      }
    }
    return out;
  }

  cloneClassMetadata(
    source: Function,
    target: Function,
    optionsOrFilter:
      | CloneMetadataOptions
      | ((propertyName: string) => boolean) = {},
    stackTransformsArg?: boolean,
  ): string[] {
    const filter =
      typeof optionsOrFilter === "function"
        ? optionsOrFilter
        : (optionsOrFilter.propertyFilter ?? (() => true));
    const stackTransforms =
      typeof optionsOrFilter === "function"
        ? (stackTransformsArg ?? true)
        : (optionsOrFilter.stackTransforms ?? true);
    const discovered = new Set<string>();
    const chain = this.getPrototypeChain(source);

    for (let i = 0; i < chain.length; i++) {
      const ctor = chain[i]!;

      const typeMap = this._typeMetadatas.get(ctor);
      if (typeMap) {
        for (const [prop, meta] of typeMap.entries()) {
          if (!filter(prop)) continue;
          discovered.add(prop);
          this.addTypeMetadata({
            ...meta,
            target,
            options: meta.options ? { ...meta.options } : {},
          });
        }
      }

      const exposeMap = this._exposeMetadatas.get(ctor);
      if (exposeMap) {
        for (const [prop, meta] of exposeMap.entries()) {
          if (prop !== undefined && !filter(prop)) continue;
          if (prop !== undefined) discovered.add(prop);
          this.addExposeMetadata({
            ...meta,
            target,
            options: meta.options ? { ...meta.options } : {},
          });
        }
      }

      const excludeMap = this._excludeMetadatas.get(ctor);
      if (excludeMap) {
        for (const [prop, meta] of excludeMap.entries()) {
          if (prop !== undefined && !filter(prop)) continue;
          if (prop !== undefined) discovered.add(prop);
          this.addExcludeMetadata({
            ...meta,
            target,
            options: meta.options ? { ...meta.options } : {},
          });
        }
      }

      const transformMap = this._transformMetadatas.get(ctor);
      if (transformMap) {
        for (const [prop, list] of transformMap.entries()) {
          if (!filter(prop)) continue;
          discovered.add(prop);
          if (!stackTransforms) {
            let targetMap = this._transformMetadatas.get(target);
            if (!targetMap) {
              targetMap = new Map();
              this._transformMetadatas.set(target, targetMap);
            }
            targetMap.set(
              prop,
              list.map((meta) => ({
                ...meta,
                target,
                options: meta.options ? { ...meta.options } : {},
              })),
            );
            this.bumpEpoch();
          } else {
            for (let j = 0; j < list.length; j++) {
              const meta = list[j]!;
              this.addTransformMetadata({
                ...meta,
                target,
                options: meta.options ? { ...meta.options } : {},
              });
            }
          }
        }
      }
    }

    return [...discovered];
  }

  getDecoratedPropertyNames(target: Function): string[] {
    const names = new Set<string>();
    const chain = this.getPrototypeChain(target);
    for (let i = 0; i < chain.length; i++) {
      const ctor = chain[i]!;
      const typeMap = this._typeMetadatas.get(ctor);
      if (typeMap) for (const k of typeMap.keys()) names.add(k);
      const transformMap = this._transformMetadatas.get(ctor);
      if (transformMap) for (const k of transformMap.keys()) names.add(k);
      const exposeMap = this._exposeMetadatas.get(ctor);
      if (exposeMap) {
        for (const k of exposeMap.keys()) {
          if (k !== undefined) names.add(k);
        }
      }
      const excludeMap = this._excludeMetadatas.get(ctor);
      if (excludeMap) {
        for (const k of excludeMap.keys()) {
          if (k !== undefined) names.add(k);
        }
      }
    }
    return [...names];
  }

  collectTransformsForProperty(
    target: Function,
    propertyName: string,
  ): TransformMetadata[] {
    const chain = this.getPrototypeChain(target);
    const out: TransformMetadata[] = [];
    for (let i = 0; i < chain.length; i++) {
      const list = this._transformMetadatas.get(chain[i]!)?.get(propertyName);
      if (!list || list.length === 0) continue;
      for (let j = list.length - 1; j >= 0; j--) {
        out.push(list[j]!);
      }
    }
    return out;
  }

  clear(): void {
    this._typeMetadatas = new WeakMap();
    this._transformMetadatas = new WeakMap();
    this._exposeMetadatas = new WeakMap();
    this._excludeMetadatas = new WeakMap();
    this._ancestorsMap = new WeakMap();
    this.bumpEpoch();
  }
}

export function getMetadataStorage(): TransformMetadataStorage {
  const g = globalThis as Record<PropertyKey, unknown>;
  let storage = g[BUNEST_TRANSFORMER_STORAGE_SYMBOL] as
    | TransformMetadataStorage
    | undefined;
  if (!storage) {
    storage = new TransformMetadataStorage();
    g[BUNEST_TRANSFORMER_STORAGE_SYMBOL] = storage;
  }
  return storage;
}

export const defaultMetadataStorage: TransformMetadataStorage =
  getMetadataStorage();
