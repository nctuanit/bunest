import {
  DecoratorRegistry,
  Inject,
  Injectable,
  Optional,
  createMethodAspectDecorator,
  isFunction,
  isPromiseLike,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "../common/index";
import {
  CLS_MODULE_OPTIONS,
  ClsService,
  type ClsModuleOptions,
} from "./cls.service";

export interface WithClsOptions {
  /**
   * Initial key/value pairs populated into the CLS store when starting a new context.
   * Accepts a static record or a factory receiving the method's arguments.
   */
  readonly initial?:
    Record<string, unknown> | ((args: unknown[]) => Record<string, unknown>);
  /**
   * When true, reuses an existing active CLS context if present instead of
   * starting a fresh nested store.
   * @default false
   */
  readonly ifNotActive?: boolean;
  /**
   * Optional setup hook invoked inside the active CLS store before the method runs.
   */
  readonly setup?: (cls: ClsService, args: unknown[]) => void | Promise<void>;
}

/**
 * Method aspect handler powering `@WithCls(options?)` on non-HTTP service methods,
 * background workers, cron jobs, event listeners, and standalone invocations.
 */
@Injectable()
export class WithClsAspect implements MethodAspectHandler<
  WithClsOptions | undefined
> {
  constructor(
    @Optional()
    private readonly cls?: ClsService,
    @Optional()
    @Inject(CLS_MODULE_OPTIONS)
    private readonly moduleOptions: ClsModuleOptions = {},
  ) {}

  intercept(ctx: MethodAspectContext<WithClsOptions | undefined>): unknown {
    const cls = this.cls ?? new ClsService(this.moduleOptions);
    const opts = ctx.options;
    const initial = isFunction(opts?.initial)
      ? opts.initial(ctx.args)
      : opts?.initial;

    const execute = (): unknown => {
      const setupFn = opts?.setup;
      if (setupFn) {
        const setupResult = setupFn(cls, ctx.args);
        if (isPromiseLike(setupResult)) {
          return Promise.resolve(setupResult).then(() => ctx.proceed());
        }
      } else if (this.moduleOptions.setup) {
        const setupResult = this.moduleOptions.setup(cls, undefined);
        if (isPromiseLike(setupResult)) {
          return Promise.resolve(setupResult).then(() => ctx.proceed());
        }
      }
      return ctx.proceed();
    };

    if (opts?.ifNotActive) {
      return cls.runIfNotActive(execute, initial);
    }
    return cls.run(execute, initial);
  }
}

/**
 * Declaratively wraps a service method (or all methods of a class) inside a
 * `ClsService.run(...)` AsyncLocalStorage context via Bunest's Method Aspect engine.
 */
export function WithCls(
  options?: WithClsOptions,
): ClassDecorator & MethodDecorator {
  return createMethodAspectDecorator(WithClsAspect, options);
}

DecoratorRegistry.markInternal(WithClsAspect);
