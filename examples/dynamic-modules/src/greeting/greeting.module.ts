import { ConfigurableModuleBuilder, Inject, Injectable, Module } from "@bunest/core";

export interface GreetingModuleOptions {
  readonly prefix: string;
  readonly excited?: boolean;
}

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<GreetingModuleOptions>({
    moduleName: "Greeting",
  })
    .setClassMethodName("forRoot")
    .setExtras({ isGlobal: false }, (definition, extras) => ({
      ...definition,
      global: extras.isGlobal,
    }))
    .build();

@Injectable()
export class GreetingService {
  constructor(
    @Inject(MODULE_OPTIONS_TOKEN)
    private readonly options: GreetingModuleOptions,
  ) {}

  format(target: string): string {
    const suffix = this.options.excited ? "!" : ".";
    return `${this.options.prefix}, ${target}${suffix}`;
  }
}

@Module({
  providers: [GreetingService],
  exports: [GreetingService],
})
export class GreetingModule extends ConfigurableModuleClass {}
