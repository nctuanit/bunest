declare const LOCAL_TRANSPORT_KEY: unique symbol;

/**
 * Marks a transport that doesn't deliver mail (in memory, file, log): the module warns
 * at startup when one is used with `NODE_ENV=production`.
 */
export const LOCAL_TRANSPORT: typeof LOCAL_TRANSPORT_KEY = Symbol.for(
  "@nestjs/mail:local-transport",
) as typeof LOCAL_TRANSPORT_KEY;
