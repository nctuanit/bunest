import { channel, type Channel } from "node:diagnostics_channel";
import type { WorkflowEvent } from "./workflow-events.interface";

const channels = new Map<WorkflowEvent["type"], Channel>();

export const channelFor = (type: WorkflowEvent["type"]): Channel => {
  let target = channels.get(type);
  if (!target) {
    target = channel(`nestjs:workflows:${type}`);
    channels.set(type, target);
  }
  return target;
};
