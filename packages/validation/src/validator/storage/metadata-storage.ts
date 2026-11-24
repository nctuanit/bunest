import { ValidationTypes } from "../constants/validation-types";
import type {
  ConstraintMetadata,
  ValidationMetadata,
  ValidationMetadataArgs,
} from "../interfaces/metadata.interface";
import type { ValidationSchema } from "../interfaces/validation-schema.interface";
import type { ValidatorConstraintInterface } from "../interfaces/validator-constraint.interface";
import { getFromContainer } from "./container";

export const BUNEST_VALIDATOR_STORAGE_SYMBOL = Symbol.for(
  "bunest:class-validator:storage",
);

export function createValidationMetadata(
  args: ValidationMetadataArgs,
): ValidationMetadata {
  const opts = args.validationOptions;
  return {
    type: args.type,
    name: args.name,
    target: args.target,
    propertyName: args.propertyName,
    constraints: args.constraints,
    constraintCls: args.constraintCls,
    validationTypeOptions: args.validationTypeOptions,
    groups: opts?.groups,
    always: opts?.always,
    each: opts?.each,
    context: opts?.context,
    message: opts?.message,
  };
}

export function createConstraintMetadata(
  target: Function,
  name = "",
  async = false,
  directInstance?: ValidatorConstraintInterface,
): ConstraintMetadata {
  if (directInstance) {
    return { target, name, async, instance: directInstance };
  }
  return {
    target,
    name,
    async,
    get instance(): ValidatorConstraintInterface {
      return getFromContainer<ValidatorConstraintInterface>(target);
    },
  };
}

export class MetadataStorage {
  private classMetadatas = new WeakMap<Function, ValidationMetadata[]>();
  private schemaMetadatas = new Map<string, ValidationMetadata[]>();
  private constraintMetadatas = new WeakMap<Function, ConstraintMetadata[]>();
  private ancestorsCache = new WeakMap<Function, Function[]>();
  private _hasAnyMetadata = false;
  private _epoch = 1;

  get hasValidationMetaData(): boolean {
    return this._hasAnyMetadata;
  }

  get epoch(): number {
    return this._epoch;
  }

  private bumpEpoch(): void {
    this._epoch += 1;
  }

