import {
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@bunest/core";

@Injectable()
export class LifecycleRecorderService
  implements
    OnModuleInit,
    OnApplicationBootstrap,
    OnModuleDestroy,
    BeforeApplicationShutdown
{
  public readonly events: string[] = [];

  onModuleInit(): void {
    this.events.push("onModuleInit");
  }

  onApplicationBootstrap(): void {
    this.events.push("onApplicationBootstrap");
  }

  onModuleDestroy(): void {
    this.events.push("onModuleDestroy");
  }

  beforeApplicationShutdown(signal?: string): void {
    this.events.push(`beforeApplicationShutdown:${signal ?? "none"}`);
  }
}
