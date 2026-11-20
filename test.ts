import "reflect-metadata";

// ==========================================
// 1. ENTITY
// ==========================================

class User {
  id!: number;
  name!: string;
  email!: string;
}

// ==========================================
// 2. DECORATORS
// ==========================================

const REPOSITORY_METADATA = Symbol("repository");
const QUERY_METADATA = Symbol("query");
const PARAM_METADATA = Symbol("params");

type EntityClass<T> = new (...args: any[]) => T;

function Repository<T>(entity: EntityClass<T>): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(REPOSITORY_METADATA, entity, target);
  };
}

function Query(sql: string): MethodDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(QUERY_METADATA, sql, target, propertyKey);
  };
}

function Param(name: string): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    const params: Record<number, string> =
      Reflect.getOwnMetadata(
        PARAM_METADATA,
        target,
        propertyKey!,
      ) ?? {};

    params[parameterIndex] = name;

    Reflect.defineMetadata(
      PARAM_METADATA,
      params,
      target,
      propertyKey!,
    );
  };
}

// ==========================================
// 3. BASE REPOSITORY
// ==========================================

abstract class JpaRepository<TEntity, TKey> {
  abstract findById(id: TKey): Promise<TEntity | null>;

  abstract findAll(): Promise<TEntity[]>;

  abstract save(entity: TEntity): Promise<TEntity>;

  abstract deleteById(id: TKey): Promise<void>;
}

// ==========================================
// 4. USER REPOSITORY
// ==========================================

@Repository(User)
abstract class UserRepository extends JpaRepository<User, number> {

  abstract findByEmail(email: string): Promise<User | null>;
}