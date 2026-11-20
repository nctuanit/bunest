import { Module, type DynamicModule } from "@bunest/common";
import { WithClsAspect } from "./cls.decorator";
import {
  CLS_MODULE_OPTIONS,
  ClsInterceptor,
  ClsMiddleware,
  ClsService,
  type ClsModuleOptions,
} from "./cls.service";

/**
 * Module providing `ClsService`, `ClsMiddleware`, `ClsInterceptor`, and `WithClsAspect`
 * backed by Bun's native `AsyncLocalStorage` (comparable to `nestjs-cls`).
 */
@Module({
  providers: [ClsService, ClsMiddleware, ClsInterceptor, WithClsAspect],
  exports: [ClsService, ClsMiddleware, ClsInterceptor, WithClsAspect],
})
export class ClsModule {
  static forRoot(options: ClsModuleOptions = {}): DynamicModule {
    return {
      module: ClsModule,
      global: options.global ?? true,
      providers: [
        {
          provide: CLS_MODULE_OPTIONS,
          useValue: options,
        },
      ],
      exports: [ClsService, ClsMiddleware, ClsInterceptor, WithClsAspect],
    };
  }
}
