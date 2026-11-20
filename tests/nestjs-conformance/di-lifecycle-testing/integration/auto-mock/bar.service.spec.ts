import "reflect-metadata";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Injectable } from "../../../../../packages/common/src";
import { Test, describeConformance } from "../../../_helpers";

@Injectable()
class FooService {
  foo() {
    // real implementation
  }
}

@Injectable()
class BarService {
  constructor(private readonly foo: FooService) {}

  bar() {
    this.foo.foo();
  }
}

describeConformance(
  "Auto-Mocking",
  {
    upstreamPath: "integration/auto-mock/test/bar.service.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    describe("Auto-Mocking Bar Deps", () => {
      let service: BarService;
      let fooService: FooService;
      const stub = mock(() => {});

      beforeEach(async () => {
        stub.mockClear();
        const moduleRef = await Test.createTestingModule({
          providers: [BarService],
        })
          .useMocker(() => ({ foo: stub }))
          .compile();
        service = moduleRef.get(BarService);
        fooService = moduleRef.get(FooService);
      });

      it("should be defined", () => {
        expect(service).not.toBeUndefined();
        expect(fooService).not.toBeUndefined();
      });

      it("should call bar.bar", () => {
        service.bar();
        expect(stub).toHaveBeenCalled();
      });
    });

    describe("Auto-Mocking with token in factory", () => {
      it("can mock the dependencies", async () => {
        const moduleRef = await Test.createTestingModule({
          providers: [BarService],
        })
          .useMocker((token) => {
            if (token === FooService) {
              return { foo: mock(() => {}) };
            }
            return undefined;
          })
          .compile();
        const service = moduleRef.get(BarService);
        const fooServ = moduleRef.get<{ foo: ReturnType<typeof mock> }>(
          FooService as never,
        );
        service.bar();
        expect(fooServ.foo).toHaveBeenCalled();
        await moduleRef.close();
      });

      it("cannot mock the dependencies when factory returns undefined", async () => {
        const builder = Test.createTestingModule({
          providers: [BarService],
        }).useMocker((token) => {
          if (token === FooService.name + "something that fails the token") {
            return { foo: mock(() => {}) };
          }
          return undefined;
        });
        await expect(builder.compile()).rejects.toThrow();
      });
    });
  },
);
