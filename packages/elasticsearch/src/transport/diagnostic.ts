import { EventEmitter } from "node:events";

export class ElasticsearchDiagnostic extends EventEmitter {
  override emit(eventName: string | symbol, ...args: any[]): boolean {
    return super.emit(eventName, ...args);
  }
}
