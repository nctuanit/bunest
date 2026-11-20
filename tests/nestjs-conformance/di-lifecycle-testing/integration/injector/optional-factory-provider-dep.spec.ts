import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Scope } from "../../../../../packages/common/src";
import { UnknownDependencyException } from "../../../../../packages/core/src";
import { Test, describeConformance } from "../../../_helpers";

describeConformance(
  "Optional factory provider deps",
  {
    upstreamPath:
      "integration/injector/e2e/optional-factory-provider-dep.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-012"],
    notes:
      "Maps NestJS UnknownDependenciesException to Bunest UnknownDependencyException.",
  },
  () => {
    describe("when dependency is optional", () => {
      describe("and it is available", () => {
        it("then it should be injected into the factory function", async () => {
          const defaultValue = "DEFAULT_VALUE";
          const moduleRef = await Test.createTestingModule({
            providers: [
              {
                provide: "FACTORY",
                useFactory: (dep?: string) => dep ?? defaultValue,
                inject: [{ token: "MISSING_DEP", optional: true }],
              },
              { provide: "MISSING_DEP", useValue: "OPTIONAL_DEP_VALUE" },
            ],
          }).compile();

          const factoryProvider = moduleRef.get("FACTORY");
          expect(factoryProvider).toBe("OPTIONAL_DEP_VALUE");
          await moduleRef.close();
        });
      });

      describe("otherwise", () => {
        it('"undefined" should be injected into the factory function', async () => {
          const defaultValue = "DEFAULT_VALUE";
          const moduleRef = await Test.createTestingModule({
            providers: [
              {
                provide: "FACTORY",
                useFactory: (dep?: string) => dep ?? defaultValue,
                inject: [{ token: "MISSING_DEP", optional: true }],
              },
            ],
          }).compile();

          const factoryProvider = moduleRef.get("FACTORY");
          expect(factoryProvider).toBe(defaultValue);
          await moduleRef.close();
        });

        it('"undefined" should be injected into the factory function (scoped provider)', async () => {
          const MY_PROVIDER = "MY_PROVIDER";
          const FIRST_OPTIONAL_DEPENDENCY = "FIRST_OPTIONAL_DEPENDENCY";
          const SECOND_OPTIONAL_DEPENDENCY = "SECOND_OPTIONAL_DEPENDENCY";

          const module = await Test.createTestingModule({
            providers: [
              {
                provide: SECOND_OPTIONAL_DEPENDENCY,
                useValue: "second",
              },
              {
                provide: MY_PROVIDER,
                scope: Scope.REQUEST,
                inject: [
                  {
                    token: FIRST_OPTIONAL_DEPENDENCY,
                    optional: true,
                  },
                  {
                    token: SECOND_OPTIONAL_DEPENDENCY,
                    optional: true,
                  },
                ],
                useFactory: (first?: string, second?: string) => ({
                  first,
                  second,
                }),
              },
            ],
          }).compile();

          expect(await module.resolve(MY_PROVIDER)).toEqual({
            first: undefined,
            second: "second",
          });
          await module.close();
        });
      });
    });

    describe("otherwise", () => {
      describe("and dependency is not registered", () => {
        it("should error out", async () => {
          const builder = Test.createTestingModule({
            providers: [
              {
                provide: "FACTORY",
                useFactory: () => "RETURNED_VALUE",
                inject: ["MISSING_DEP"],
              },
            ],
          });
          await expect(builder.compile()).rejects.toBeInstanceOf(
            UnknownDependencyException,
          );
        });
      });
    });

    describe("and dependency is registered but it cannot be instantiated", () => {
      it("should error out", async () => {
        const builder = Test.createTestingModule({
          providers: [
            {
              provide: "POSSIBLY_MISSING_DEP",
              useFactory: () => null,
              inject: ["MISSING_DEP"],
            },
            {
              provide: "FACTORY",
              useFactory: () => "RETURNED_VALUE",
              inject: [{ token: "POSSIBLY_MISSING_DEP", optional: false }],
            },
          ],
        });

        try {
          await builder.compile();
          throw new Error("Expected compile() to throw");
        } catch (err) {
          expect(err).toBeInstanceOf(UnknownDependencyException);
          expect((err as Error).message).toContain("POSSIBLY_MISSING_DEP");
        }
      });
    });
  },
);
