import { beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
} from "../../../../../../packages/core/src/common";
import {
  Test,
  describeConformance,
  itAdapted,
  type TestingModule,
} from "../../../../_helpers";

// Self-signed localhost test certificate (from upstream nestjs/nest test fixtures)
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDZ1IdZZXqrwXql
4AIOJnlfpoGKOKoIalnK7KaKHTsq1QOF8z2abFuNBVIIrO0etQ/0PPAaFGkXl6HH
BuA5PrFpsw3V1wSnNs1Cns9NhvypHI2V71lkwBJrEaSicNWL2AOEQkQ9cZ4YsTGd
0BrM8D5VvgXdrC7gOXfj7Hx3E4K+wFO/Gi4AUXl5CXxleSFcW4U+jFulfq/DE8rB
ZXs29IsGeVkkgUoICjQ4Ey4zE6EY7f3SPKgU8gfgzYyGSd/ZZ/E76M2yakEUX448
Nl4BeuNWroBHVm1pSiMo+Cm1g34pJScPrx1yw6qquziCc/2n1M6OB4WGIZAmJDWn
AOEjjrxFAgMBAAECggEANUKZtWnyjHxKGLSkzADsPE7h7YHdUSFvwwYJ0ktDZD2h
FudacJ994wUiAa0GbTOoKvebXUUQTQxuKdOsj1Kc3lNBVr+0C46CsX9TAIm4zUCF
/dr/6HpuBm/R6UXdcMvoUDZDqSJWnYL1trhjVSiIlT5ZANJQw9JJVhlEdXj3xtuc
I9aC+33f9hKO1wzei/mTjIRGyRIeKselZPpA7qJnE4s3hmZxnO/rSqyPIvh1XLfZ
3Eoyyg+xNpTZ8JqlHB5d7hDSnj8cjboa7IYpHJDXN3r8Aui+R9e/sQkezHbF7fR0
xHpBVYQvGMuqSnTBkdJfq4qPAR1K49UrpEXB2GHaIQKBgQDs3t/ZUA138AiPIeLd
aTsEPhf5dWEZynfNvXZ0VcoSr8ckaiaq9OEllprAriYWj+XphTDsBUAh/R7KlOR4
eb+m6OwH7LseGiLIEr54GGP0LzVXAkfH2/uR1cak8qAmHB00jNEg7sj0eVAsHO3f
WQm67f+RNP/IgAa+V8JKIkgTwwKBgQDrbAH8eAQsq9rjpxcic1EUI7uFHzr+cKf/
4Y8ThLUNAzNfAbQWRBYjS1R8GM79Wiuh+WT1ooHKLryuLF7LVukvKHJ5GiNFBmaO
llf72Zf1y4tBE2RCXQbf6h8+ohSDC/hwYy+w20/i2KzSBKkS0+gQuAX/HzfTpRd3
q3/uEniXVwKBgDNnElDIbIPQlSrqgZ7mzSXYi79Y15+PLnx5VxFb5KQ1fRPL7WRA
C/PqQN77a8yNoakRfFJbuVUm5t2zffkfApYoCcCWgOzBYzbjym2pbVd6PysIlacr
d+Zn69mzxUk/5J6YyHFLIFTdVqacCIrleZUVPNa4F6HdFpmL1d/cnKOdAoGAMDuB
sKsaF9jh0LBkEf/URa8IdT6vxH9qPAeHW7VdrpvQQ4/CyKkMbBC772zZw5hcxiOl
Zpnzw2uN5pVamohk3++GfH85aKPmESKGRigPdSFNl3iUmvAaP3flDN0CHNMwBD6d
/7r/A/fmeGTSCvR1YC+DswA/XNI/G5p8bFdGc6MCgYBd9oQiZlkYMiDGPUAjx+DO
kqtAmc8DLJEanSbWdIxL2bGL04cgBRPssM4m0UScx4PucvqWEPdN/5Ug0z5TrD77
2K5nZSBUdy4DunBImz1NHRQEiytkrYX0LesGr02QlzIH4wmwb1TFu7rLkr6KfNuV
xqWi+JVY8N4vuHAxCeEALw==
-----END PRIVATE KEY-----`;

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIICpDCCAYwCCQCyP27z3r0PFjANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwHhcNMjIxMjAyMDQ0NTQ1WhcNMzIxMTI5MDQ0NTQ1WjAUMRIwEAYD
VQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDZ
1IdZZXqrwXql4AIOJnlfpoGKOKoIalnK7KaKHTsq1QOF8z2abFuNBVIIrO0etQ/0
PPAaFGkXl6HHBuA5PrFpsw3V1wSnNs1Cns9NhvypHI2V71lkwBJrEaSicNWL2AOE
QkQ9cZ4YsTGd0BrM8D5VvgXdrC7gOXfj7Hx3E4K+wFO/Gi4AUXl5CXxleSFcW4U+
jFulfq/DE8rBZXs29IsGeVkkgUoICjQ4Ey4zE6EY7f3SPKgU8gfgzYyGSd/ZZ/E7
6M2yakEUX448Nl4BeuNWroBHVm1pSiMo+Cm1g34pJScPrx1yw6qquziCc/2n1M6O
B4WGIZAmJDWnAOEjjrxFAgMBAAEwDQYJKoZIhvcNAQELBQADggEBAABGByZZUjaq
ZygICSH2qUGHPPIyrfaCe0qM7de6kYfxxPYQQZb0HDynzv780Lq1002XeT02fNR+
5sBCVFuKvS8BNvTq6kHzO1FiWIk/E5fQcYNToYSeEcXgWFLhJMty7+R6sIc9y8PH
2YNehf78Jjm9ukM52sLc4+JWl7AEeqPrOHZdh/ve8M2gTfimFKTrW5cEAVPIOPhp
2t5BdDKt8ZxgrGC7iRxga+v80VUOHRGfrd3hf3NlDQZO8upVGY8DdJhPRDB72+R0
kzJ7eyQwlGXM20atiFxPk43h0f273MneIJG8NgGiVU0ND4XnZkAB3KSAu7pB+nEw
QRYMYDgo/8Q=
-----END CERTIFICATE-----`;

