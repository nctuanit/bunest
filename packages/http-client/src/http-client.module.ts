import { Module, type DynamicModule } from "@bunest/common";
import {
  ConfigurableModuleClass,
  RootConfigurableModuleClass,
  type HttpClientAsyncOptions,
  type HttpClientModuleAsyncOptions,
  type HttpClientRegisterOptions,
  type HttpClientRootOptions,
} from "./http-client.module-definition";

/**
 * - `forRoot(options)` / `forRootAsync(...)`: defaults for every client (a global module).
 * - `register({ name?, isGlobal?, interceptors?, imports?, ...options })` / `registerAsync(...)`:
 *   one client each. Without a name it is injected as `HttpClient`, with one
 *   through `@InjectHttpClient(name)`.
 */
@Module({})
export class HttpClientModule extends ConfigurableModuleClass {
  /**
   * App-wide defaults: headers, timeout, retry, interceptors, `fetch`. Each
   * client's own settings win. `imports` serve the interceptor classes.
   */
  static forRoot(options: HttpClientRootOptions = {}): DynamicModule {
    return {
      ...RootConfigurableModuleClass.forRoot(
        options as Parameters<typeof RootConfigurableModuleClass.forRoot>[0],
      ),
      module: HttpClientModule,
    };
  }

  /**
   * `forRoot()` with options from DI: `useFactory`, or `useClass`/`useExisting`
   * with a `createHttpClientModuleOptions()` method. Interceptor classes go
   * next to them; the factory may return interceptor instances and functions.
   */
  static forRootAsync(options: HttpClientModuleAsyncOptions): DynamicModule {
    return {
      ...RootConfigurableModuleClass.forRootAsync(options),
      module: HttpClientModule,
    };
  }

  /** One client. Without a `name`, it is the default client, injected as `HttpClient`. */
  static override register(
    options: HttpClientRegisterOptions = {},
  ): DynamicModule {
    return super.register(
      options as Parameters<typeof ConfigurableModuleClass.register>[0],
    );
  }

  /**
   * One client with options from DI: `useFactory`, or `useClass`/`useExisting`
   * with a `createHttpClientOptions()` method. `name`, `isGlobal` and
   * interceptor classes go next to them; the factory may return interceptor
   * instances and functions.
   */
  static override registerAsync(
    options: HttpClientAsyncOptions,
  ): DynamicModule {
    return super.registerAsync(options);
  }
}
