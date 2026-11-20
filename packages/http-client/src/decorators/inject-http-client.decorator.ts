import { Inject } from "@bunest/common";
import { getHttpClientToken } from "../http-client.module-definition";

/** `@InjectHttpClient('github')`; without a name, same as typing the param as `HttpClient`. */
export const InjectHttpClient = (
  name?: string,
): PropertyDecorator & ParameterDecorator =>
  Inject(getHttpClientToken(name)) as PropertyDecorator & ParameterDecorator;
