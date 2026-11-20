import { createParamDecorator } from "@bunest/common";
import { signalOfAttempt } from "../context/attempt-scope.context";

/**
 * Injects the current attempt's `AbortSignal` into a handler parameter, on
 * every transport. It is aborted when the attempt times out.
 */
export const Signal: () => ParameterDecorator =
  createParamDecorator(signalOfAttempt);
