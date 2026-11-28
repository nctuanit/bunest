import { Module } from "@bunest/core";
import {
  AuthenticationModule,
  BetterAuthModule,
} from "@bunest/security/auth";
import { AuthorizationModule } from "@bunest/security/authz";
import { ServiceApiKeyProvider } from "./api-key.provider";
import { createDemoBetterAuth } from "./auth.instance";
import { ProjectPolicy } from "./project.policy";
import { ProjectsController } from "./projects.controller";

export function createModernAuthAppModule() {
  const auth = createDemoBetterAuth("/api/auth");

  @Module({
    imports: [
      AuthenticationModule.forRoot(),
      BetterAuthModule.forRoot({
        auth,
        basePath: "/api/auth",
        order: 0,
        registerAuthenticationModule: false,
      }),
      AuthorizationModule.forRoot(),
    ],
    controllers: [ProjectsController],
    providers: [ServiceApiKeyProvider, ProjectPolicy],
  })
  class ModernAuthAppModule {}

  return ModernAuthAppModule;
}

export const AppModule = createModernAuthAppModule();
