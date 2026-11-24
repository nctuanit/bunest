import { channel, type DiagnosticChannel } from "@bunest/core";

/** Every denial, for tooling that runs outside Bunest/Nest. */
export const deniedChannel: DiagnosticChannel = channel(
  "nestjs:authorization:denied",
);
