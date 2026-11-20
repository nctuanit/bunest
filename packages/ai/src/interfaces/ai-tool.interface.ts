/**
 * Who an agent acts for.
 */
export interface AiCaller<TUser = any, TRequest = any> {
  /** The HTTP platform's request the agent runs in. */
  request?: TRequest;
  /** The user, where there is no request. */
  user?: TUser;
  /** Scopes the caller holds. */
  scopes?: readonly string[];
}

/**
 * What a call's `tools` lists: agent function names, and provider classes.
 */
export type AiToolSelection = ReadonlyArray<
  string | (abstract new (...args: any[]) => unknown)
>;
