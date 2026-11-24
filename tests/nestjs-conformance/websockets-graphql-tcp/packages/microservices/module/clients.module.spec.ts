import { describe, expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Module,
  type ClassProvider,
  type DynamicModule,
  type FactoryProvider,
} from "../../../../../../packages/core/src/common";
import {
  ClientProxy,
  ClientsModule,
  InMemoryBroker,
  InMemoryClientProxy,
  TcpClientProxy,
  Transport,
  type ClientsOptionsFactory,
  type TransportConfig,
} from "../../../../../../packages/microservices/src";
import { Test } from "../../../../../../packages/testing/src";
import {
  createSpy,
  describeConformance,
  expectCalledOnce,
  spyOnMethod,
} from "../../../../_helpers";

describeConformance(
  "ClientsModule",
  {
    upstreamPath: "packages/microservices/test/module/clients.module.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-007"],
    notes:
      "Ports ClientsModule.register() and ClientsModule.registerAsync() (useFactory, useClass, useExisting, DI resolution, global option, and OnModuleDestroy teardown).",
  },
  () => {
    let dynamicModule: DynamicModule;

    describe("register", () => {
      it("should return an expected DynamicModule referencing ClientsModule", () => {
        dynamicModule = ClientsModule.register([
          {
            name: "test",
            transport: Transport.TCP,
            options: {},
          },
        ]);

        expect(dynamicModule.module).toBe(ClientsModule);
        expect(dynamicModule.global).toBe(false);
        expect(dynamicModule.exports).toEqual(["test"]);
      });

      it("should respect the optional global flag", () => {
        const globalMod = ClientsModule.register(
          [{ name: "global_client", transport: Transport.TCP, options: {} }],
          { global: true },
        );

        expect(globalMod.global).toBe(true);
      });

      it("should return an expected providers array creating a ClientProxy with onModuleDestroy lifecycle", async () => {
        dynamicModule = ClientsModule.register([
          {
            name: "test",
            transport: Transport.TCP,
            options: {},
          },
        ]);

        const provider = dynamicModule.providers?.find(
          (p): p is FactoryProvider =>
            typeof p === "object" && "useFactory" in p && p.provide === "test",
        );

        expect(provider).toBeDefined();
        const proxy = await provider!.useFactory();
        expect(proxy).toBeInstanceOf(ClientProxy);
        expect(proxy).toBeInstanceOf(TcpClientProxy);

        const closeSpy = spyOnMethod(proxy as TcpClientProxy, "close");
        await (proxy as TcpClientProxy).onModuleDestroy();
        expectCalledOnce(closeSpy);
      });

      it("should register multiple named clients and resolve them via DI", async () => {
        const broker = new InMemoryBroker();
        const TOKEN_A = Symbol("CLIENT_A");
        const TOKEN_B = "CLIENT_B";

        @Injectable()
        class Consumer {
          constructor(
            @Inject(TOKEN_A) readonly clientA: ClientProxy,
            @Inject(TOKEN_B) readonly clientB: ClientProxy,
          ) {}
        }

        const mod = await Test.createTestingModule({
          imports: [
            ClientsModule.register([
              {
                name: TOKEN_A,
                transport: Transport.IN_MEMORY,
                options: { channel: "chan-a", broker },
              },
              {
                name: TOKEN_B,
                transport: Transport.TCP,
                options: { host: "127.0.0.1", port: 0 },
              },
            ]),
          ],
          providers: [Consumer],
        }).compile();

        await mod.init();
        try {
          const consumer = mod.get(Consumer);
          expect(consumer.clientA).toBeInstanceOf(InMemoryClientProxy);
          expect(consumer.clientB).toBeInstanceOf(TcpClientProxy);
        } finally {
          await mod.close();
        }
      });
    });

    describe("registerAsync", () => {
      const useFactory = (): TransportConfig => ({
        transport: Transport.TCP,
        options: {},
      });
      const registerOption = {
        name: "test",
        useFactory,
      };

      it("should return an expected module ref", () => {
        dynamicModule = ClientsModule.registerAsync([registerOption]);
        expect(dynamicModule.module).toBe(ClientsModule);
        expect(dynamicModule.global).toBe(false);
      });

      it("should support global: true in registerAsync", () => {
        dynamicModule = ClientsModule.registerAsync([registerOption], {
          global: true,
        });
        expect(dynamicModule.global).toBe(true);
      });

      describe("when useFactory", () => {
        it("should return an expected providers array with useFactory", async () => {
          dynamicModule = ClientsModule.registerAsync([registerOption]);

          expect(dynamicModule.imports).toEqual([]);
          expect(dynamicModule.exports).toEqual(["test"]);
          expect(dynamicModule.providers).toHaveLength(1);

          const provider = dynamicModule.providers![0] as FactoryProvider;
          expect(provider.provide).toBe("test");
          expect(provider.inject).toEqual([]);
          expect(provider.useFactory).toBeInstanceOf(Function);

          const proxy = await provider.useFactory();
          expect(proxy).toBeInstanceOf(TcpClientProxy);
          await (proxy as TcpClientProxy).close();
        });

        it("should inject dependencies and imported modules into async useFactory", async () => {
          const CONFIG_TOKEN = "RPC_CONFIG";

          @Module({
            providers: [
              {
                provide: CONFIG_TOKEN,
                useValue: { channel: "async-factory-chan" },
              },
            ],
            exports: [CONFIG_TOKEN],
          })
          class ConfigModule {}

          const broker = new InMemoryBroker();
          const mod = await Test.createTestingModule({
            imports: [
              ClientsModule.registerAsync([
                {
                  name: "ASYNC_CLIENT",
                  imports: [ConfigModule],
                  inject: [CONFIG_TOKEN],
                  useFactory: async (cfg: { channel: string }) => ({
                    transport: Transport.IN_MEMORY,
                    options: { channel: cfg.channel, broker },
                  }),
                },
              ]),
            ],
          }).compile();

          await mod.init();
          try {
            const client = mod.get<InMemoryClientProxy>("ASYNC_CLIENT");
            expect(client).toBeInstanceOf(InMemoryClientProxy);
            expect(client.channel).toBe("async-factory-chan");
          } finally {
            await mod.close();
          }
        });
      });

      describe("when useClass", () => {
        it("should return an expected providers array with useClass", () => {
          @Injectable()
          class ClientOptionService implements ClientsOptionsFactory {
            createClientOptions(): Promise<TransportConfig> | TransportConfig {
              return {
                transport: Transport.TCP,
                options: {},
              };
            }
          }

          dynamicModule = ClientsModule.registerAsync([
            {
              name: "classTest",
              useClass: ClientOptionService,
            },
          ]);

          expect(dynamicModule.imports).toEqual([]);
          expect(dynamicModule.exports).toEqual(["classTest"]);
          expect(dynamicModule.providers).toHaveLength(2);

          const classProvider = dynamicModule.providers!.find(
            (p): p is ClassProvider =>
              typeof p === "object" &&
              "useClass" in p &&
              p.provide === ClientOptionService,
          );
          expect(classProvider?.useClass).toBe(ClientOptionService);

          const factoryProvider = dynamicModule.providers!.find(
            (p): p is FactoryProvider =>
              typeof p === "object" &&
              "useFactory" in p &&
              p.provide === "classTest",
          );
          expect(factoryProvider).toBeDefined();
          expect(factoryProvider!.provide).toBe("classTest");
          expect(factoryProvider!.inject).toEqual([ClientOptionService]);
          expect(factoryProvider!.useFactory).toBeInstanceOf(Function);
        });

        it('provider should call "createClientOptions"', async () => {
          @Injectable()
          class DummyFactory implements ClientsOptionsFactory {
            createClientOptions(): TransportConfig {
              return { transport: Transport.TCP, options: {} };
            }
          }

          const mod = ClientsModule.registerAsync([
            {
              name: "classClient",
              useClass: DummyFactory,
            },
          ]);
          const factoryProvider = mod.providers!.find(
            (p): p is FactoryProvider =>
              typeof p === "object" &&
              "useFactory" in p &&
              p.provide === "classClient",
          )!;

          const createClientOptions = createSpy((): TransportConfig => ({
            transport: Transport.TCP,
            options: {},
          }));
          const proxy = await factoryProvider.useFactory({
            createClientOptions,
          });
          expectCalledOnce(createClientOptions);
          expect(proxy).toBeInstanceOf(TcpClientProxy);
          await (proxy as TcpClientProxy).close();
        });

        it("should resolve useClass options factory end-to-end via DI", async () => {
          const broker = new InMemoryBroker();

          @Injectable()
          class InMemoryOptionsFactory implements ClientsOptionsFactory {
            async createClientOptions(): Promise<TransportConfig> {
              return {
                transport: Transport.IN_MEMORY,
                options: { channel: "use-class-chan", broker },
              };
            }
          }

          const mod = await Test.createTestingModule({
            imports: [
              ClientsModule.registerAsync([
                {
                  name: "CLASS_CLIENT",
                  useClass: InMemoryOptionsFactory,
                },
              ]),
            ],
          }).compile();

          await mod.init();
          try {
            const client = mod.get<InMemoryClientProxy>("CLASS_CLIENT");
            expect(client).toBeInstanceOf(InMemoryClientProxy);
            expect(client.channel).toBe("use-class-chan");
          } finally {
            await mod.close();
          }
        });
      });

      describe("when useExisting", () => {
        it("should provide a factory provider injecting the existing token", async () => {
          const EXISTING_TOKEN = "EXISTING_OPTIONS_FACTORY";
          dynamicModule = ClientsModule.registerAsync([
            {
              name: "existingTest",
              useExisting: EXISTING_TOKEN,
            },
          ]);

          expect(dynamicModule.providers).toHaveLength(1);
          expect(dynamicModule.imports).toEqual([]);
          expect(dynamicModule.exports).toEqual(["existingTest"]);

          const provider = dynamicModule.providers![0] as FactoryProvider;
          expect(provider.provide).toBe("existingTest");
          expect(provider.inject).toEqual([EXISTING_TOKEN]);
          expect(provider.useFactory).toBeInstanceOf(Function);

          const createClientOptions = createSpy((): TransportConfig => ({
            transport: Transport.TCP,
            options: {},
          }));
          const proxy = await provider.useFactory({ createClientOptions });
          expectCalledOnce(createClientOptions);
          expect(proxy).toBeInstanceOf(TcpClientProxy);
          await (proxy as TcpClientProxy).close();
        });

        it("should reuse an existing factory provider from an imported module", async () => {
          const broker = new InMemoryBroker();

          @Injectable()
          class SharedOptionsFactory implements ClientsOptionsFactory {
            public callCount = 0;
            createClientOptions(): TransportConfig {
              this.callCount++;
              return {
                transport: Transport.IN_MEMORY,
                options: { channel: "existing-chan", broker },
              };
            }
          }

          @Module({
            providers: [SharedOptionsFactory],
            exports: [SharedOptionsFactory],
          })
          class SharedFactoryModule {}

          const mod = await Test.createTestingModule({
            imports: [
              SharedFactoryModule,
              ClientsModule.registerAsync([
                {
                  name: "EXISTING_CLIENT",
                  imports: [SharedFactoryModule],
                  useExisting: SharedOptionsFactory,
                },
              ]),
            ],
          }).compile();

          await mod.init();
          try {
            const client = mod.get<InMemoryClientProxy>("EXISTING_CLIENT");
            const factory = mod.get(SharedOptionsFactory);
            expect(client).toBeInstanceOf(InMemoryClientProxy);
            expect(client.channel).toBe("existing-chan");
            expect(factory.callCount).toBe(1);
          } finally {
            await mod.close();
          }
        });
      });

      describe("when invalid async options are provided", () => {
        it("should throw when none of useFactory, useClass, or useExisting is provided", () => {
          expect(() =>
            ClientsModule.registerAsync([{ name: "invalidClient" }]),
          ).toThrow(/requires "useFactory", "useClass", or "useExisting"/);
        });
      });

      describe("lifecycle teardown", () => {
        it("should close registered clients when testing module closes", async () => {
          const mod = await Test.createTestingModule({
            imports: [
              ClientsModule.register([
                {
                  name: "LIFECYCLE_CLIENT",
                  transport: Transport.TCP,
                  options: { host: "127.0.0.1", port: 0 },
                },
              ]),
            ],
          }).compile();
          await mod.init();

          const client = mod.get<TcpClientProxy>("LIFECYCLE_CLIENT");
          const closeSpy = spyOnMethod(client, "close");

          await mod.close();
          expectCalledOnce(closeSpy);
        });
      });
    });
  },
);
