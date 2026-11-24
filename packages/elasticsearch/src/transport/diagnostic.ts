type DiagnosticListener = (...args: any[]) => void;

/**
 * Lightweight Bun-native typed diagnostic emitter (zero `node:events` dependency)
 * compatible with standard EventEmitter `on`/`once`/`off`/`removeListener`/`emit` semantics.
 */
export class ElasticsearchDiagnostic {
  private readonly listenersMap = new Map<
    string | symbol,
    Set<DiagnosticListener>
  >();

  on(eventName: string | symbol, listener: DiagnosticListener): this {
    let set = this.listenersMap.get(eventName);
    if (!set) {
      set = new Set();
      this.listenersMap.set(eventName, set);
    }
    set.add(listener);
    return this;
  }

  addListener(eventName: string | symbol, listener: DiagnosticListener): this {
    return this.on(eventName, listener);
  }

  once(eventName: string | symbol, listener: DiagnosticListener): this {
    const wrapper: DiagnosticListener = (...args) => {
      this.off(eventName, wrapper);
      listener(...args);
    };
    return this.on(eventName, wrapper);
  }

  off(eventName: string | symbol, listener: DiagnosticListener): this {
    this.listenersMap.get(eventName)?.delete(listener);
    return this;
  }

  removeListener(eventName: string | symbol, listener: DiagnosticListener): this {
    return this.off(eventName, listener);
  }

  removeAllListeners(eventName?: string | symbol): this {
    if (eventName === undefined) {
      this.listenersMap.clear();
    } else {
      this.listenersMap.delete(eventName);
    }
    return this;
  }

  listenerCount(eventName: string | symbol): number {
    return this.listenersMap.get(eventName)?.size ?? 0;
  }

  emit(eventName: string | symbol, ...args: any[]): boolean {
    const set = this.listenersMap.get(eventName);
    if (!set || set.size === 0) return false;
    for (const listener of [...set]) {
      listener(...args);
    }
    return true;
  }
}
