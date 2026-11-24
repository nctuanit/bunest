import { afterEach, beforeEach, expect, it } from "bun:test";
import { Injectable, Module } from "../../../../../packages/core/src/common";
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
} from "../../../../../packages/core/src";
import {
  Test,
  type TestingModule,
  describeConformance,
} from "../../../_helpers";

const NonAppliedDecorator = DiscoveryService.createDecorator();
const Webhook = DiscoveryService.createDecorator<{ name: string }>();
const WebhookHandler = DiscoveryService.createDecorator<{ event: string }>();

@Webhook({ name: "cleanup" })
class CleanupWebhook {
  @WebhookHandler({ event: "start" })
  onStart() {
    return "cleanup";
  }
}

@Webhook({ name: "flush" })
class FlushWebhook {
  @WebhookHandler({ event: "start" })
  onStart() {
    return "flush";
  }
}

@Module({ providers: [CleanupWebhook, FlushWebhook] })
class MyWebhookModule {}

@Injectable()
class WebhooksExplorer {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
  ) {}

  getWebhooks() {
    const webhooks = this.discoveryService.getProviders({
      metadataKey: Webhook.KEY,
    });
    return webhooks.map((wrapper) => {
      const { name } = this.discoveryService.getMetadataByDecorator(
        Webhook,
        wrapper,
      )!;
      return {
        name,
        handlers: this.metadataScanner
          .getAllMethodNames(wrapper.metatype!.prototype)
          .map((methodName) => {
            const { event } = this.discoveryService.getMetadataByDecorator(
              WebhookHandler,
              wrapper,
              methodName,
            )!;
            return {
              methodName,
              event,
            };
          }),
      };
    });
  }
}

@Module({
  imports: [MyWebhookModule, DiscoveryModule],
  providers: [WebhooksExplorer],
})
class AppModule {}

describeConformance(
  "DiscoveryModule",
  {
    upstreamPath: "integration/discovery/e2e/discover-by-meta.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let moduleRef: TestingModule;

    beforeEach(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
    });

    afterEach(async () => {
      await moduleRef.close();
    });

    it("should discover all providers & handlers with corresponding annotations", async () => {
      const webhooksExplorer = moduleRef.get(WebhooksExplorer);

      expect(webhooksExplorer.getWebhooks()).toEqual([
        {
          handlers: [
            {
              event: "start",
              methodName: "onStart",
            },
          ],
          name: "cleanup",
        },
        {
          handlers: [
            {
              event: "start",
              methodName: "onStart",
            },
          ],
          name: "flush",
        },
      ]);
    });

    it("should return an empty array if no providers were found for a given discoverable decorator", () => {
      const discoveryService = moduleRef.get(DiscoveryService);

      const providers = discoveryService.getProviders({
        metadataKey: NonAppliedDecorator.KEY,
      });
      expect(providers).toEqual([]);
    });

    it("should return an empty array if no controllers were found for a given discoverable decorator", () => {
      const discoveryService = moduleRef.get(DiscoveryService);

      const controllers = discoveryService.getControllers({
        metadataKey: NonAppliedDecorator.KEY,
      });
      expect(controllers).toEqual([]);
    });
  },
);
