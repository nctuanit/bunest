import { createParamDecorator } from "@bunest/common";
import { getI18nStore } from "../context/i18n.storage";

/** Injects the current request's locale: `@CurrentLocale() locale: string`. */
export const CurrentLocale: () => ParameterDecorator = createParamDecorator(
  () => getI18nStore()?.locale,
);
