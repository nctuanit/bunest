/**
 * The `amr` values (RFC 8176) that mean a second factor was presented:
 * `mfa`, `otp`, and `hwk`.
 */
export const MFA_AMR_VALUES: readonly string[] = ["mfa", "otp", "hwk"];

/** Whether an `amr` claim says a second factor was presented. */
export function hasMfaAmr(amr: unknown): boolean {
  return (
    Array.isArray(amr) &&
    amr.some(
      (method) => typeof method === "string" && MFA_AMR_VALUES.includes(method),
    )
  );
}
