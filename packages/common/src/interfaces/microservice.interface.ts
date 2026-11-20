/**
 * Minimal lifecycle contract implemented by transport servers attached to a
 * hybrid Bunest HTTP application via `app.connectMicroservice(server)`.
 */
export interface MicroserviceInstance {
  listen(): Promise<void> | void;
  close(): Promise<void> | void;
}
