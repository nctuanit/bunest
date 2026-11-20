import type { Storage } from "../storage.service";

const serverRegistry = new WeakMap<object, Storage>();
let latestStorage: Storage | undefined;

export function registerServer(instance: object, storage: Storage): void {
  serverRegistry.set(instance, storage);
  latestStorage = storage;
}

export function unregisterServer(instance: object, storage: Storage): void {
  if (serverRegistry.get(instance) === storage) {
    serverRegistry.delete(instance);
  }
  if (latestStorage === storage) {
    latestStorage = undefined;
  }
}

export function storageForRequest(req: any): Storage | undefined {
  if (req && typeof req === "object") {
    let app = req.app;
    while (app && typeof app === "object") {
      const found = serverRegistry.get(app);
      if (found) return found;
      app = app.parent;
    }
    let server = req.server;
    while (server && typeof server === "object") {
      const found = serverRegistry.get(server);
      if (found) return found;
      server = server.parent;
    }
    const socketServer = req.socket?.server;
    if (socketServer && typeof socketServer === "object") {
      const found = serverRegistry.get(socketServer);
      if (found) return found;
    }
  }
  return latestStorage;
}
