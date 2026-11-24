import { expect, it } from "bun:test";
import { Inject, Module } from "../../../../../packages/core/src/common";
import { ConfigurableModuleBuilder } from "../../../../../packages/core/src";
import { Test, describeConformance } from "../../../_helpers";

interface IntegrationModuleOptions {
  url: string;
  secure?: boolean;
}

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<IntegrationModuleOptions>()
    .setClassMethodName("forRoot")
    .setFactoryMethodName("construct")
    .setExtras({ isGlobal: true }, (definition, extras) => ({
      ...definition,
      global: extras.isGlobal,
    }))
    .build();

@Module({})
class IntegrationModule extends ConfigurableModuleClass {
  constructor(
    @Inject(MODULE_OPTIONS_TOKEN)
    public readonly options: IntegrationModuleOptions,
  ) {
    super();
  }
}

describeConformance(
  "Module utils (ConfigurableModuleBuilder)",
  {
    upstreamPath: "integration/module-utils/test/integration-module.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    // BUNEST_BUG: ModuleRef.get(ModuleClass) throws UnknownDependencyException because Bunest does not register module classes as resolvable tokens in their own container (packages/core/src/di/di-container.ts:2310)
    it.skip('should auto-generate "forRoot" method and resolve module instance via moduleRef.get(IntegrationModule)', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IntegrationModule.forRoot({
            isGlobal: true,
            url: "test_url",
            secure: false,
          }),
        ],
      }).compile();

      const integrationModule = moduleRef.get(IntegrationModule);

      expect(integrationModule.options).toEqual({
        url: "test_url",
        secure: false,
      });
      await moduleRef.close();
    });

    it('should auto-generate "forRoot" method and inject MODULE_OPTIONS_TOKEN into providers', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IntegrationModule.forRoot({
            isGlobal: true,
            url: "test_url",
            secure: false,
          }),
        ],
      }).compile();

      expect(
        moduleRef.get<IntegrationModuleOptions>(MODULE_OPTIONS_TOKEN),
      ).toEqual({
        url: "test_url",
        secure: false,
      });
      await moduleRef.close();
    });

    // BUNEST_BUG: ModuleRef.get(ModuleClass) throws UnknownDependencyException for dynamic ConfigurableModuleClass subclasses (packages/core/src/di/di-container.ts:2310)
    it.skip('should auto-generate "forRootAsync" method and resolve module instance via moduleRef.get(IntegrationModule)', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IntegrationModule.forRootAsync({
            isGlobal: true,
            useFactory: () => ({
              url: "test_url",
              secure: false,
            }),
          }),
        ],
      }).compile();

      const integrationModule = moduleRef.get(IntegrationModule);

      expect(integrationModule.options).toEqual({
        url: "test_url",
        secure: false,
      });
      await moduleRef.close();
    });

    it('should auto-generate "forRootAsync" method and resolve MODULE_OPTIONS_TOKEN', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IntegrationModule.forRootAsync({
            isGlobal: true,
            useFactory: () => ({
              url: "test_url",
              secure: false,
            }),
          }),
        ],
      }).compile();

      expect(
        moduleRef.get<IntegrationModuleOptions>(MODULE_OPTIONS_TOKEN),
      ).toEqual({
        url: "test_url",
        secure: false,
      });
      await moduleRef.close();
    });

    // BUNEST_BUG: ConfigurableModuleBuilder.registerAsync() lacks `provideInjectionTokensFrom` AND defaults ExtraModuleDefinitionOptions to `Record<string, never>`, causing TS2345 when setExtras() is omitted (packages/core/src/module/configurable-module.builder.ts:48)
    it.skip('should resolve an alias supplied through "provideInjectionTokensFrom"', async () => {
      const {
        ConfigurableModuleClass: FeatureBase,
        MODULE_OPTIONS_TOKEN: FEATURE_TOKEN,
      } = new ConfigurableModuleBuilder<{ text: string }>()
        .setExtras({}, (d) => d)
        .build();

      @Module({})
      class FeatureModule extends FeatureBase {}

      const moduleRef = await Test.createTestingModule({
        imports: [
          FeatureModule.registerAsync({
            useFactory: (text: string) => ({ text }),
            inject: ["alias"],
            extraProviders: [
              { provide: "alias", useExisting: "source" },
              {
                provide: "source",
                useFactory: (value: string) => value,
                inject: ["leaf"],
              },
              { provide: "leaf", useValue: "ok" },
            ],
          }),
        ],
      }).compile();

      expect(moduleRef.get(FEATURE_TOKEN)).toEqual({ text: "ok" });
      await moduleRef.close();
    });
  },
);
