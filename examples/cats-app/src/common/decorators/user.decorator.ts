import { createParamDecorator, type ExecutionContext } from "@bunest/core";

export const Actor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return req.headers.get("x-user") ?? "anonymous";
  },
);
