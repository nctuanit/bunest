import { Inject, Injectable, mixin, Optional, type Type } from "@bunest/common";
import { MissingBullSharedConfigurationError } from "../errors/missing-shared-bull-config.error";

export interface IConditionalDepHolder<T = any> {
  getDependencyRef(caller?: string): T;
}

export function createConditionalDepHolder<T = any>(
  depToken: string,
  optionalDep: string,
  errorFactory: (caller?: string) => MissingBullSharedConfigurationError = (
    caller,
  ) => new MissingBullSharedConfigurationError(depToken, caller),
): Type<IConditionalDepHolder<T>> {
  @Injectable()
  class ConditionalDepHolder implements IConditionalDepHolder<T> {
    constructor(
      @Optional()
      @Inject(depToken)
      private readonly _dependencyRef?: T,
    ) {}

    getDependencyRef(caller?: string): T {
      if (depToken !== optionalDep && !this._dependencyRef) {
        throw errorFactory(caller);
      }
      return this._dependencyRef as T;
    }
  }

  return mixin(ConditionalDepHolder);
}