  addValidationSchema(schema: ValidationSchema): void {
    for (const [propertyName, rules] of Object.entries(schema.properties)) {
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i]!;
        this.addValidationMetadata(
          createValidationMetadata({
            type: rule.type,
            name: rule.type,
            target: schema.name,
            propertyName,
            constraints: rule.constraints,
            validationTypeOptions: rule.options,
            validationOptions: {
              message: rule.message,
              groups: rule.groups,
              always: rule.always,
              each: rule.each,
              context: rule.context,
            },
          }),
        );
      }
    }
  }

  addValidationMetadata(metadata: ValidationMetadata): void {
    this._hasAnyMetadata = true;
    if (typeof metadata.target === "string") {
      let list = this.schemaMetadatas.get(metadata.target);
      if (!list) {
        list = [];
        this.schemaMetadatas.set(metadata.target, list);
      }
      list.push(metadata);
    } else {
      let list = this.classMetadatas.get(metadata.target);
      if (!list) {
        list = [];
        this.classMetadatas.set(metadata.target, list);
      }
      list.push(metadata);
    }
    this.bumpEpoch();
  }

  addConstraintMetadata(metadata: ConstraintMetadata): void {
    let list = this.constraintMetadatas.get(metadata.target);
    if (!list) {
      list = [];
      this.constraintMetadatas.set(metadata.target, list);
    }
    list.push(metadata);
    this.bumpEpoch();
  }

  groupByPropertyName(
    metadata: readonly ValidationMetadata[],
  ): Record<string, ValidationMetadata[]> {
    const grouped: Record<string, ValidationMetadata[]> = {};
    for (let i = 0; i < metadata.length; i++) {
      const item = metadata[i]!;
      let bucket = grouped[item.propertyName];
      if (!bucket) {
        bucket = [];
        grouped[item.propertyName] = bucket;
      }
      bucket.push(item);
    }
    return grouped;
  }

  hasMetadataFor(target: Function, targetSchema = ""): boolean {
    if (targetSchema && this.hasSchemaMetadata(targetSchema)) {
      return true;
    }
    return typeof target === "function" && this.hasTargetMetadata(target);
  }

  hasTargetMetadata(target: Function): boolean {
    if (this.classMetadatas.has(target)) return true;
    const ancestors = this.getAncestors(target);
    for (let i = 0; i < ancestors.length; i++) {
      if (this.classMetadatas.has(ancestors[i]!)) return true;
    }
    return false;
  }

  hasSchemaMetadata(schemaName: string): boolean {
    return this.schemaMetadatas.has(schemaName);
  }

  getAncestors(target: Function): readonly Function[] {
    if (!target) return [];
    const cached = this.ancestorsCache.get(target);
    if (cached) return cached;
    const ancestors: Function[] = [];
    let current: unknown = Object.getPrototypeOf(target);
    while (
      typeof current === "function" &&
      current !== Function.prototype &&
      current !== Object &&
      current.prototype !== undefined
    ) {
      ancestors.push(current);
      current = Object.getPrototypeOf(current);
    }
    this.ancestorsCache.set(target, ancestors);
    return ancestors;
  }

  getTargetValidationMetadatas(
    targetConstructor: Function,
    targetSchema: string,
    always: boolean,
    strictGroups: boolean,
    groups?: string[],
  ): ValidationMetadata[] {
    const hasGroups = groups !== undefined && groups.length > 0;

    const matchesFilter = (metadata: ValidationMetadata): boolean => {
      if (metadata.always !== undefined) {
        if (metadata.always) return true;
      } else if (!metadata.groups || metadata.groups.length === 0) {
        if (always) return true;
      }

      if (strictGroups && !hasGroups) {
        if (metadata.groups && metadata.groups.length > 0) return false;
      }

      if (hasGroups) {
        if (!metadata.groups || metadata.groups.length === 0) return false;
        for (let i = 0; i < metadata.groups.length; i++) {
          if (groups!.includes(metadata.groups[i]!)) return true;
        }
        return false;
      }

      return true;
    };

    const originalMetadatas: ValidationMetadata[] = [];

    if (targetSchema) {
      const schemaList = this.schemaMetadatas.get(targetSchema);
      if (schemaList) {
        for (let i = 0; i < schemaList.length; i++) {
          const meta = schemaList[i]!;
          if (matchesFilter(meta)) originalMetadatas.push(meta);
        }
      }
    }

    if (typeof targetConstructor === "function") {
      const ownList = this.classMetadatas.get(targetConstructor);
      if (ownList) {
        for (let i = 0; i < ownList.length; i++) {
          const meta = ownList[i]!;
          if (matchesFilter(meta)) originalMetadatas.push(meta);
        }
      }
    }

    if (typeof targetConstructor !== "function") {
      return originalMetadatas;
    }

    const ancestors = this.getAncestors(targetConstructor);
    if (ancestors.length === 0) {
      return originalMetadatas;
    }

    const inheritedMetadatas: ValidationMetadata[] = [];
    for (let a = 0; a < ancestors.length; a++) {
      const ancList = this.classMetadatas.get(ancestors[a]!);
      if (!ancList) continue;
      for (let i = 0; i < ancList.length; i++) {
        const meta = ancList[i]!;
        if (matchesFilter(meta)) inheritedMetadatas.push(meta);
      }
    }

    if (inheritedMetadatas.length === 0) {
      return originalMetadatas;
    }

    const uniqueInherited: ValidationMetadata[] = [];
    for (let i = 0; i < inheritedMetadatas.length; i++) {
      const inh = inheritedMetadatas[i]!;
      let overridden = false;
      for (let j = 0; j < originalMetadatas.length; j++) {
        const orig = originalMetadatas[j]!;
        if (orig.propertyName !== inh.propertyName || orig.type !== inh.type) {
          continue;
        }
        if (orig.type === ValidationTypes.CUSTOM_VALIDATION) {
          if (
            (orig.name !== undefined && orig.name === inh.name) ||
            (orig.constraintCls !== undefined &&
              orig.constraintCls === inh.constraintCls)
          ) {
            overridden = true;
            break;
          }
        } else {
          overridden = true;
          break;
        }
      }
      if (!overridden) {
        uniqueInherited.push(inh);
      }
    }

    return originalMetadatas.concat(uniqueInherited);
  }

  getTargetValidatorConstraints(target: Function): ConstraintMetadata[] {
    return this.constraintMetadatas.get(target) ?? [];
  }

  cloneClassMetadata(
    source: Function,
    target: Function,
    propertyFilter?: (propertyKey: string) => boolean,
  ): string[] {
    const filter = propertyFilter ?? (() => true);
    const sourceMetas = this.getTargetValidationMetadatas(
      source,
      "",
      false,
      false,
    );
    const inheritedKeys: string[] = [];
    for (let i = 0; i < sourceMetas.length; i++) {
      const meta = sourceMetas[i]!;
      if (!meta.propertyName || !filter(meta.propertyName)) continue;
      this.addValidationMetadata({
        ...meta,
        target,
        ...(meta.groups ? { groups: [...meta.groups] } : {}),
        ...(meta.constraints ? { constraints: [...meta.constraints] } : {}),
      });
      inheritedKeys.push(meta.propertyName);
    }
    return inheritedKeys;
  }

  clear(): void {
    this.classMetadatas = new WeakMap();
    this.schemaMetadatas.clear();
    this.constraintMetadatas = new WeakMap();
    this.ancestorsCache = new WeakMap();
    this._hasAnyMetadata = false;
    this.bumpEpoch();
  }
}

export function getMetadataStorage(): MetadataStorage {
  const g = globalThis as Record<PropertyKey, unknown>;
  let storage = g[BUNEST_VALIDATOR_STORAGE_SYMBOL] as
    | MetadataStorage
    | undefined;
  if (!storage) {
    storage = new MetadataStorage();
    g[BUNEST_VALIDATOR_STORAGE_SYMBOL] = storage;
  }
  return storage;
}
