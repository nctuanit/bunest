import { Injectable, Reflector, type Type } from "@bunest/common";
import {
  BULL_MODULE_ON_QUEUE_EVENT,
  BULL_MODULE_QUEUE,
  BULL_MODULE_QUEUE_PROCESS,
} from "./bull.constants";
import type { BullQueueEventOptions } from "./bull.types";
import type { ProcessOptions } from "./decorators/process.decorator";

@Injectable()
export class BullMetadataAccessor {
  constructor(private readonly reflector: Reflector) {}

  isQueueComponent(target: Type<any> | Function | undefined): boolean {
    if (!target) {
      return false;
    }
    return !!this.reflector.get(BULL_MODULE_QUEUE, target);
  }

  isProcessor(target: Type<any> | Function | undefined): boolean {
    if (!target) {
      return false;
    }
    return !!this.reflector.get(BULL_MODULE_QUEUE_PROCESS, target);
  }

  isListener(target: Type<any> | Function | undefined): boolean {
    if (!target) {
      return false;
    }
    return !!this.reflector.get(BULL_MODULE_ON_QUEUE_EVENT, target);
  }

  getQueueComponentMetadata(target: Type<any> | Function): any {
    return this.reflector.get(BULL_MODULE_QUEUE, target);
  }

  getProcessMetadata(
    target: Type<any> | Function,
  ): ProcessOptions | undefined {
    return this.reflector.get<ProcessOptions>(
      BULL_MODULE_QUEUE_PROCESS,
      target,
    );
  }

  getListenerMetadata(
    target: Type<any> | Function,
  ): BullQueueEventOptions | undefined {
    return this.reflector.get<BullQueueEventOptions>(
      BULL_MODULE_ON_QUEUE_EVENT,
      target,
    );
  }
}
