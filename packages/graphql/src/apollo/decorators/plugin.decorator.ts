import { SetMetadata } from "@bunest/core";
import { PLUGIN_METADATA } from "../constants/apollo.constants";

/**
 * Decorator that marks a class as an Apollo plugin.
 *
 * @publicApi
 */
export function Plugin(): ClassDecorator {
  return (target: Function) => {
    SetMetadata(PLUGIN_METADATA, true)(target);
  };
}
