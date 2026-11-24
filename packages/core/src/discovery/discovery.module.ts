import { Global, Module } from "../common/index";

/**
 * Convenience global module exported for NestJS migration parity.
 * `DiscoveryService` and `MetadataScanner` are automatically available as
 * built-in singletons across every Bunest application.
 */
@Global()
@Module({})
export class DiscoveryModule {}
