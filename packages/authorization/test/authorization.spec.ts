import "reflect-metadata";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Scope,
  type ExecutionContext,
} from "@bunest/common";
import { Test } from "@bunest/testing";
import { MissingPolicyError } from "../src/errors/missing-policy.error";
import {
  AuthorizationError,
  AuthorizationEvents,
  AuthorizationModule,
  AuthorizationService,
  Can,
  Policy,
  type AuthorizationDeniedEvent,
  type PolicyBefore,
} from "../src/index";
import { defaultGetUser } from "../src/utils/get-user.util";

interface User {
  id: string;
  role: "admin" | "member" | "banned";
}

interface Doc {
  id: string;
  ownerId: string;
}

@Policy()
class DocumentPolicy implements PolicyBefore<User> {
  before(user: User | null): boolean | undefined {
    if (user?.role === "banned") return false;
    if (user?.role === "admin") return true;
    return undefined;
  }

  read(user: User | null, doc: Doc): boolean {
    return user !== null && doc.ownerId === user.id;
  }

  publicSummary(user: User | null): boolean {
    return user === null || user.role !== "banned";
  }
}

@Policy()
class UnregisteredPolicy {
  view(_user: User | null): boolean {
    return true;
  }
}

@Injectable({ scope: Scope.REQUEST })
@Policy()
class RequestScopedPolicy {
  view(_user: User | null): boolean {
    return true;
  }
}

describe("@bunest/authorization unit & startup checks", () => {
  it("evaluates PolicyBefore, abilities, AuthorizationService.can()/authorize(), and emits AuthorizationEvents + diagnostics_channel", async () => {
    const diag: unknown[] = [];
    const onDiag = (msg: unknown) => diag.push(msg);
    subscribe("nestjs:authorization:denied", onDiag);

    const modRef = await Test.createTestingModule({
      imports: [
        AuthorizationModule.forRoot({
          policies: [DocumentPolicy],
        }),
      ],
    }).compile();
    const app = modRef.createBunestApplication();
    await app.init();

    const authz = app.get(AuthorizationService);
    const events = app.get(AuthorizationEvents);
    const seen: AuthorizationDeniedEvent[] = [];
    const sub = events.events$.subscribe((e) => seen.push(e));
    const iter = events.events$[Symbol.asyncIterator]();
    const nextAsync = iter.next();

    try {
      const admin: User = { id: "a1", role: "admin" };
      const alice: User = { id: "u1", role: "member" };
      const bob: User = { id: "u2", role: "member" };
      const banned: User = { id: "u3", role: "banned" };
      const doc: Doc = { id: "d1", ownerId: "u1" };

      // Admin allowed via before()
      expect(await authz.can(DocumentPolicy, "read", admin, doc)).toBe(true);
      // Owner allowed via ability
      expect(await authz.can(DocumentPolicy, "read", alice, doc)).toBe(true);
      // Non-owner denied (can() never emits)
      expect(await authz.can(DocumentPolicy, "read", bob, doc)).toBe(false);
      // Banned denied by before() even on publicSummary
      expect(await authz.can(DocumentPolicy, "publicSummary", banned)).toBe(
        false,
      );
      // Guest allowed by publicSummary
      expect(await authz.can(DocumentPolicy, "publicSummary", null)).toBe(true);

      // authorize() throws AuthorizationError with exact status/reason AND emits events
      await expect(
        authz.authorize(DocumentPolicy, "read", null, doc),
      ).rejects.toMatchObject({
        name: "AuthorizationError",
        reason: "unauthenticated",
        status: 401,
        policy: "DocumentPolicy",
        ability: "read",
      });

      await expect(
        authz.authorize(DocumentPolicy, "read", bob, doc),
      ).rejects.toMatchObject({
        name: "AuthorizationError",
        reason: "forbidden",
        status: 403,
        policy: "DocumentPolicy",
        ability: "read",
      });

      // Missing policy throws MissingPolicyError
      await expect(
        authz.can(UnregisteredPolicy, "view", alice),
      ).rejects.toBeInstanceOf(MissingPolicyError);

      // Events received via .subscribe, for-await, and diagnostics_channel
      const asyncEvent = await nextAsync;
      expect(asyncEvent.done).toBe(false);
      expect(asyncEvent.value.policy).toBe("DocumentPolicy");
      expect(seen.length).toBe(2);
      expect(diag.length).toBeGreaterThanOrEqual(2);
    } finally {
      sub.unsubscribe();
      await iter.return?.();
      unsubscribe("nestjs:authorization:denied", onDiag);
      await app.close();
    }
  });

  it("rejects request-scoped policies and missing policy/ability on @Can() at startup", async () => {
    @Controller("broken-policy")
    class BrokenPolicyController {
      @Can(UnregisteredPolicy, "view")
      @Get()
      index() {
        return {};
      }
    }

    const modMissing = await Test.createTestingModule({
      imports: [AuthorizationModule.forRoot()],
      controllers: [BrokenPolicyController],
    }).compile();
    const appMissing = modMissing.createBunestApplication();
    await expect(appMissing.init()).rejects.toThrow(
      "UnregisteredPolicy is not registered",
    );

    const modScoped = await Test.createTestingModule({
      imports: [AuthorizationModule.forRoot()],
      providers: [RequestScopedPolicy],
    }).compile();
    const appScoped = modScoped.createBunestApplication();
    await expect(appScoped.init()).rejects.toThrow("is request-scoped");
  });

  it("defaultGetUser extracts user across http, ws, rpc, graphql, mcp, and ai contexts", () => {
    const mkCtx = (type: string, args: unknown[]): ExecutionContext =>
      ({
        getType: () => type,
        getArgs: () => args,
        getArgByIndex: (i: number) => args[i],
        getClass: () => Object,
        getHandler: () => () => {},
        switchToHttp: () => ({
          getRequest: () => args[0],
          getResponse: () => args[1],
          getNext: () => args[2],
        }),
        switchToWs: () => ({
          getClient: () => args[0],
          getData: () => args[1],
          getPattern: () => "",
        }),
        switchToRpc: () => ({
          getData: () => args[0],
          getContext: () => args[1],
        }),
      }) as unknown as ExecutionContext;

    expect(defaultGetUser(mkCtx("http", [{ user: { id: "h1" } }]))).toEqual({
      id: "h1",
    });
    expect(defaultGetUser(mkCtx("http", [{}]))).toBeUndefined();
    expect(defaultGetUser(mkCtx("ws", [{ user: { id: "w1" } }]))).toEqual({
      id: "w1",
    });
    expect(defaultGetUser(mkCtx("rpc", [{}, { user: { id: "r1" } }]))).toEqual({
      id: "r1",
    });
    expect(
      defaultGetUser(
        mkCtx("graphql", [{}, {}, { req: { user: { id: "g1" } } }, {}]),
      ),
    ).toEqual({ id: "g1" });
    expect(defaultGetUser(mkCtx("mcp", [{}, { user: { id: "m1" } }]))).toEqual({
      id: "m1",
    });
    expect(
      defaultGetUser(mkCtx("ai", [{}, { request: { user: { id: "a1" } } }])),
    ).toEqual({ id: "a1" });
  });

  it("AuthorizationError sets status 401 for unauthenticated and 403 for forbidden", () => {
    const unauth = new AuthorizationError("unauthenticated", "P", "read");
    expect(unauth.status).toBe(401);
    const forbid = new AuthorizationError("forbidden", "P", "read");
    expect(forbid.status).toBe(403);
  });
});
