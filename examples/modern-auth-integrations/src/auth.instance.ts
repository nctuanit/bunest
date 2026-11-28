import type { BetterAuthLike } from "@bunest/security/auth";

export interface BetterAuthDemoUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: "owner" | "member";
}

export interface BetterAuthDemoSession {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: string;
}

export interface DemoBetterAuthEngine
  extends BetterAuthLike<BetterAuthDemoUser, BetterAuthDemoSession> {
  listActiveSessions(): BetterAuthDemoSession[];
}

/**
 * Self-contained Better Auth-compatible instance for zero-dependency workspace runs.
 * In your own project, replace this file with:
 *
 *   import { betterAuth } from "better-auth";
 *   export const auth = betterAuth({ database: ..., emailAndPassword: { enabled: true } });
 */
export function createDemoBetterAuth(basePath = "/api/auth"): DemoBetterAuthEngine {
  const users = new Map<string, BetterAuthDemoUser & { password: string }>([
    [
      "owner@bunest.dev",
      {
        id: "usr_owner",
        email: "owner@bunest.dev",
        name: "Owner",
        role: "owner",
        password: "password123",
      },
    ],
    [
      "member@bunest.dev",
      {
        id: "usr_member",
        email: "member@bunest.dev",
        name: "Member",
        role: "member",
        password: "password123",
      },
    ],
  ]);

  const sessions = new Map<
    string,
    { user: BetterAuthDemoUser; session: BetterAuthDemoSession }
  >();

  return {
    options: { basePath },
    listActiveSessions() {
      return [...sessions.values()].map((entry) => entry.session);
    },
    async handler(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (
        request.method === "POST" &&
        url.pathname === `${basePath}/sign-in/email`
      ) {
        const body = (await request.json()) as {
          email?: string;
          password?: string;
        };
        const found = body.email ? users.get(body.email) : undefined;
        if (!found || found.password !== body.password) {
          return Response.json(
            { message: "Invalid email or password" },
            { status: 401 },
          );
        }

        const token = crypto.randomUUID().replaceAll("-", "");
        const user: BetterAuthDemoUser = {
          id: found.id,
          email: found.email,
          name: found.name,
          role: found.role,
        };
        const session: BetterAuthDemoSession = {
          id: `sess_${sessions.size + 1}`,
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        };
        sessions.set(token, { user, session });

        return Response.json(
          { user, session },
          {
            status: 200,
            headers: {
              "set-cookie": `better-auth.session_token=${token}; Path=/; HttpOnly; SameSite=Lax`,
            },
          },
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === `${basePath}/get-session`
      ) {
        const current = await this.api.getSession({ headers: request.headers });
        return Response.json(current ?? null);
      }

      if (
        request.method === "POST" &&
        url.pathname === `${basePath}/sign-out`
      ) {
        const cookie = request.headers.get("cookie") ?? "";
        const match = /better-auth\.session_token=([^;\s]+)/.exec(cookie);
        if (match?.[1]) {
          sessions.delete(match[1]);
        }
        return Response.json(
          { success: true },
          {
            status: 200,
            headers: {
              "set-cookie":
                "better-auth.session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
            },
          },
        );
      }

      return Response.json({ error: "Auth endpoint not found" }, { status: 404 });
    },
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const cookie = headers.get("cookie") ?? "";
        const match = /better-auth\.session_token=([^;\s]+)/.exec(cookie);
        if (!match?.[1]) {
          return null;
        }
        return sessions.get(match[1]) ?? null;
      },
    },
  };
}
