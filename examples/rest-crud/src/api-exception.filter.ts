import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@bunest/core";

@Catch(HttpException)
export class ApiExceptionFilter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost): Response {
    const req = host.switchToHttp().getRequest<Request>();
    const status = exception.getStatus();
    const raw = exception.getResponse();
    const payload =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : { message: String(raw) };

    return Response.json(
      {
        ...payload,
        statusCode: status,
        path: new URL(req.url).pathname,
        timestamp: new Date().toISOString(),
      },
      { status },
    );
  }
}
