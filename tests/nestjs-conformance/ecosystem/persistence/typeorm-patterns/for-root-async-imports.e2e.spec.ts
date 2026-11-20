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
  InjectSql,
  SqlModule,
  SqlService,
  type MigrationDefinition,
} from "../../../../../packages/sql/src";
import {
  Test,
  describeConformance,
  request,
} from "../../../_helpers/index";

interface PhotoRow {
  id: number;
  name: string;
  description: string;
  views: number;
}

const SQL_URL_TOKEN = "TEST_SQL_URL";

const PHOTO_MIGRATIONS: MigrationDefinition<SqlService>[] = [
  {
    id: "001_photos",
    up: `CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      views INTEGER NOT NULL DEFAULT 0
    )`,
    down: "DROP TABLE IF EXISTS photos",
  },
];

@Module({
  providers: [{ provide: SQL_URL_TOKEN, useValue: "sqlite://:memory:" }],
  exports: [SQL_URL_TOKEN],
})
class DatabaseConfigModule {}

@Injectable()
class PhotoService {
  constructor(
    private readonly sql: SqlService,
    @InjectSql("connection_2") private readonly secondarySql: SqlService,
  ) {}

  async findAll(): Promise<PhotoRow[]> {
    const rows = await this.sql.sql<PhotoRow>`
      SELECT id, name, description, views FROM photos ORDER BY id ASC
    `;
    return [...rows];
  }

  async create(): Promise<Omit<PhotoRow, "id">> {
    await this.sql.sql`
      INSERT INTO photos (name, description, views)
      VALUES (${"Nest"}, ${"Is great!"}, ${6000})
    `;
    const secondaryCount = await this.secondarySql.queryScalar<number>(
      "SELECT COUNT(*) AS cnt FROM photos",
    );
    expect(secondaryCount).toBe(0);

    const row = await this.sql.queryOne<PhotoRow>(
      "SELECT id, name, description, views FROM photos ORDER BY id DESC LIMIT 1",
    );
    expect(row).not.toBeNull();
    return {
      name: row!.name,
      description: row!.description,
      views: row!.views,
    };
  }
}

@Controller("photo")
class PhotoController {
  constructor(private readonly photoService: PhotoService) {}

  @Get()
  findAll(): Promise<PhotoRow[]> {
    return this.photoService.findAll();
  }

  @Post()
  create(): Promise<Omit<PhotoRow, "id">> {
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
    SqlModule.forRootAsync({
      global: true,
      imports: [DatabaseConfigModule],
      inject: [SQL_URL_TOKEN],
      useFactory: async (url: string) => ({
        url,
        autoMigrate: true,
        migrations: PHOTO_MIGRATIONS,
      }),
    }),
    SqlModule.forRoot({
      global: true,
      name: "connection_2",
      url: "sqlite://:memory:",
      autoMigrate: true,
      migrations: PHOTO_MIGRATIONS,
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
      "Adapts TypeOrmModule.forRootAsync({ imports, inject, useFactory }) resolving config from imported module to SqlModule.forRootAsync on sqlite://:memory:.",
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
