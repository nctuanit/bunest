import { Controller, Delete, Get, Param, Post } from "@bunest/core";
import {
  CurrentSession,
  CurrentUser,
  InjectBetterAuth,
  Public,
} from "@bunest/security/auth";
import { Can } from "@bunest/security/authz";
import { ServiceApiKeyProvider } from "./api-key.provider";
import type {
  BetterAuthDemoSession,
  BetterAuthDemoUser,
  DemoBetterAuthEngine,
} from "./auth.instance";
import { ProjectPolicy } from "./project.policy";

@Controller("projects")
export class ProjectsController {
  constructor(
    @InjectBetterAuth()
    private readonly auth: DemoBetterAuthEngine,
    private readonly apiKeys: ServiceApiKeyProvider,
  ) {}

  @Public()
  @Get("public-status")
  publicStatus() {
    return { status: "ok", auth: "better-auth + api-keys" };
  }

  @Can(ProjectPolicy, "read")
  @Get("me")
  me(
    @CurrentUser() user: BetterAuthDemoUser,
    @CurrentSession() session: BetterAuthDemoSession | { method: string },
  ) {
    return {
      user,
      session,
      totalBetterAuthSessions: this.auth.listActiveSessions().length,
    };
  }

  @Can(ProjectPolicy, "read")
  @Post("api-keys")
  createServiceKey(@CurrentUser() user: BetterAuthDemoUser) {
    return this.apiKeys.issueForUser(user);
  }

  @Can(ProjectPolicy, "delete")
  @Delete(":id")
  remove(@Param("id") id: string, @CurrentUser() user: BetterAuthDemoUser) {
    return { deleted: id, by: user.email };
  }
}
