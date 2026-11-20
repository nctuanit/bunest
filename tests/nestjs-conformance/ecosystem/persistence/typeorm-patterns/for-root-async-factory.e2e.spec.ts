import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  type DynamicModule,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  BaseSqliteRepository,
  InjectSqliteRepository,
  SqliteEntity,
  SqliteModule,
} from "../../../../../packages/sqlite/src";
import {
  Test,
  describeConformance,
  request,
} from "../../../_helpers/index";

interface PhotoRow extends Record<string, unknown> {
  id: number;
  name: string;
  description: string;
  views: number;
}

@SqliteEntity("photos")
class Photo {}

const CREATE_PHOTOS_MIGRATION = {
  id: "001_create_photos",
  up: `CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    views INTEGER NOT NULL DEFAULT 0
  )`,
  down: "DROP TABLE IF EXISTS photos",
};

@Injectable()
class PhotoService {
  constructor(
    @InjectSqliteRepository(Photo)
    private readonly photoRepository: BaseSqliteRepository<PhotoRow, number>,
    @InjectSqliteRepository(Photo, "connection_2")
    private readonly photoRepository2: BaseSqliteRepository<PhotoRow, number>,
  ) {}

  findAll(): PhotoRow[] {
    return this.photoRepository.findAll();
  }

  create(): Omit<PhotoRow, "id"> {
    const inserted = this.photoRepository.insertReturning({
      name: "Nest",
      description: "Is great!",
      views: 6000,
    });
    expect(this.photoRepository2.count()).toBe(0);
    return {
      name: inserted.name,
      description: inserted.description,
      views: inserted.views,
    };
  }
}

@Controller("photo")
class PhotoController {
  constructor(private readonly photoService: PhotoService) {}

  @Get()
  findAll(): PhotoRow[] {
    return this.photoService.findAll();
  }

  @Post()
  create(): Omit<PhotoRow, "id"> {
    return this.photoService.create();
  }
}

@Module({
  imports: [
    SqliteModule.forFeature([Photo]),
    SqliteModule.forFeature([Photo], "connection_2"),
  ],
  providers: [PhotoService],
  controllers: [PhotoController],
})
class PhotoModule {}

@Module({})
class AsyncDatabaseModule {
  static async forRoot(): Promise<DynamicModule> {
    await Bun.sleep(5);
    return {
      module: AsyncDatabaseModule,
      imports: [
        SqliteModule.forRootAsync({
          useFactory: async () => {
            await Bun.sleep(2);
            return {
              filename: ":memory:",
              autoMigrate: true,
              migrations: [CREATE_PHOTOS_MIGRATION],
            };
          },
        }),
        SqliteModule.forRootAsync({
          name: "connection_2",
          useFactory: async () => ({
            filename: ":memory:",
            autoMigrate: true,
            migrations: [CREATE_PHOTOS_MIGRATION],
          }),
        }),
      ],
    };
  }
}

@Module({
  imports: [AsyncDatabaseModule.forRoot(), PhotoModule],
})
class AsyncApplicationModule {}

describeConformance(
  "Persistence (typeorm-patterns) - async dynamic module & forRootAsync useFactory",
  {
    upstreamPath: "typeorm/tests/e2e/typeorm-async.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts async Promise<DynamicModule> + forRootAsync({ useFactory }) HTTP CRUD pattern to SqliteModule.forRootAsync on in-memory bun:sqlite.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AsyncApplicationModule],
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
    });
  },
);
