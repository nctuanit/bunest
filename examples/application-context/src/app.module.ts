import { ClsModule, Module } from "@bunest/core";
import { JobRunnerService } from "./context/job-runner.service";
import { LifecycleRecorderService } from "./lifecycle/lifecycle.service";
import {
  RequestScopedJobContext,
  TransientTokenService,
} from "./scopes/scoped.services";

@Module({
  imports: [ClsModule.forRoot({ global: true })],
  providers: [
    LifecycleRecorderService,
    TransientTokenService,
    RequestScopedJobContext,
    JobRunnerService,
  ],
  exports: [
    LifecycleRecorderService,
    TransientTokenService,
    RequestScopedJobContext,
    JobRunnerService,
  ],
})
export class AppModule {}
