import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { attachIpcChannel } from "./ipc";
import {
  CreateUserDto,
  type CreateUserInput,
  createUserRecord,
  findUserById,
} from "./shared";

const VALIDATOR_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
};

const TRANSFORM_OPTIONS = {
  enableImplicitConversion: false,
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  routes: {
    "/health": {
      GET: () => Response.json({ status: "ok" }),
    },
    "/users/:id": {
      GET: (req) => Response.json(findUserById(req.params.id)),
    },
    "/users": {
      POST: async (req) => {
        const body = (await req.json()) as CreateUserInput;
        return Response.json(createUserRecord(body), { status: 201 });
      },
    },
    "/users/validated": {
      POST: async (req) => {
        const raw = (await req.json()) as Record<string, unknown>;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          return Response.json(
            { statusCode: 400, message: "Validation failed" },
            { status: 400 },
          );
        }
        const dto = plainToInstance(CreateUserDto, raw, TRANSFORM_OPTIONS);
        const errors = await validate(dto, VALIDATOR_OPTIONS);
        if (errors.length > 0) {
          return Response.json(
            {
              statusCode: 400,
              message: errors.flatMap((e) =>
                Object.values(e.constraints ?? {}),
              ),
              error: "Bad Request",
            },
            { status: 400 },
          );
        }
        return Response.json(createUserRecord(dto), { status: 201 });
      },
    },
  },
  fetch() {
    return Response.json({ statusCode: 404, message: "Not Found" }, { status: 404 });
  },
});

attachIpcChannel(server.port!, () => {
  server.stop(true);
});
