import { Module } from "@bunest/core";
import { AuthenticationModule } from "@bunest/security/auth";
import { AuthorizationModule } from "@bunest/security/authz";
import { AuthController } from "./auth.controller";
import { AppApiKeyProvider, AppJwtBearerProvider } from "./auth.providers";
import { DocumentPolicy } from "./document.policy";
import { DocumentsController } from "./documents.controller";
import { IdentityStore } from "./users.store";

const ACCESS_TOKEN_KEY =
  Bun.env.JWT_SECRET ?? "bunest-demo-jwt-signing-secret-min-32-bytes!";
const MFA_ENCRYPTION_KEY =
  Bun.env.MFA_ENCRYPTION_KEY ?? "bunest-demo-mfa-aes-gcm-key-32bytes!";

@Module({
  imports: [
    AuthenticationModule.forRoot({
      allowInMemoryStorage: true,
      accessToken: {
        key: ACCESS_TOKEN_KEY,
        ttl: "15m",
      },
      refreshToken: {
        ttl: "7d",
      },
      mfa: {
        issuer: "BunestSecurityDemo",
        encryption: { keys: [MFA_ENCRYPTION_KEY] },
      },
    }),
    AuthorizationModule.forRoot(),
  ],
  controllers: [AuthController, DocumentsController],
  providers: [
    IdentityStore,
    DocumentPolicy,
    AppJwtBearerProvider,
    AppApiKeyProvider,
  ],
})
export class AppModule {}
