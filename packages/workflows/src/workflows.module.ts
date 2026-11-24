import {
  Module,
  type DynamicModule,
  type OnModuleInit,
  type Type,
} from "@bunest/core";
import { DiscoveryModule, ModuleRef } from "@bunest/core";
import { WorkflowEvents } from "./events/workflow-events.service";
import type { WorkflowPayloadCodec } from "./interfaces/workflow-payload-codec.interface";
import type { WorkflowsModuleOptions } from "./interfaces/workflows-module-options.interface";
import { WorkflowClient } from "./services/workflow-client.service";
import { WorkflowRegistry } from "./services/workflow-registry.service";
import { WorkflowScheduler } from "./services/workflow-scheduler.service";
import { WorkflowSchedules } from "./services/workflow-schedules.service";
import { WorkflowWorker } from "./services/workflow-worker.service";
import { LOCK_STORAGE, WorkflowStorage } from "./storage/workflow.storage";
import { WORKFLOW_PAYLOAD_CODECS } from "./workflows.constants";
import {
  ConfigurableModuleClass,
  WORKFLOWS_MODULE_OPTIONS,
} from "./workflows.module-definition";

/**
 * `WorkflowsModule.forRoot({ clock?, worker?, retry?, journal?, allowInMemoryStorage?, codec? })`, or
 * `forRootAsync({ imports, inject, useFactory | useClass | useExisting })`. Global by default.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    {
      provide: WORKFLOW_PAYLOAD_CODECS,
      inject: [WORKFLOWS_MODULE_OPTIONS, ModuleRef],
      useFactory: payloadCodecs,
    },
    WorkflowStorage,
    WorkflowRegistry,
    WorkflowEvents,
    WorkflowScheduler,
    WorkflowWorker,
    WorkflowSchedules,
    WorkflowClient,
  ],
  exports: [
    WorkflowStorage,
    WorkflowClient,
    WorkflowSchedules,
    WorkflowWorker,
    WorkflowEvents,
    WorkflowRegistry,
  ],
})
export class WorkflowsModule
  extends ConfigurableModuleClass
  implements OnModuleInit
{
  static override forRoot(
    options: WorkflowsModuleOptions & { isGlobal?: boolean } = {},
  ): DynamicModule {
    return super.forRoot(options);
  }

  constructor(private readonly storage: WorkflowStorage) {
    super();
  }

  onModuleInit(): void {
    this.storage[LOCK_STORAGE]();
  }
}

function payloadCodecs(
  options: WorkflowsModuleOptions,
  moduleRef: ModuleRef,
): Promise<WorkflowPayloadCodec[]> {
  const codecs =
    options.codec === undefined
      ? []
      : Array.isArray(options.codec)
        ? options.codec
        : [options.codec];
  return Promise.all(
    codecs.map((codec) =>
      typeof codec === "function"
        ? moduleRef.create(codec as Type<WorkflowPayloadCodec>)
        : codec,
    ),
  );
}
