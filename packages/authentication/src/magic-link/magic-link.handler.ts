import type {
  MagicLink,
  MagicLinkAccount,
} from "../interfaces/magic-link.interface";

/**
 * Implemented by the app: magic link delivery and email-to-user mapping.
 */
export abstract class MagicLinkHandler {
  abstract send(link: MagicLink): void | Promise<void>;
  abstract resolveUser(
    email: string,
  ): MagicLinkAccount | null | Promise<MagicLinkAccount | null>;
}
