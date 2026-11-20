import { Inject } from "@bunest/common";
import { DEFAULT_CONNECTION_NAME } from "../drizzle.constants";
import { getDrizzleToken } from "./drizzle.utils";

/**
 * Injects the Drizzle database registered under the given connection name.
 *
 * @param name Connection name (default: `"default"`)
 * @publicApi
 */
export const InjectDrizzle = (
  name: string = DEFAULT_CONNECTION_NAME,
): PropertyDecorator & ParameterDecorator => Inject(getDrizzleToken(name));
