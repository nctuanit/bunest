import { expect, it } from "bun:test";
import { Injectable } from "../../../../../packages/core/src/common";
import {
  Column,
  Entity,
  InjectRepository,
  PrimaryGeneratedColumn,
  entityRef,
  getOrmRepositoryToken,
  type OrmRepository,
} from "../../../../../packages/orm/src";
import { Test, describeConformance } from "../../../_helpers/index";

@Entity("photos")
class Photo {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;
}

const PhotoRef = entityRef<Photo>("Photo");

@Injectable()
class ByNamedConnection {
  constructor(
    @InjectRepository(Photo, "foo")
    readonly repository: OrmRepository<Photo>,
  ) {}
}

@Injectable()
class ByDefaultConnection {
  constructor(
    @InjectRepository(Photo)
    readonly repository: OrmRepository<Photo>,
  ) {}
}

@Injectable()
class ByEntityRefAndLazyThunk {
  constructor(
    @InjectRepository(PhotoRef, "foo")
    readonly byRef: OrmRepository<Photo>,
    @InjectRepository(() => Photo)
    readonly byThunk: OrmRepository<Photo>,
  ) {}
}

describeConformance(
  "Persistence (typeorm-patterns) - @InjectRepository decorator",
  {
    upstreamPath: "typeorm/tests/unit/inject-repository.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts @InjectRepository + getRepositoryToken unit tests to @bunest/orm @InjectRepository + getOrmRepositoryToken for default, named, entityRef, and lazy thunk targets.",
  },
  () => {
    const fooRepository = {} as OrmRepository<Photo>;
    const defaultRepository = {} as OrmRepository<Photo>;

    async function resolve<T>(
      target: new (...args: any[]) => T,
      providers: Array<{ provide: string; useValue: OrmRepository<Photo> }>,
    ): Promise<T> {
      const moduleRef = await Test.createTestingModule({
        providers: [target, ...providers],
      }).compile({ logger: false });
      try {
        return moduleRef.get(target);
      } finally {
        await moduleRef.close();
      }
    }

    it("resolves repository token for a named connection", async () => {
      const instance = await resolve(ByNamedConnection, [
        { provide: getOrmRepositoryToken(Photo, "foo"), useValue: fooRepository },
      ]);
      expect(instance.repository).toBe(fooRepository);
    });

    it("normalizes class, string name, EntityRef, and lazy thunk to identical tokens per connection", async () => {
      expect(getOrmRepositoryToken(Photo)).toBe(
        getOrmRepositoryToken(Photo, "default"),
      );
      expect(getOrmRepositoryToken(Photo)).toBe(getOrmRepositoryToken("Photo"));
      expect(getOrmRepositoryToken(Photo)).toBe(
        getOrmRepositoryToken(PhotoRef),
      );
      expect(getOrmRepositoryToken(Photo, "foo")).not.toBe(
        getOrmRepositoryToken(Photo, "default"),
      );

      const defaultInstance = await resolve(ByDefaultConnection, [
        { provide: getOrmRepositoryToken(Photo), useValue: defaultRepository },
      ]);
      expect(defaultInstance.repository).toBe(defaultRepository);

      const refAndThunk = await resolve(ByEntityRefAndLazyThunk, [
        { provide: getOrmRepositoryToken(Photo, "foo"), useValue: fooRepository },
        { provide: getOrmRepositoryToken(Photo), useValue: defaultRepository },
      ]);
      expect(refAndThunk.byRef).toBe(fooRepository);
      expect(refAndThunk.byThunk).toBe(defaultRepository);
    });
  },
);
