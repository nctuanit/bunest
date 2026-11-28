import {
  Injectable,
  type BunestMiddleware,
  type NextFunction,
  type ResponseContext,
} from "@bunest/core";

@Injectable()
export class LoggerMiddleware implements BunestMiddleware {
  use(
    _req: Request,
    res: ResponseContext,
    next: NextFunction,
  ): void | Response | Promise<void | Response> {
    res.header("X-Middleware-Applied", "cats-logger");
    return next();
  }
}
