import { Inject } from "@bunest/common";
import { getQueueToken } from "../utils/get-queue-token.util";

/**
 * Injects Bull's queue instance with the given name.
 * @param name queue name
 *
 * @publicApi
 */
export const InjectQueue = (name?: string): ReturnType<typeof Inject> =>
  Inject(getQueueToken(name));
