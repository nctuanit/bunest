import {
  Injectable,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/core";

export interface DataEnvelope<T> {
  readonly data: T;
}

@Injectable()
export class TransformInterceptor<T> implements BunestInterceptor<
  T,
  DataEnvelope<T>
> {
  async intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Promise<DataEnvelope<T>> {
    const data = await next.handle();
    return { data };
  }
}
