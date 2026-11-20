import { ConfigurableModuleBuilder } from "@bunest/common";
import type {
  IdempotencyModuleExtras,
  IdempotencyModuleOptions,
} from "./interfaces/idempotency-module-options.interface";

const built = new ConfigurableModuleBuilder<IdempotencyModuleOptions>({
  moduleName: "Idempotency",
})
  .setClassMethodName("forRoot")
  // forRootAsync({ useClass }) calls createIdempotencyOptions(): see IdempotencyOptionsFactory.
  .setFactoryMethodName("createIdempotencyOptions")
  // `isGlobal` is structural: must be known when the module is defined.
  .setExtras<IdempotencyModuleExtras>(
    { isGlobal: true },
    (definition, { isGlobal }) => ({
      ...definition,
      global: isGlobal,
    }),
  )
  .build();

export const ConfigurableModuleClass = built.ConfigurableModuleClass;
export const IDEMPOTENCY_MODULE_OPTIONS: string | symbol =
  built.MODULE_OPTIONS_TOKEN as string | symbol;
export const OPTIONS_TYPE = built.OPTIONS_TYPE;
export const ASYNC_OPTIONS_TYPE = built.ASYNC_OPTIONS_TYPE;
