import { ConfigurableModuleBuilder } from "@bunest/common";
import type { WorkflowsModuleOptions } from "./interfaces/workflows-module-options.interface";

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN: WORKFLOWS_MODULE_OPTIONS,
} = new ConfigurableModuleBuilder<WorkflowsModuleOptions>({
  moduleName: "Workflows",
})
  .setClassMethodName("forRoot")
  .setFactoryMethodName("createWorkflowsOptions")
  .setExtras({ isGlobal: true }, (definition, { isGlobal }) => ({
    ...definition,
    global: isGlobal,
  }))
  .build();
