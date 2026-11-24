import { ConfigurableModuleBuilder } from "@bunest/core";
import type {
  LocksModuleExtras,
  LocksModuleOptions,
} from "./interfaces/locks-module-options.interface";

const built = new ConfigurableModuleBuilder<LocksModuleOptions>({
  moduleName: "Locks",
})
  .setClassMethodName("forRoot")
  // forRootAsync({ useClass }) calls createLocksOptions(), matching @nestjs/locks.
  .setFactoryMethodName("createLocksOptions")
  // `isGlobal` is structural: Bunest must know it when the module is defined.
  .setExtras<LocksModuleExtras>(
    { isGlobal: true },
    (definition, { isGlobal }) => ({
      ...definition,
      global: isGlobal,
    }),
  )
  .build();

export const ConfigurableModuleClass = built.ConfigurableModuleClass;
export const LOCKS_MODULE_OPTIONS: string | symbol =
  built.MODULE_OPTIONS_TOKEN as string | symbol;
export const OPTIONS_TYPE = built.OPTIONS_TYPE;
export const ASYNC_OPTIONS_TYPE = built.ASYNC_OPTIONS_TYPE;
