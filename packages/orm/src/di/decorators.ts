import {
  DecoratorRegistry,
  Inject,
  Injectable,
  createMethodAspectDecorator,
  forwardRef,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/core";
import { DataSource } from "../data-source";
import type { EntityTarget } from "../types";
import {
  DEFAULT_ORM_DATA_SOURCE,
  getOrmDataSourceToken,
  getOrmEntityManagerToken,
  getOrmMigrationRunnerToken,
  getOrmRepositoryToken,
  getOrmTransactionalAspectToken,
} from "./tokens";

export interface OrmTransactionalOptions {
  readonly dataSource?: string;
}

/**
 * Injects the `DataSource` for the default or named ORM connection.
 */
export function InjectDataSource(
  dataSourceName: string = DEFAULT_ORM_DATA_SOURCE,
): ParameterDecorator & PropertyDecorator {
  return Inject(getOrmDataSourceToken(dataSourceName));
}

/**
 * Injects the `EntityManager` for the default or named ORM connection.
 */
export function InjectEntityManager(
  dataSourceName: string = DEFAULT_ORM_DATA_SOURCE,
): ParameterDecorator & PropertyDecorator {
  return Inject(getOrmEntityManagerToken(dataSourceName));
}

/**
 * Injects the `OrmMigrationRunner` for the default or named ORM connection.
 */
export function InjectOrmMigrations(
  dataSourceName: string = DEFAULT_ORM_DATA_SOURCE,
): ParameterDecorator & PropertyDecorator {
  return Inject(getOrmMigrationRunnerToken(dataSourceName));
}

/**
 * Injects a `Repository<Entity>` or compiled declarative `@OrmRepository(...)` instance.
 *
 * Accepts a direct class (`User` or `UserRepository`), string entity name (`"User"`),
 * typed `EntityRef<User>`, OR lazy thunk `() => User` (resolved via `forwardRef` to
 * prevent circular DI errors!).
 */
export function InjectRepository<T = unknown>(
  entity: EntityTarget<T>,
  dataSourceName: string = DEFAULT_ORM_DATA_SOURCE,
): ParameterDecorator & PropertyDecorator {
  // Arrow-function lazy thunk `() => Entity` uses forwardRef so target class is evaluated lazily
  if (typeof entity === "function" && entity.prototype === undefined) {
    return Inject(
      forwardRef(() => getOrmRepositoryToken(entity, dataSourceName)),
    );
  }
  return Inject(getOrmRepositoryToken(entity, dataSourceName));
}

/**
 * AOP Method Aspect Handler executing `@Transactional()` methods inside
 * `DataSource.transaction()` (with automatic nested `SAVEPOINT` propagation via `AsyncLocalStorage`).
 */
@Injectable()
export class OrmTransactionalAspect
  implements MethodAspectHandler<OrmTransactionalOptions>
{
  constructor(private readonly dataSource: DataSource) {}

  intercept(ctx: MethodAspectContext<OrmTransactionalOptions>): unknown {
    return this.dataSource.transaction(() => ctx.proceed());
  }
}

DecoratorRegistry.markInternal(OrmTransactionalAspect);

/**
 * Declarative `@Transactional()` method/class decorator powered by Bunest's zero-overhead
 * Method Aspect Weaver (ADR-014) and AsyncLocalStorage nested savepoints.
 */
export function Transactional(
  options: OrmTransactionalOptions = {},
): ClassDecorator & MethodDecorator {
  const dsName = options.dataSource ?? DEFAULT_ORM_DATA_SOURCE;
  return createMethodAspectDecorator<OrmTransactionalOptions>(
    getOrmTransactionalAspectToken(dsName),
    options,
  );
}
