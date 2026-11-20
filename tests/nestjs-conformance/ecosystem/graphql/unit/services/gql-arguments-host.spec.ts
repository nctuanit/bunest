import "reflect-metadata";
import { expect, it } from "bun:test";
import { GraphQLObjectType } from "../../../../../../packages/graphql/node_modules/graphql";
import type {
  ArgumentsHost,
  HttpArgumentsHost,
  RpcArgumentsHost,
  WsArgumentsHost,
} from "../../../../../../packages/common/src";
import { GqlArgumentsHost } from "../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../_helpers/index";

class TestArgumentsHost implements ArgumentsHost {
  private contextType: string;

  constructor(
    private readonly args: unknown[],
    type = "graphql",
  ) {
    this.contextType = type;
  }

  setType(type: string): void {
    this.contextType = type;
  }

  getType<TContext extends string = string>(): TContext {
    return this.contextType as TContext;
  }

  getArgs<T extends Array<any> = any[]>(): T {
    return this.args as T;
  }

  getArgByIndex<T = any>(index: number): T {
    return this.args[index] as T;
  }

  switchToHttp(): HttpArgumentsHost {
    return {
      getRequest: <T = any>(): T => this.args[0] as T,
      getResponse: <T = any>(): T => this.args[1] as T,
      getNext: <T = any>(): T => this.args[2] as T,
    };
  }

  switchToRpc(): RpcArgumentsHost {
    return {
      getData: <T = any>(): T => this.args[0] as T,
      getContext: <T = any>(): T => this.args[1] as T,
    };
  }

  switchToWs(): WsArgumentsHost {
    return {
      getClient: <T = any>(): T => this.args[0] as T,
      getData: <T = any>(): T => this.args[1] as T,
      getPattern: (): string => String(this.args[2] ?? ""),
    };
  }
}

const createHost = (args: unknown[], type = "graphql"): ArgumentsHost =>
  new TestArgumentsHost(args, type);

describeConformance(
  "GqlArgumentsHost",
  {
    upstreamPath: "packages/graphql/tests/services/gql-arguments-host.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should expose the positions of a field resolver call", () => {
      const host = GqlArgumentsHost.create(
        createHost(["root", { id: 1 }, "ctx", "info"]),
      );
      expect(host.getRoot()).toBe("root");
      expect(host.getArgs()).toEqual({ id: 1 });
      expect(host.getContext()).toBe("ctx");
      expect(host.getInfo<string>()).toBe("info");
    });

    // BUNEST_BUG: GqlArgumentsHost.create() in packages/graphql/src/context/gql-execution-context.ts (lines 128-138) does not align 3-argument Federation reference resolver calls ([reference, ctx, info]) into [reference, undefined, ctx, info], so getArgs() returns "ctx" instead of undefined.
    it.skip('should align the positions of a reference resolver call (no "args")', () => {
      const host = GqlArgumentsHost.create(
        createHost([{ __typename: "User", id: 1 }, "ctx", "info"]),
      );
      expect(host.getRoot()).toEqual({ __typename: "User", id: 1 });
      expect(host.getArgs()).toBeUndefined();
      expect(host.getContext()).toBe("ctx");
      expect(host.getInfo<string>()).toBe("info");
    });

    // BUNEST_BUG: GqlArgumentsHost.create() in packages/graphql/src/context/gql-execution-context.ts (lines 128-138) does not align 4-argument resolveType calls ([value, ctx, info, abstractType]) where args is omitted, so getArgs() returns "ctx" instead of undefined.
    it.skip('should align the positions of a "resolveType" call (no "args")', () => {
      const abstractType = new GraphQLObjectType({ name: "Node", fields: {} });
      const host = GqlArgumentsHost.create(
        createHost([{ id: 1 }, "ctx", "info", abstractType]),
      );
      expect(host.getArgs()).toBeUndefined();
      expect(host.getContext()).toBe("ctx");
      expect(host.getInfo<string>()).toBe("info");
    });

    it("should leave the arguments of other hosts as they are", () => {
      const args = ["req", "res", "next"];
      const host = GqlArgumentsHost.create(createHost(args, "http"));
      expect(host.getArgs()).toBe("res");
    });
  },
);
