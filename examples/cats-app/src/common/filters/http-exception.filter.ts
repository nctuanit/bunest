import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@bunest/core";

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost): Response {
    const req = host.switchToHttp().getRequest<Request>();
    const status = exception.getStatus();
    const raw = exception.getResponse();
    const body =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : { message: String(raw) };

    return Response.json(
      {
        ...body,
        statusCode: status,
        path: new URL(req.url).pathname,
        timestamp: new Date().toISOString(),
      },
      { status },
    );
  }
}
