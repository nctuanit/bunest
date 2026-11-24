import { afterEach, expect, it } from "bun:test";
import {
  APP_FILTER,
  Catch,
  Controller,
  Inject,
  Injectable,
  REQUEST,
  Scope,
  type ExceptionFilter,
  type Provider,
} from "../../../../../packages/core/src/common";
import {
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  RpcException,
  TcpClientProxy,
  TcpServer,
  Transport,
} from "../../../../../packages/microservices/src";
import { Test, describeConformance } from "../../../_helpers";

const FILTERED = { status: "error", message: "filtered" };

const schemaOf = (tenant: string) => {
  if (tenant !== "known") {
    throw new RpcException(`no schema for tenant "${tenant}"`);
  }
  return `${tenant}_schema`;
};

@Injectable({ scope: Scope.REQUEST })
class TenantSchema {
  public readonly name: string;

  constructor(@Inject(REQUEST) ctx: { data: { tenant: string } }) {
    this.name = schemaOf(ctx.data.tenant);
  }
}

@Catch()
class OpaqueFilter implements ExceptionFilter {
  static caught = 0;

  catch() {
    OpaqueFilter.caught++;
    throw new RpcException(FILTERED);
  }
}

@Catch()
@Injectable({ scope: Scope.REQUEST })
class DependentFilter implements ExceptionFilter {
  constructor(private readonly schema: TenantSchema) {}

  catch() {
    throw new RpcException({ status: "error", message: this.schema.name });
  }
}

@Controller({ scope: Scope.REQUEST })
class ReportsController {
  constructor(private readonly schema: TenantSchema) {}

  @MessagePattern("reports.get")
  get() {
    return this.schema.name;
  }
}

@Controller()
class ExportsController {
  @MessagePattern("exports.get")
  get(data: { tenant: string }) {
    return schemaOf(data.tenant);
  }
}

describeConformance(
  "Scoped exception filters for a controller that fails to resolve (microservices)",
  {
    upstreamPath:
      "integration/scopes/e2e/msvc-scoped-filter-resolution-error.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-012"],
    notes:
      "Tests scoped global APP_FILTER resolution errors in TCP microservices with request-scoped providers and controllers.",
  },
  () => {
    let host: MicroserviceHost | undefined;
    let client: TcpClientProxy | undefined;

    afterEach(async () => {
      await client?.close();
      await host?.close();
      client = undefined;
      host = undefined;
    });

    async function start(filter: Provider) {
      OpaqueFilter.caught = 0;
      const moduleRef = await Test.createTestingModule({
        imports: [
          MicroserviceModule.forRoot({
            transport: Transport.TCP,
            options: { host: "127.0.0.1", port: 0 },
          }),
        ],
        controllers: [ReportsController, ExportsController],
        providers: [TenantSchema, filter],
      }).compile();
      const activeHost = moduleRef.get(MicroserviceHost);
      host = activeHost;
      await activeHost.listen();
      const server = activeHost.getServers()[0] as TcpServer;
      client = new TcpClientProxy({
        host: "127.0.0.1",
        port: server.port!,
      });
      await client.connect();
    }

    function call(pattern: string, tenant: string) {
      return client!.send(pattern, { tenant });
    }

    for (const [label, scope] of [
      ["DEFAULT", Scope.DEFAULT],
      ["REQUEST", Scope.REQUEST],
      ["TRANSIENT", Scope.TRANSIENT],
    ] as const) {
      it(`should apply a global filter of scope ${label} to the error of a failing provider`, async () => {
        await start({ provide: APP_FILTER, useClass: OpaqueFilter, scope });

        await expect(call("reports.get", "known")).resolves.toBe(
          "known_schema",
        );
        await expect(call("exports.get", "unknown")).rejects.toThrow(
          /filtered/,
        );
        await expect(call("reports.get", "unknown")).rejects.toThrow(
          /filtered/,
        );
        expect(OpaqueFilter.caught).toBe(2);
      });
    }

    it("should leave the error to the default filter when the filter fails to resolve too", async () => {
      await start({ provide: APP_FILTER, useClass: DependentFilter });

      await expect(call("reports.get", "known")).resolves.toBe("known_schema");
      await expect(call("reports.get", "unknown")).rejects.toThrow(
        'no schema for tenant "unknown"',
      );
    });
  },
);
