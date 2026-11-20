import "reflect-metadata";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  ParseIntPipe,
  Post,
  type OnModuleInit,
  type Type,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  DrizzleModule,
  InjectDrizzle,
  type DrizzleClosableClient,
  type DrizzleDatabaseLike,
  type DrizzleModuleOptions,
  type DrizzleOptionsFactory,
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

interface PhotoDrizzleDb extends DrizzleDatabaseLike<PhotoDrizzleDb> {
  initSchema(): void;
  insertPhoto(data: Omit<PhotoRow, "id">): PhotoRow;
  selectAllPhotos(): PhotoRow[];
  selectPhotoById(id: number): PhotoRow | undefined;
}

function createPhotoDrizzleOptions(
  extra: { transactionalProxy?: boolean } = {},
): DrizzleModuleOptions<PhotoDrizzleDb> {
  const sqlite = new Database(":memory:");
  let closed = false;

  const client: DrizzleClosableClient = {
    close() {
      if (!closed) {
        closed = true;
        sqlite.close(true);
      }
    },
  };

  const db: PhotoDrizzleDb = {
    initSchema() {
      sqlite.run(`
        CREATE TABLE IF NOT EXISTS photos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          views INTEGER NOT NULL DEFAULT 0
        )
      `);
    },
    insertPhoto(data: Omit<PhotoRow, "id">): PhotoRow {
      const row = sqlite
        .prepare<PhotoRow, [string, string, number]>(
          "INSERT INTO photos (name, description, views) VALUES (?, ?, ?) RETURNING id, name, description, views",
        )
        .get(data.name, data.description, data.views);
      return row!;
    },
    selectAllPhotos(): PhotoRow[] {
      return sqlite
        .prepare<PhotoRow, []>(
          "SELECT id, name, description, views FROM photos ORDER BY id ASC",
        )
        .all();
    },
    selectPhotoById(id: number): PhotoRow | undefined {
      return (
        sqlite
          .prepare<PhotoRow, [number]>(
            "SELECT id, name, description, views FROM photos WHERE id = ? LIMIT 1",
          )
          .get(id) ?? undefined
      );
    },
  };

  return {
    db,
    client,
    global: true,
    transactionalProxy: extra.transactionalProxy,
  };
}

@Injectable()
class PhotoService implements OnModuleInit {
  constructor(@InjectDrizzle() private readonly db: PhotoDrizzleDb) {}

  onModuleInit(): void {
    this.db.initSchema();
  }

  create(): PhotoRow {
    return this.db.insertPhoto({
      name: "Nest",
      description: "Is great!",
      views: 6000,
    });
  }

  findAll(): PhotoRow[] {
    return this.db.selectAllPhotos();
  }

  findOne(id: number): PhotoRow | undefined {
    return this.db.selectPhotoById(id);
  }
}

@Controller("photo")
class PhotoController {
  constructor(private readonly photoService: PhotoService) {}

  @Get()
  findAll(): PhotoRow[] {
    return this.photoService.findAll();
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number): PhotoRow | undefined {
    return this.photoService.findOne(id);
  }

  @Post()
  create(): PhotoRow {
    return this.photoService.create();
  }
}

@Module({
  providers: [PhotoService],
  controllers: [PhotoController],
})
class PhotoModule {}

function createForRootModule(): Type {
  @Module({
    imports: [DrizzleModule.forRoot(createPhotoDrizzleOptions()), PhotoModule],
  })
  class ForRootAppModule {}
  return ForRootAppModule;
}

function createForRootProxyModule(): Type {
  @Module({
    imports: [
      DrizzleModule.forRoot(
        createPhotoDrizzleOptions({ transactionalProxy: true }),
      ),
      PhotoModule,
    ],
  })
  class ForRootProxyAppModule {}
  return ForRootProxyAppModule;
}

@Module({
  imports: [
    DrizzleModule.forRootAsync({
      global: true,
      useFactory: () => createPhotoDrizzleOptions(),
    }),
    PhotoModule,
  ],
})
class AsyncFactoryModule {}

const PROXY_FLAG_TOKEN = "DRIZZLE_PROXY_FLAG";

@Module({
  providers: [{ provide: PROXY_FLAG_TOKEN, useValue: false }],
  exports: [PROXY_FLAG_TOKEN],
})
class ConfigModule {}

@Module({
  imports: [
    DrizzleModule.forRootAsync({
      global: true,
      imports: [ConfigModule],
      inject: [PROXY_FLAG_TOKEN],
      useFactory: async (transactionalProxy: boolean) =>
        createPhotoDrizzleOptions({ transactionalProxy }),
    }),
    PhotoModule,
  ],
})
class AsyncImportsFactoryModule {}

@Injectable()
class DrizzleOptionsClass implements DrizzleOptionsFactory<PhotoDrizzleDb> {
  createDrizzleOptions(): DrizzleModuleOptions<PhotoDrizzleDb> {
    return createPhotoDrizzleOptions();
  }
}

@Module({
  imports: [
    DrizzleModule.forRootAsync({
      global: true,
      useClass: DrizzleOptionsClass,
    }),
    PhotoModule,
  ],
})
class AsyncClassModule {}

@Module({
  providers: [DrizzleOptionsClass],
  exports: [DrizzleOptionsClass],
})
class ExistingOptionsHostModule {}

@Module({
  imports: [
    DrizzleModule.forRootAsync({
      global: true,
      imports: [ExistingOptionsHostModule],
      useExisting: DrizzleOptionsClass,
    }),
    PhotoModule,
  ],
})
class AsyncExistingModule {}

describeConformance(
  "Persistence (drizzle) - module registration modes E2E",
  {
    upstreamPath: "drizzle/tests/e2e/drizzle.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts 6-mode DrizzleModule HTTP E2E matrix (forRoot, transactionalProxy, forRootAsync useFactory/imports/useClass/useExisting) using in-memory bun:sqlite-backed DrizzleDatabaseLike and zero-socket HTTP testing.",
  },
  () => {
    describe.each<[string, () => Type]>([
      ["forRoot (db)", createForRootModule],
      ["forRoot (db + transactionalProxy)", createForRootProxyModule],
      ["forRootAsync (useFactory)", () => AsyncFactoryModule],
      ["forRootAsync (useFactory + imports/inject)", () => AsyncImportsFactoryModule],
      ["forRootAsync (useClass)", () => AsyncClassModule],
      ["forRootAsync (useExisting)", () => AsyncExistingModule],
    ])("Drizzle - %s", (_, getRootModule) => {
      let app: BunestApplication;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [getRootModule()],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      afterEach(async () => {
        await app.close();
      });

      it("should return created row", async () => {
        const res = await request(app).post("/photo").expect(201);
        expect(res.body).toEqual({
          id: 1,
          name: "Nest",
          description: "Is great!",
          views: 6000,
        });
      });

      it("should query rows", async () => {
        await request(app).post("/photo").expect(201);

        const listRes = await request(app).get("/photo").expect(200);
        expect(listRes.body).toHaveLength(1);

        const oneRes = await request(app).get("/photo/1").expect(200);
        expect(oneRes.body.name).toBe("Nest");
      });
    });
  },
);
