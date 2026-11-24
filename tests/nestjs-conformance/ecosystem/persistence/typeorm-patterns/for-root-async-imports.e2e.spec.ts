import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Post,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Column,
  DataSource,
  Entity,
  InjectDataSource,
  OrmModule,
  PrimaryGeneratedColumn,
} from "../../../../../packages/orm/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Entity("photos")
class Photo {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  description!: string;

  @Column({ type: "integer", default: 0 })
  views!: number;
}

const ORM_URL_TOKEN = "TEST_ORM_URL";

@Module({
  providers: [{ provide: ORM_URL_TOKEN, useValue: "sqlite://:memory:" }],
  exports: [ORM_URL_TOKEN],
})
class DatabaseConfigModule {}

@Injectable()
class PhotoService {
  constructor(
    private readonly ds: DataSource,
    @InjectDataSource("connection_2") private readonly secondaryDs: DataSource,
  ) {}

  async findAll(): Promise<Photo[]> {
    return this.ds.getRepository(Photo).find({ order: { id: "ASC" } });
  }

  async create(): Promise<Omit<Photo, "id">> {
    const saved = await this.ds.getRepository(Photo).save({
      name: "Nest",
      description: "Is great!",
      views: 6000,
    });
    const secondaryCount = await this.secondaryDs.getRepository(Photo).count();
    expect(secondaryCount).toBe(0);

    return {
      name: saved.name,
      description: saved.description,
      views: saved.views,
    };
  }
}

@Controller("photo")
class PhotoController {
  constructor(private readonly photoService: PhotoService) {}

  @Get()
  findAll(): Promise<Photo[]> {
    return this.photoService.findAll();
  }

  @Post()
  create(): Promise<Omit<Photo, "id">> {
    return this.photoService.create();
  }
}

@Module({
  providers: [PhotoService],
  controllers: [PhotoController],
})
class PhotoModule {}

@Module({
  imports: [
    OrmModule.forRootAsync({
      global: true,
      imports: [DatabaseConfigModule],
      inject: [ORM_URL_TOKEN],
      useFactory: async (url: string) => ({
        type: "sqlite",
        url,
        useBunSql: true,
        entities: [Photo],
        synchronize: true,
      }),
    }),
    OrmModule.forRoot({
      name: "connection_2",
      type: "sqlite",
      url: "sqlite://:memory:",
      useBunSql: true,
      entities: [Photo],
      synchronize: true,
    }),
    PhotoModule,
  ],
})
class AsyncOptionsFactoryModule {}

describeConformance(
  "Persistence (typeorm-patterns) - forRootAsync with imports/inject/useFactory",
  {
    upstreamPath: "typeorm/tests/e2e/typeorm-async-options.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts TypeOrmModule.forRootAsync({ imports, inject, useFactory }) resolving config from imported module to @bunest/orm OrmModule.forRootAsync via native Bun.SQL on sqlite://:memory:.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AsyncOptionsFactoryModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("should return created entity", async () => {
      const res = await request(app).post("/photo").expect(201);
      expect(res.body).toEqual({
        name: "Nest",
        description: "Is great!",
        views: 6000,
      });

      const listRes = await request(app).get("/photo").expect(200);
      expect(listRes.body).toHaveLength(1);
      expect(listRes.body[0]).toMatchObject({
        name: "Nest",
        description: "Is great!",
        views: 6000,
      });
    });
  },
);
