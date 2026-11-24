import { uuidv7 } from "@bunest/core";

export { uuidv7 };

/** `msg_0192…`: a UUIDv7 without dashes after a prefix, time-ordered, with no `.` (Standard Webhooks ids must not have one). */
export function prefixedId(prefix: string): string {
  return `${prefix}_${uuidv7().replaceAll("-", "")}`;
}
