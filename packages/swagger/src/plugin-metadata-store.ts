/**
 * Internal leaf store for CLI/build-time plugin metadata loaded via
 * `SwaggerModule.loadPluginMetadata(metadataFn)`.
 * Zero internal imports so both `SchemaExplorer` and `SwaggerModule` can read it
 * without introducing any circular dependency.
 */

export interface LoadedPluginModelProperty {
  readonly propertyKey: string;
  readonly type?: unknown;
  readonly isArray?: boolean;
  readonly required?: boolean;
  readonly nullable?: boolean;
  readonly enum?: unknown;
  readonly enumName?: string;
  readonly description?: string;
  readonly summary?: string;
  readonly default?: unknown;
  readonly example?: unknown;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly readOnly?: boolean;
  readonly deprecated?: boolean;
  readonly [key: string]: unknown;
}

export interface LoadedPluginControllerAction {
  readonly methodKey: string;
  readonly type?: unknown;
  readonly isArray?: boolean;
  readonly status?: number;
  readonly summary?: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

let modelMetadataByClass = new WeakMap<
  Function,
  LoadedPluginModelProperty[]
>();
const modelMetadataByName = new Map<string, LoadedPluginModelProperty[]>();
let controllerMetadataByClass = new WeakMap<
  Function,
  Map<string, LoadedPluginControllerAction>
>();
const controllerMetadataByName = new Map<
  string,
  Map<string, LoadedPluginControllerAction>
>();

function normalizePropertyRecord(
  propsObj: Record<string, Record<string, unknown>>,
): LoadedPluginModelProperty[] {
  const list: LoadedPluginModelProperty[] = [];
  for (const [propertyKey, meta] of Object.entries(propsObj)) {
    if (!meta || typeof meta !== "object") continue;
    list.push({
      ...meta,
      propertyKey,
    });
  }
  return list;
}

function normalizeControllerRecord(
  actionsObj: Record<string, Record<string, unknown>>,
): Map<string, LoadedPluginControllerAction> {
  const map = new Map<string, LoadedPluginControllerAction>();
  for (const [methodKey, meta] of Object.entries(actionsObj)) {
    if (!meta || typeof meta !== "object") continue;
    map.set(methodKey, {
      ...meta,
      methodKey,
    });
  }
  return map;
}

export async function registerLoadedPluginMetadata(
  rawMetadata: Record<string, any>,
): Promise<void> {
  if (!rawMetadata || typeof rawMetadata !== "object") {
    return;
  }

  const swaggerSection = (rawMetadata["@nestjs/swagger"] ??
    rawMetadata["@bunest/swagger"] ??
    rawMetadata) as {
    models?: Array<
      [
        Promise<Record<string, unknown>> | Record<string, unknown>,
        Record<string, Record<string, Record<string, unknown>>>,
      ]
    >;
    controllers?: Array<
      [
        Promise<Record<string, unknown>> | Record<string, unknown>,
        Record<string, Record<string, Record<string, unknown>>>,
      ]
    >;
  };

  if (Array.isArray(swaggerSection.models)) {
    for (const entry of swaggerSection.models) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [moduleOrPromise, classesMap] = entry;
      const resolvedModule = await Promise.resolve(moduleOrPromise).catch(
        () => undefined,
      );
      if (!classesMap || typeof classesMap !== "object") continue;

      for (const [className, propsObj] of Object.entries(classesMap)) {
        if (!propsObj || typeof propsObj !== "object") continue;
        const normalized = normalizePropertyRecord(propsObj);

        const ctor = resolvedModule?.[className];
        if (typeof ctor === "function") {
          modelMetadataByClass.set(ctor, normalized);
        } else {
          modelMetadataByName.set(className, normalized);
        }
      }
    }
  }

  if (Array.isArray(swaggerSection.controllers)) {
    for (const entry of swaggerSection.controllers) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [moduleOrPromise, controllersMap] = entry;
      const resolvedModule = await Promise.resolve(moduleOrPromise).catch(
        () => undefined,
      );
      if (!controllersMap || typeof controllersMap !== "object") continue;

      for (const [ctrlName, actionsObj] of Object.entries(controllersMap)) {
        if (!actionsObj || typeof actionsObj !== "object") continue;
        const normalized = normalizeControllerRecord(actionsObj);

        const ctor = resolvedModule?.[ctrlName];
        if (typeof ctor === "function") {
          controllerMetadataByClass.set(ctor, normalized);
        } else {
          controllerMetadataByName.set(ctrlName, normalized);
        }
      }
    }
  }
}

export function getPluginModelMetadata(
  target: Function,
): readonly LoadedPluginModelProperty[] | undefined {
  return (
    modelMetadataByClass.get(target) ??
    (target.name ? modelMetadataByName.get(target.name) : undefined)
  );
}

export function getPluginControllerActionMetadata(
  controller: Function,
  methodKey: string,
): LoadedPluginControllerAction | undefined {
  const byClass = controllerMetadataByClass.get(controller);
  if (byClass?.has(methodKey)) {
    return byClass.get(methodKey);
  }
  if (controller.name) {
    return controllerMetadataByName.get(controller.name)?.get(methodKey);
  }
  return undefined;
}

export function clearPluginMetadataStore(): void {
  modelMetadataByClass = new WeakMap();
  modelMetadataByName.clear();
  controllerMetadataByClass = new WeakMap();
  controllerMetadataByName.clear();
}
