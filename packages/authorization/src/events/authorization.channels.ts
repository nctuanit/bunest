import { channel, type Channel } from "node:diagnostics_channel";

/** Every denial, for tooling that runs outside Bunest/Nest. */
export const deniedChannel: Channel = channel("nestjs:authorization:denied");
