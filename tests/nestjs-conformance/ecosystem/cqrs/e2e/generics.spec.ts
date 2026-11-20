import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Scope } from "../../../../../packages/common/src";
import {
  ModuleRef,
  type InstanceWrapper,
} from "../../../../../packages/core/src";
import {
  Command,
  CommandBus,
  Query,
  QueryBus,
  type ICommandHandler,
} from "../../../../../packages/cqrs/src";
import {
  Test,
  describeConformance,
  itAdapted,
  type TestingModule,
} from "../../../_helpers";
import { CqrsAppModule } from "../_fixtures/cqrs-fixtures";

describeConformance(
  "Generics",
  {
    upstreamPath: "nestjs/cqrs/test/e2e/generics.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS InstanceWrapper class constructor to Bunest InstanceWrapper type-only interface (ADR-002 verbatimModuleSyntax).",
  },
  () => {
    let moduleRef: TestingModule;
    let commandBus: CommandBus;
    let queryBus: QueryBus;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [CqrsAppModule],
      }).compile();

      await moduleRef.init();

      commandBus = moduleRef.get(CommandBus);
      queryBus = moduleRef.get(QueryBus);
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    describe("Commands", () => {
      describe('when "Command" utility class is used', () => {
        it("should infer return type", async () => {
          const command = new Command<string>();

          try {
            await commandBus.execute(command).then((value) => {
              value as string;

              // @ts-expect-error string cannot be directly asserted as number
              value as number;
            });
          } catch {
            // Do nothing
          } finally {
            expect(true).toBeTruthy();
          }
        });
      });

      describe("when any other class is used", () => {
        it("should fallback to any return type", async () => {
          class MyCommand {}

          const command = new MyCommand();

          try {
            await commandBus.execute(command).then((value) => {
              value as string;
              value as number;
            });
          } catch {
            // Do nothing
          } finally {
            expect(true).toBeTruthy();
          }
        });

        it("should use the 2nd generic parameter as return type", async () => {
          class MyCommand {}

          const command = new MyCommand();

          try {
            await commandBus
              .execute<MyCommand, string>(command)
              .then((value) => {
                value as string;

                // @ts-expect-error string cannot be directly asserted as number
                value as number;
              });
          } catch {
            // Do nothing
          } finally {
            expect(true).toBeTruthy();
          }
        });
      });
    });

    describe("Queries", () => {
      describe('when "Query" utility class is used', () => {
        it("should infer return type", async () => {
          const query = new Query<string>();

          try {
            await queryBus.execute(query).then((value) => {
              value as string;

              // @ts-expect-error string cannot be directly asserted as number
              value as number;
            });
          } catch {
            // Do nothing
          } finally {
            expect(true).toBeTruthy();
          }
        });
      });

      describe("when any other class is used", () => {
        it("should fallback to any return type", async () => {
          class MyQuery {}

          const query = new MyQuery();

          try {
            await queryBus.execute(query).then((value) => {
              value as string;
              value as number;
            });
          } catch {
            // Do nothing
          } finally {
            expect(true).toBeTruthy();
          }
        });

        it("should use the 2nd generic parameter as return type", async () => {
          class MyQuery {}

          const query = new MyQuery();

          try {
            await queryBus.execute<MyQuery, string>(query).then((value) => {
              value as string;

              // @ts-expect-error string cannot be directly asserted as number
              value as number;
            });
          } catch {
            // Do nothing
          } finally {
            expect(true).toBeTruthy();
          }
        });
      });
    });

    describe("Command handlers", () => {
      itAdapted(
        "ADR-002",
        "should infer return type",
        async () => {
          class TestCmd extends Command<{
            value: string;
          }> {}

          class ValidHandler implements ICommandHandler<TestCmd> {
            execute(_command: TestCmd): Promise<{ value: string }> {
              throw new Error("Method not implemented.");
            }
          }

          class InvalidHandler implements ICommandHandler<TestCmd> {
            // @ts-expect-error return value property is number instead of string
            execute(_command: TestCmd): Promise<{ value: number }> {
              throw new Error("Method not implemented.");
            }
          }

          try {
            const coreModuleRef = moduleRef.get(ModuleRef);
            const validWrapper: InstanceWrapper<ValidHandler> = {
              token: ValidHandler,
              metatype: ValidHandler,
              instance: new ValidHandler(),
              scope: Scope.SINGLETON,
              isDependencyTreeStatic: true,
              moduleId: "test",
              moduleRef: coreModuleRef,
            };
            const invalidWrapper: InstanceWrapper<ICommandHandler<TestCmd>> = {
              token: InvalidHandler as any,
              metatype: InvalidHandler as any,
              instance: new InvalidHandler() as any,
              scope: Scope.SINGLETON,
              isDependencyTreeStatic: true,
              moduleId: "test",
              moduleRef: coreModuleRef,
            };

            commandBus.bind(validWrapper, "Test");
            commandBus.bind(invalidWrapper, "Test2");

            await commandBus.execute(new TestCmd()).then((value) => {
              value.value as string;

              // @ts-expect-error object cannot be directly asserted as number
              value as number;
            });
          } catch {
            // Do nothing
          } finally {
            expect(true).toBeTruthy();
          }
        },
        "InstanceWrapper type-only interface in Bunest",
      );
    });
  },
);
