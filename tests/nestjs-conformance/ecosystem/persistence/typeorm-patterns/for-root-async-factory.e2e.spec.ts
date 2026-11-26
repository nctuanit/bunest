import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  type DynamicModule,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Column,
  Entity,
  InjectRepository,
  OrmModule,
  PrimaryGeneratedColumn,
  type OrmRepository,
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

@Injectable()
class PhotoService {
  constructor(
    @InjectRepository(Photo)
    private readonly photoRepository: OrmRepository<Photo>,
    @InjectRepository(Photo, "connection_2")
    private readonly photoRepository2: OrmRepository<Photo>,
  ) {}

  findAll(): Promise<Photo[]> {
    return this.photoRepository.find();
  }

  async create(): Promise<Omit<Photo, "id">> {
    const inserted = await this.photoRepository.save({
      name: "Nest",
      description: "Is great!",
      views: 6000,
    });
    expect(await this.photoRepository2.count()).toBe(0);
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
  findAll(): Promise<Photo[]> {
    return this.photoService.findAll();
  }

  @Post()
  create(): Promise<Omit<Photo, "id">> {
    return this.photoService.create();
  }
}

@Module({
  imports: [
    OrmModule.forFeature([Photo]),
    OrmModule.forFeature([Photo], "connection_2"),
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
        OrmModule.forRootAsync({
          useFactory: async () => {
            await Bun.sleep(2);
            return {
              type: "sqlite",
              database: ":memory:",
              entities: [Photo],
              synchronize: true,
            };
          },
        }),
        OrmModule.forRootAsync({
          name: "connection_2",
          useFactory: async () => ({
            type: "sqlite",
            database: ":memory:",
            entities: [Photo],
            synchronize: true,
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
      "Adapts async Promise<DynamicModule> + forRootAsync({ useFactory }) HTTP CRUD pattern to @bunest/orm OrmModule.forRootAsync on in-memory bun:sqlite.",
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
