import { AiConfigurationError } from '../errors/ai.errors';

/** Throws for an agent function name model providers refuse. */
export function assertProviderToolName(name: string, where: string): void {
  if (!name || name.length > 64) {
    throw new AiConfigurationError(
      `${where}: agent function name ${JSON.stringify(name)} must be 1-64 characters.`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new AiConfigurationError(
      `${where}: agent function name ${JSON.stringify(name)} must match /^[A-Za-z0-9_-]+$/.`,
    );
  }
}
