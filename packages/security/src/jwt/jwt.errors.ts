import { UnauthorizedException } from "@bunest/core";

export class JwtException extends UnauthorizedException {
  public readonly inner?: Error;

  constructor(message = "Invalid JWT", error?: Error) {
    super(message);
    this.name = new.target.name;
    this.inner = error;
  }
}

export class JwtExpiredException extends JwtException {
  public readonly expiredAt: Date;

  constructor(expiredAt: Date, message?: string);
  constructor(message: string, expiredAt: Date);
  constructor(
    expiredAtOrMessage: Date | string,
    messageOrExpiredAt?: string | Date,
  ) {
    if (expiredAtOrMessage instanceof Date) {
      super(
        typeof messageOrExpiredAt === "string"
          ? messageOrExpiredAt
          : "JWT expired",
      );
      this.expiredAt = expiredAtOrMessage;
    } else {
      super(expiredAtOrMessage || "JWT expired");
      this.expiredAt =
        messageOrExpiredAt instanceof Date ? messageOrExpiredAt : new Date();
    }
  }
}

export class JwtNotBeforeException extends JwtException {
  public readonly notBefore: Date;
  public readonly date: Date;

  constructor(notBefore: Date, message?: string);
  constructor(message: string, date: Date);
  constructor(
    notBeforeOrMessage: Date | string,
    messageOrDate?: string | Date,
  ) {
    if (notBeforeOrMessage instanceof Date) {
      super(
        typeof messageOrDate === "string"
          ? messageOrDate
          : "JWT not active yet",
      );
      this.notBefore = notBeforeOrMessage;
      this.date = notBeforeOrMessage;
    } else {
      super(notBeforeOrMessage || "JWT not active yet");
      const resolvedDate =
        messageOrDate instanceof Date ? messageOrDate : new Date();
      this.notBefore = resolvedDate;
      this.date = resolvedDate;
    }
  }
}

export class JwtInvalidException extends JwtException {
  constructor(message = "Invalid JWT", error?: Error) {
    super(message, error);
  }
}

export class WrongSecretProviderError extends Error {
  constructor(message = "Wrong secret provider", options?: ErrorOptions) {
    super(message, options);
    this.name = "WrongSecretProviderError";
  }
}

// NestJS / jsonwebtoken-compatible error aliases sharing prototype identity with Bunest JWT exceptions
export {
  JwtException as JsonWebTokenError,
  JwtExpiredException as TokenExpiredError,
  JwtNotBeforeException as NotBeforeError,
};
