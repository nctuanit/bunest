import { expect, it } from "bun:test";
import { Injectable } from "../../../../../packages/core/src/common";
import {
  ApplicationConfig,
  HttpAdapterHost,
} from "../../../../../packages/core/src";
import {
  AbstractGraphQLDriver,
  type GqlModuleOptions,
  GraphQLFactory,
  ResolverDecoratorHost,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

@Injectable()
class TestGraphQLDriver extends AbstractGraphQLDriver<GqlModuleOptions> {
  async start(_options: GqlModuleOptions): Promise<void> {}
  async stop(): Promise<void> {}
}

describeConformance(
  "Subscription path with global prefix",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/subscription-global-prefix.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloDriver.mergeDefaultOptions global prefix + graphql-ws path prefixing spec to Bunest AbstractGraphQLDriver.",
  },
  () => {
    async function createDriver(prefix: string) {
      const applicationConfig = new ApplicationConfig();
      applicationConfig.setGlobalPrefix(prefix);

      const moduleRef = await Test.createTestingModule({
        providers: [
          TestGraphQLDriver,
          ResolverDecoratorHost,
          { provide: ApplicationConfig, useValue: applicationConfig },
          { provide: HttpAdapterHost, useValue: {} },
          { provide: GraphQLFactory, useValue: {} },
        ],
      }).compile({ logger: false });

      const driver = moduleRef.get(TestGraphQLDriver);
      return { driver, close: () => moduleRef.close() };
    }

    it("prefixes the http endpoint when useGlobalPrefix is true", async () => {
      const { driver, close } = await createDriver("api");
      try {
        const merged = await driver.mergeDefaultOptions({
          useGlobalPrefix: true,
        });

        expect(merged.path).toBe("/api/graphql");
      } finally {
        await close();
      }
    });

    it("prefixes a custom subscription path when useGlobalPrefix is true", async () => {
      const { driver, close } = await createDriver("api");
      try {
        const merged = await driver.mergeDefaultOptions({
          useGlobalPrefix: true,
          subscriptions: {
            "graphql-ws": { path: "/graphql" },
          },
        });

        expect(
          typeof merged.subscriptions === "object"
            ? merged.subscriptions["graphql-ws"]
            : undefined,
        ).toMatchObject({
          path: "/api/graphql",
        });
      } finally {
        await close();
      }
    });

    it("prefixes a non-default subscription path when useGlobalPrefix is true", async () => {
      const { driver, close } = await createDriver("api");
      try {
        const merged = await driver.mergeDefaultOptions({
          useGlobalPrefix: true,
          subscriptions: {
            "graphql-ws": { path: "/subscriptions" },
          },
        });

        expect(
          typeof merged.subscriptions === "object"
            ? merged.subscriptions["graphql-ws"]
            : undefined,
        ).toMatchObject({
          path: "/api/subscriptions",
        });
      } finally {
        await close();
      }
    });

    it("leaves subscription path untouched when useGlobalPrefix is false", async () => {
      const { driver, close } = await createDriver("api");
      try {
        const merged = await driver.mergeDefaultOptions({
          useGlobalPrefix: false,
          subscriptions: {
            "graphql-ws": { path: "/graphql" },
          },
        });

        expect(
          typeof merged.subscriptions === "object"
            ? merged.subscriptions["graphql-ws"]
            : undefined,
        ).toMatchObject({
          path: "/graphql",
        });
      } finally {
        await close();
      }
    });

    it("does not touch boolean subscription protocol shorthand", async () => {
      const { driver, close } = await createDriver("api");
      try {
        const merged = await driver.mergeDefaultOptions({
          useGlobalPrefix: true,
          subscriptions: {
            "graphql-ws": true,
          },
        });

        expect(
          typeof merged.subscriptions === "object"
            ? merged.subscriptions["graphql-ws"]
            : undefined,
        ).toBe(true);
      } finally {
        await close();
      }
    });

    it("does not compound the prefix when the same options object is merged twice", async () => {
      const { driver, close } = await createDriver("api");
      try {
        const options: GqlModuleOptions = {
          useGlobalPrefix: true,
          subscriptions: {
            "graphql-ws": { path: "/graphql" },
          },
        };

        await driver.mergeDefaultOptions(options);
        const merged = await driver.mergeDefaultOptions(options);

        expect(
          typeof merged.subscriptions === "object"
            ? merged.subscriptions["graphql-ws"]
            : undefined,
        ).toMatchObject({
          path: "/api/graphql",
        });
      } finally {
        await close();
      }
    });

    it("leaves the caller subscriptions config untouched", async () => {
      const { driver, close } = await createDriver("api");
      try {
        const subscriptions = { "graphql-ws": { path: "/graphql" } };

        await driver.mergeDefaultOptions({
          useGlobalPrefix: true,
          subscriptions,
        });

        expect(subscriptions["graphql-ws"].path).toBe("/graphql");
      } finally {
        await close();
      }
    });
  },
);
