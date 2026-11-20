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
  type SqliteModuleOptions,
  type SqliteOptionsFactory,
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

@Injectable()
class ConfigService implements SqliteOptionsFactory {
  createSqliteOptions(): SqliteModuleOptions {
    return {
      filename: ":memory:",
      autoMigrate: true,
      migrations: [CREATE_PHOTOS_MIGRATION],
    };
  }
}

@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
class ConfigModule {}

@Module({
  imports: [
    SqliteModule.forRootAsync({
      imports: [ConfigModule],
      useExisting: ConfigService,
    }),
    SqliteModule.forRoot({
      name: "connection_2",
      filename: ":memory:",
      autoMigrate: true,
      migrations: [CREATE_PHOTOS_MIGRATION],
    }),
    PhotoModule,
  ],
})
class AsyncOptionsExistingModule {}

describeConformance(
  "Persistence (typeorm-patterns) - forRootAsync with useExisting",
  {
    upstreamPath: "typeorm/tests/e2e/typeorm-async-existing.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts TypeOrmModule.forRootAsync({ imports, useExisting }) pattern to SqliteModule.forRootAsync + SqliteOptionsFactory on in-memory bun:sqlite.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AsyncOptionsExistingModule],
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
