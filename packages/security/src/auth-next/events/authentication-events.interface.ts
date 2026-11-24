import type { MfaState } from "../interfaces/authentication-result.interface";

export interface AuthenticationSignInEvent {
  type: "sign-in";
  userId: string;
  sessionId?: string;
  tokenFamilyId?: string;
  method?: string;
  mfa?: MfaState;
  metadata?: Record<string, unknown>;
}

export interface AuthenticationMfaVerifiedEvent {
  type: "mfa-verified";
  userId: string;
  method: "totp" | "recovery-code";
}

export interface AuthenticationMfaFailedEvent {
  type: "mfa-failed";
  userId: string;
  method: "totp" | "recovery-code";
  failures: number;
  locked: boolean;
}

export interface AuthenticationMfaEnabledEvent {
  type: "mfa-enabled";
  userId: string;
  replaced: boolean;
}

export interface AuthenticationMfaDisabledEvent {
  type: "mfa-disabled";
  userId: string;
}

export interface AuthenticationRecoveryCodesGeneratedEvent {
  type: "recovery-codes-generated";
  userId: string;
  count: number;
}

export interface AuthenticationRefreshTokenReusedEvent {
  type: "refresh-token-reused";
  userId: string;
  tokenFamilyId: string;
}

export interface AuthenticationSignOutEvent {
  type: "sign-out";
  userId: string;
  sessionId?: string;
  tokenFamilyId?: string;
  everywhere?: true;
}

export interface AuthenticationPasswordResetRequestedEvent {
  type: "password-reset-requested";
  email: string;
  userId?: string;
}

export interface AuthenticationPasswordResetEvent {
  type: "password-reset";
  userId: string;
}

export interface AuthenticationEmailVerifiedEvent {
  type: "email-verified";
  userId: string;
  email: string;
}

export interface AuthenticationMagicLinkRefusedEvent {
  type: "magic-link-refused";
  reason: "not-this-browser" | "unknown" | "expired" | "refused";
  email?: string;
}

export interface AuthenticationSessionTouchFailedEvent {
  type: "session-touch-failed";
  userId: string;
  sessionId: string;
  error: unknown;
}

export type AuthenticationEvent =
  | AuthenticationSignInEvent
  | AuthenticationSignOutEvent
  | AuthenticationMfaVerifiedEvent
  | AuthenticationMfaFailedEvent
  | AuthenticationMfaEnabledEvent
  | AuthenticationMfaDisabledEvent
  | AuthenticationRecoveryCodesGeneratedEvent
  | AuthenticationRefreshTokenReusedEvent
  | AuthenticationPasswordResetRequestedEvent
  | AuthenticationPasswordResetEvent
  | AuthenticationEmailVerifiedEvent
  | AuthenticationMagicLinkRefusedEvent
  | AuthenticationSessionTouchFailedEvent;
