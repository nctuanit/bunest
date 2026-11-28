import {
  deleteKeychainSecret,
  getKeychainSecret,
  setKeychainSecret,
  type BunSecretsBackend,
} from "@bunest/core/config";

export const CLI_SECRETS_SERVICE = "bunest-cli";

/**
 * Reads a stored CLI credential (e.g. deploy or registry token) from the OS
 * keychain via `Bun.secrets`.
 */
export function getCliSecret(
  name: string,
  service = CLI_SECRETS_SERVICE,
  backend?: BunSecretsBackend,
): Promise<string | null> {
  return getKeychainSecret(service, name, backend);
}

/**
 * Persists a CLI credential in the OS keychain via `Bun.secrets`.
 */
export function setCliSecret(
  name: string,
  value: string,
  service = CLI_SECRETS_SERVICE,
  backend?: BunSecretsBackend,
): Promise<void> {
  return setKeychainSecret(service, name, value, backend);
}

/**
 * Deletes a CLI credential from the OS keychain via `Bun.secrets`.
 */
export function deleteCliSecret(
  name: string,
  service = CLI_SECRETS_SERVICE,
  backend?: BunSecretsBackend,
): Promise<boolean> {
  return deleteKeychainSecret(service, name, backend);
}
