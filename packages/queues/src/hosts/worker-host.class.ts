import type { BullMQWorkerLike, Job } from "../interfaces";

/**
 * Abstract base class for BullMQ v5/v6 class-based queue processors.
 *
 * Subclasses decorated with `@Processor(queueName)` implement `process(job, token?)`
 * and access the underlying worker via `this.worker` once initialized.
 */
export abstract class WorkerHost<T = BullMQWorkerLike<any, any>> {
  private _worker?: T;

  get worker(): T {
    if (!this._worker) {
      throw new Error(
        '"Worker" has not yet been initialized. Make sure to interact with worker instances after the "onModuleInit" lifecycle hook is triggered for example, in the "onApplicationBootstrap" hook, or if "manualRegistration" is set to true make sure to call "BullRegistrar.register()"',
      );
    }
    return this._worker;
  }

  abstract process(job: Job<any, any>, token?: string): Promise<any>;
}
