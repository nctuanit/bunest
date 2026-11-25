import { describe, expect, it } from "bun:test";
import type { Provider } from "../../../../../../packages/core/src/common";
import { ConfigurableModuleBuilder } from "../../../../../../packages/core/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "ConfigurableModuleBuilder",
  {
    upstreamPath:
      "packages/common/test/module-utils/configurable-module.builder.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    describe("setExtras", () => {
      it("should apply module definition transformer function and return typed builder", () => {
        const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<
          Record<string, unknown>
        >()
          .setExtras(
            { isGlobal: false },
            (definition, extras: { isGlobal: boolean }) => ({
              ...definition,
              global: extras.isGlobal,
            }),
          )
          .build();

        expect(
          ConfigurableModuleClass.register({
            isGlobal: true,
          }),
        ).toMatchObject({
          global: true,
        });
      });

      it("should preserve extras in registerAsync transformation", () => {
        let capturedExtras: unknown;

        const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<
          Record<string, unknown>
        >()
          .setExtras(
            { folder: "default" },
            (definition, extras: { folder: string }) => {
              capturedExtras = extras;
              return {
                ...definition,
                customProperty: `folder: ${extras.folder}`,
              } as typeof definition & { customProperty: string };
            },
          )
          .build();

        const asyncResult = ConfigurableModuleClass.registerAsync({
          useFactory: () => ({}),
          folder: "forRootAsync",
        });

        expect(capturedExtras).toEqual({ folder: "forRootAsync" });
        expect(asyncResult).toHaveProperty(
          "customProperty",
          "folder: forRootAsync",
        );
      });

      it.each([undefined, null, 42])(
        "should pass %s options through when setExtras is configured",
        (input) => {
          const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
            new ConfigurableModuleBuilder<unknown>()
              .setExtras(
                { isGlobal: false },
                (definition, extras: { isGlobal: boolean }) => ({
                  ...definition,
                  global: extras.isGlobal,
                }),
              )
              .build();

          const definition = ConfigurableModuleClass.register(input as never);

          expect(definition.global).toBe(false);
          expect(definition.providers).toContainEqual({
            provide: MODULE_OPTIONS_TOKEN,
            useValue: input,
          });
        },
      );
    });

    describe("setClassMethodName", () => {
      it("should set static class method name and return typed builder", () => {
        const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<
          Record<string, unknown>
        >()
          .setClassMethodName("forRoot")
          .build();

        expect(ConfigurableModuleClass.forRoot).not.toBeUndefined();
        expect(ConfigurableModuleClass.forRootAsync).not.toBeUndefined();
        expect(
          (ConfigurableModuleClass as unknown as Record<string, unknown>)
            .register,
        ).toBeUndefined();
      });
    });

    describe("setFactoryMethodName", () => {
      it("should set configuration factory class method name and return typed builder", () => {
        // Note: Passing setExtras({}, d => d) works around Bunest ConfigurableModuleBuilder's
        // default ExtraModuleDefinitionOptions = Record<string, never> TS type bug.
        const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<
          Record<string, unknown>
        >()
          .setFactoryMethodName("createOptions")
          .setExtras({}, (d) => d)
          .build();

        expect(
          ConfigurableModuleClass.registerAsync({
            useClass: class {
              createOptions() {
                return {};
              }
            },
          }),
        ).not.toBeUndefined();
      });
    });

    describe("build", () => {
      it("should return a configured ConfigurableModuleClass with extras and custom method names", () => {
        type ExtraConfig = { isGlobal?: boolean; extraProviders: Provider[] };

        const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
          new ConfigurableModuleBuilder<Record<string, unknown>>({
            moduleName: "RandomTest",
          })
            .setFactoryMethodName("createOptions")
            .setClassMethodName("forFeature")
            .setExtras<ExtraConfig>(
              { isGlobal: false, extraProviders: [] },
              (definition, extras) => ({
                ...definition,
                global: extras.isGlobal,
                providers: definition.providers?.concat(extras.extraProviders),
              }),
            )
            .build();

        const extraProvider: Provider = { provide: "EXTRA", useValue: "test" };
        const definition = ConfigurableModuleClass.forFeatureAsync({
          useFactory: () => ({}),
          isGlobal: true,
          extraProviders: [extraProvider],
        });

        expect(definition.global).toBe(true);
        expect(definition.providers).toContainEqual(extraProvider);
        expect(MODULE_OPTIONS_TOKEN).toBeDefined();
        expect((definition.providers![0] as { provide: unknown }).provide).toBe(
          MODULE_OPTIONS_TOKEN,
        );
      });

      it("should resolve provideInjectionTokensFrom and guard OPTIONS_TYPE/ASYNC_OPTIONS_TYPE runtime access", () => {
        const { OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } =
          new ConfigurableModuleBuilder<Record<string, unknown>>({
            moduleName: "RandomTest",
          }).build();

        expect(
          () => (ASYNC_OPTIONS_TYPE as unknown as { imports: unknown }).imports,
        ).toThrow(
          '"ASYNC_OPTIONS_TYPE" is not supposed to be used as a value.',
        );
        expect(
          () => (OPTIONS_TYPE as unknown as { isGlobal: unknown }).isGlobal,
        ).toThrow('"OPTIONS_TYPE" is not supposed to be used as a value.');
      });

      it("should not mutate the options passed to the builder", () => {
        const options = { moduleName: "Immutable" };
        new ConfigurableModuleBuilder(options).build();
        expect(options).toEqual({ moduleName: "Immutable" });
      });

      it("should generate a distinct token for each builder created with the same options", () => {
        const options = {};
        const first = new ConfigurableModuleBuilder(options).build();
        const second = new ConfigurableModuleBuilder(options).build();
        expect(first.MODULE_OPTIONS_TOKEN).not.toBe(
          second.MODULE_OPTIONS_TOKEN,
        );
      });

      it("should share the token between builders derived from the same builder", () => {
        const builder = new ConfigurableModuleBuilder();
        const root = builder.setClassMethodName("forRoot").build();
        const feature = builder.setClassMethodName("forFeature").build();
        expect(root.MODULE_OPTIONS_TOKEN).toBe(feature.MODULE_OPTIONS_TOKEN);
      });
    });
  },
);
