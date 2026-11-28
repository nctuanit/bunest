import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UnauthorizedException,
} from "@bunest/core";
import {
  AuthenticationError,
  CurrentSession,
  CurrentUser,
  MfaService,
  PasswordHasher,
  Public,
  RefreshTokenError,
  TokenService,
} from "@bunest/security/auth";
import { Can } from "@bunest/security/authz";
import { AppApiKeyProvider } from "./auth.providers";
import { IdentityStore, type AppUser } from "./users.store";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly store: IdentityStore,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly mfa: MfaService,
    private readonly apiKeys: AppApiKeyProvider,
  ) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: { email: string; password: string; totpCode?: string },
  ) {
    const user = this.store.findUserByEmail(body.email);
    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const valid = await this.hasher.verify(body.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    try {
      const issued = await this.tokens.issue(user.id, {
        claims: { email: user.email, role: user.role },
        method: "password",
        secondFactor: body.totpCode ? { code: body.totpCode } : undefined,
      });
      return {
        user: { id: user.id, email: user.email, role: user.role },
        ...issued,
      };
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw new UnauthorizedException(error.message);
      }
      throw error;
    }
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Body() body: { refreshToken: string }) {
    try {
      return await this.tokens.refresh(body.refreshToken);
    } catch (error) {
      if (error instanceof RefreshTokenError) {
        throw new UnauthorizedException(
          `Refresh token rejected: ${error.reason}`,
        );
      }
      throw error;
    }
  }

  @Can.Anyone()
  @Get("me")
  me(
    @CurrentUser() user: AppUser,
    @CurrentSession() session: Record<string, unknown>,
  ) {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      authMethod: session.method ?? "jwt",
      amr: session.amr ?? [],
    };
  }

  @Can.Anyone()
  @Post("mfa/enroll")
  async enrollMfa(@CurrentUser() user: AppUser) {
    return this.mfa.enroll(user.id, user.email);
  }

  @Can.Anyone()
  @Post("mfa/confirm")
  @HttpCode(200)
  async confirmMfa(
    @CurrentUser() user: AppUser,
    @Body() body: { code: string },
  ) {
    const confirmed = await this.mfa.confirm(user.id, body.code);
    if (!confirmed) {
      throw new BadRequestException("Invalid confirmation TOTP code");
    }
    return { mfaEnabled: true };
  }

  @Can.Anyone()
  @Post("api-keys")
  createApiKey(@CurrentUser() user: AppUser) {
    const generated = this.apiKeys.generate();
    this.store.saveApiKey({
      id: generated.id,
      hash: generated.hash,
      userId: user.id,
    });
    return { id: generated.id, key: generated.key };
  }
}
