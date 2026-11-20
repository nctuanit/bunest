import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Post,
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
  ) {}

  findAll(): PhotoRow[] {
    return this.photoRepository.findAll();
  }

  create(): Omit<PhotoRow, "id"> {
    const created = this.photoRepository.insertReturning({
      name: "Nest",
      description: "Is great!",
      views: 6000,
    });
    return {
      name: created.name,
      description: created.description,
      views: created.views,
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
  imports: [SqliteModule.forFeature([Photo])],
  providers: [PhotoService],
  controllers: [PhotoController],
})
class PhotoModule {}

@Module({
  imports: [
    SqliteModule.forRoot({
      filename: ":memory:",
      autoMigrate: true,
      migrations: [CREATE_PHOTOS_MIGRATION],
    }),
    PhotoModule,
  ],
})
class ApplicationModule {}

describeConformance(
  "Persistence (typeorm-patterns) - synchronous forRoot + forFeature CRUD",
  {
    upstreamPath: "typeorm/tests/e2e/typeorm.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts synchronous TypeOrmModule.forRoot() + forFeature() HTTP CRUD test to SqliteModule + BaseSqliteRepository.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ApplicationModule],
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
      expect(listRes.body).toEqual([
        {
          id: 1,
          name: "Nest",
          description: "Is great!",
          views: 6000,
        },
      ]);
    });
  },
);
