export interface ContainerInterface {
  get<T>(someClass: { new (...args: never[]): T } | Function): T;
}

export interface UseContainerOptions {
  fallback?: boolean;
  fallbackOnErrors?: boolean;
}

class DefaultContainer implements ContainerInterface {
  private readonly instances = new WeakMap<Function, unknown>();

  get<T>(someClass: { new (...args: never[]): T } | Function): T {
    let instance = this.instances.get(someClass);
    if (!instance) {
      instance = new (someClass as new () => T)();
      this.instances.set(someClass, instance);
    }
    return instance as T;
  }
}

const CONTAINER_STATE_SYMBOL = Symbol.for(
  "bunest:class-validator:container_state",
);

interface ContainerState {
  defaultContainer: DefaultContainer;
  userContainer?: ContainerInterface;
  userContainerOptions?: UseContainerOptions;
}

function getContainerState(): ContainerState {
  const g = globalThis as Record<PropertyKey, unknown>;
  let state = g[CONTAINER_STATE_SYMBOL] as ContainerState | undefined;
  if (!state) {
    state = { defaultContainer: new DefaultContainer() };
    g[CONTAINER_STATE_SYMBOL] = state;
  }
  return state;
}

export function useContainer(
  iocContainer: ContainerInterface,
  options?: UseContainerOptions,
): void {
  const state = getContainerState();
  state.userContainer = iocContainer;
  state.userContainerOptions = options;
}

export function getFromContainer<T>(
  someClass: { new (...args: never[]): T } | Function,
): T {
  const state = getContainerState();
  if (state.userContainer) {
    try {
      const instance = state.userContainer.get<T>(someClass);
      if (instance) return instance;
      if (!state.userContainerOptions?.fallback) return instance;
    } catch (error) {
      if (!state.userContainerOptions?.fallbackOnErrors) throw error;
    }
  }
  return state.defaultContainer.get<T>(someClass);
}
