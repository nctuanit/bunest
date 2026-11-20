import "reflect-metadata";
import { DEFAULT_PRISMA_CONNECTION, getPrismaToken } from "@bunest/sql";

/**
 * Default DI injection token for the primary Prisma client instance
 * (identical to `getPrismaToken(DEFAULT_PRISMA_CONNECTION)` / `@InjectPrisma()`).
 */
export const PRISMA_CLIENT: string = getPrismaToken(DEFAULT_PRISMA_CONNECTION);

export {
  DEFAULT_PRISMA_CONNECTION,
  InjectPrisma,
  InjectPrismaService,
  PrismaModule,
  PrismaServiceBase,
  PrismaServiceBase as PrismaService,
  getPrismaOptionsToken,
  getPrismaServiceToken,
  getPrismaToken,
  mapPrismaErrorToHttp,
  type PrismaClientLike,
  type PrismaModuleAsyncOptions,
  type PrismaModuleOptions,
  type PrismaOptionsFactory,
  type PrismaServiceOptions,
} from "@bunest/sql";

export {
  PrismaClientExceptionFilter,
  isPrismaClientKnownRequestError,
  type PrismaErrorCodeStatusMap,
  type PrismaKnownRequestErrorLike,
} from "./prisma-client-exception.filter";
