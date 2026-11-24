import { channel, type DiagnosticChannel } from "@bunest/core";
import type { WorkflowEvent } from "./workflow-events.interface";

const channels = new Map<WorkflowEvent["type"], DiagnosticChannel>();

export const channelFor = (type: WorkflowEvent["type"]): DiagnosticChannel => {
  let target = channels.get(type);
  if (!target) {
    target = channel(`nestjs:workflows:${type}`);
    channels.set(type, target);
  }
  return target;
};
