import type { Type } from "@bunest/common";
import type { SentMail } from "../transports/sent-mail";

/**
 * Which mails to match: every given field must match. `to` matches any recipient (to,
 * cc or bcc), ignoring case. A function gets each `SentMail`.
 */
export type SentMailQuery =
  | {
      to?: string;
      subject?: string | RegExp;
      /** The mail class that rendered it. */
      mail?: Type;
      /** The template its HTML was rendered from. */
      template?: string;
    }
  | ((mail: SentMail) => boolean);
