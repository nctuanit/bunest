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
  Entity,
  InjectRepository,
  OrmModule,
  PrimaryGeneratedColumn,
  type OrmDataSourceOptions,
  type OrmOptionsFactory,
  type Repository,
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
    private readonly photoRepository: Repository<Photo>,
    @InjectRepository(Photo, "connection_2")
    private readonly photoRepository2: Repository<Photo>,
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

@Injectable()
class ConfigService implements OrmOptionsFactory {
  createOrmOptions(): OrmDataSourceOptions {
    return {
      type: "sqlite",
      database: ":memory:",
      entities: [Photo],
      synchronize: true,
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
    OrmModule.forRootAsync({
      imports: [ConfigModule],
      useExisting: ConfigService,
    }),
    OrmModule.forRoot({
      name: "connection_2",
      type: "sqlite",
      database: ":memory:",
      entities: [Photo],
      synchronize: true,
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
      "Adapts TypeOrmModule.forRootAsync({ imports, useExisting }) pattern to @bunest/orm OrmModule.forRootAsync + OrmOptionsFactory on in-memory bun:sqlite.",
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