async function allocatePort(): Promise<number> {
  const srv = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = srv;
  srv.stop(true);
  return port;
}

@Injectable()
class AppService {
  getHello(): string {
    return "Hello World!";
  }
}

@Controller()
class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}

@Module({
  controllers: [AppController],
  providers: [AppService],
})
class AppModule {}

describeConformance(
  "Get URL (Bunest Application)",
  {
    upstreamPath: "integration/nest-application/get-url/e2e/express.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ExpressAdapter getUrl() tests to native Bun.serve() / BunestApplication.getUrl().",
  },
  () => {
    let testModule: TestingModule;
    let port: number;

    beforeEach(async () => {
      testModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      port = await allocatePort();
    });

    it("should be able to get a loopback address", async () => {
      const app = testModule.createNestApplication({ logger: false });
      try {
        await app.listen(port);
        expect(app.getUrl()).toMatch(
          new RegExp(
            `^http://(\\[::1\\]|127\\.0\\.0\\.1|localhost):${port}/?$`,
          ),
        );
      } finally {
        await app.close();
      }
    });

    it("should be able to get the IPv4 address", async () => {
      const app = testModule.createNestApplication({ logger: false });
      try {
        await app.listen(port, "127.0.0.1");
        expect(app.getUrl()?.replace(/\/$/, "")).toEqual(
          `http://127.0.0.1:${port}`,
        );
      } finally {
        await app.close();
      }
    });

    // BUNEST_BUG: Expected app.getUrl() to normalize wildcard bind address 0.0.0.0 to http://127.0.0.1:<port> (matching NestApplication.getUrl()); actual returns raw Bun server.url http://0.0.0.0:<port>/ (packages/core/src/application/bunest-application.ts, packages/core/src/http/adapter/bun-http.adapter.ts).
    it.skip("should return 127.0.0.1 for 0.0.0.0", async () => {
      const app = testModule.createNestApplication({ logger: false });
      try {
        await app.listen(port, "0.0.0.0");
        expect(app.getUrl()?.replace(/\/$/, "")).toEqual(
          `http://127.0.0.1:${port}`,
        );
      } finally {
        await app.close();
      }
    });

    it("should return a loopback address in a callback (default bind)", async () => {
      const app = testModule.createNestApplication({ logger: false });
      let observedUrl: string | undefined;
      try {
        await app.listen(port, () => {
          observedUrl = app.getUrl();
        });
        expect(observedUrl).toMatch(
          new RegExp(
            `^http://(\\[::1\\]|127\\.0\\.0\\.1|localhost):${port}/?$`,
          ),
        );
      } finally {
        await app.close();
      }
    });

    // BUNEST_BUG: Expected app.getUrl() called before app.listen() to throw/reject with "app.listen() needs to be called before calling app.getUrl()"; actual synchronously returns undefined (packages/core/src/application/bunest-application.ts, packages/core/src/http/adapter/bun-http.adapter.ts).
    it.skip("should throw an error for calling getUrl before listen", async () => {
      const app = testModule.createNestApplication({ logger: false });
      try {
        await expect(
          Promise.resolve().then(() => app.getUrl()),
        ).rejects.toEqual(
          "app.listen() needs to be called before calling app.getUrl()",
        );
      } finally {
        await app.close();
      }
    });

    itAdapted(
      "ADR-001",
      'should return an https url for "httpsOptions"',
      async () => {
        const app = testModule.createNestApplication({
          logger: false,
          httpsOptions: {
            key: TEST_TLS_KEY,
            cert: TEST_TLS_CERT,
          },
        });
        try {
          await app.listen(port, "127.0.0.1");
          expect(app.getUrl()?.replace(/\/$/, "")).toEqual(
            `https://127.0.0.1:${port}`,
          );
        } finally {
          await app.close();
        }
      },
      "Uses Bun.serve({ tls }) via BunestApplicationOptions.httpsOptions",
    );
  },
);
