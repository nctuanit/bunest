import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Injectable } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  JWT_MODULE_OPTIONS,
  JsonWebTokenError,
  JwtException,
  JwtExpiredException,
  JwtInvalidException,
  JwtModule,
  JwtNotBeforeException,
  JwtSecretRequestType,
  JwtService,
  NotBeforeError,
  TokenExpiredError,
  WrongSecretProviderError,
  type GetSecretKeyResult,
  type JwtModuleAsyncOptions,
  type JwtModuleOptions,
  type JwtOptionsFactory,
  type JwtSignOptions,
  type JwtVerifyOptions,
} from "../src";

describe("@bunest/jwt drop-in facade (@nestjs/jwt v12 parity)", () => {
  it("exports all 7 @nestjs/jwt@12.0.5 runtime values and Bunest JWT tokens/errors", () => {
    expect(JwtModule).toBeDefined();
    expect(JwtService).toBeDefined();
    expect(JwtSecretRequestType.SIGN).toBe(0);
    expect(JwtSecretRequestType.VERIFY).toBe(1);
    expect(JsonWebTokenError).toBe(JwtException);
    expect(TokenExpiredError).toBe(JwtExpiredException);
    expect(NotBeforeError).toBe(JwtNotBeforeException);
    expect(JwtInvalidException).toBeDefined();
    expect(WrongSecretProviderError).toBeDefined();
    expect(typeof JWT_MODULE_OPTIONS).toBe("symbol");
  });

  it("registers JwtModule via register() and registerAsync() and signs/verifies tokens", async () => {
    const signOptions: JwtSignOptions = { expiresIn: "10m", issuer: "bunest-jwt" };
    const verifyOptions: JwtVerifyOptions = { issuer: "bunest-jwt" };

    const mod = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: "facade-super-secret-key",
          signOptions,
          verifyOptions,
        }),
      ],
    }).compile();

    try {
      const jwt = mod.get(JwtService);
      const token = await jwt.signAsync({ sub: "user-1", role: "admin" });
      const payload = await jwt.verifyAsync<{ sub: string; role: string; iss: string }>(token);
      expect(payload.sub).toBe("user-1");
      expect(payload.role).toBe("admin");
      expect(payload.iss).toBe("bunest-jwt");

      const decoded = jwt.decode<{ sub: string }>(token);
      expect(decoded?.sub).toBe("user-1");
    } finally {
      await mod.close();
    }

    @Injectable()
    class ConfigFactory implements JwtOptionsFactory {
      createJwtOptions(): JwtModuleOptions {
        return {
          secretOrKeyProvider: (requestType: JwtSecretRequestType): GetSecretKeyResult =>
            requestType === JwtSecretRequestType.SIGN || requestType === JwtSecretRequestType.VERIFY
              ? "dynamic-provider-secret"
              : "",
        };
      }
    }

    const asyncOpts: JwtModuleAsyncOptions = { useClass: ConfigFactory };
    const asyncMod = await Test.createTestingModule({
      imports: [JwtModule.registerAsync(asyncOpts)],
    }).compile();

    try {
      const jwt = asyncMod.get(JwtService);
      const token = await jwt.signAsync({ sub: "async-user" });
      const verified = await jwt.verifyAsync<{ sub: string }>(token);
      expect(verified.sub).toBe("async-user");

      const expired = await jwt.signAsync({
        sub: "old",
        exp: Math.floor(Date.now() / 1000) - 60,
      });
      await expect(jwt.verifyAsync(expired)).rejects.toThrow(TokenExpiredError);
    } finally {
      await asyncMod.close();
    }
  });
});
