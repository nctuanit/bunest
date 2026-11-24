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
  ) {}

  findAll(): Promise<Photo[]> {
    return this.photoRepository.find();
  }

  async create(): Promise<Omit<Photo, "id">> {
    const created = await this.photoRepository.save({
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
  findAll(): Promise<Photo[]> {
    return this.photoService.findAll();
  }

  @Post()
  create(): Promise<Omit<Photo, "id">> {
    return this.photoService.create();
  }
}

@Module({
  imports: [OrmModule.forFeature([Photo])],
  providers: [PhotoService],
  controllers: [PhotoController],
})
class PhotoModule {}

@Module({
  imports: [
    OrmModule.forRoot({
      type: "sqlite",
      database: ":memory:",
      entities: [Photo],
      synchronize: true,
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
      "Adapts synchronous TypeOrmModule.forRoot() + forFeature() HTTP CRUD test to @bunest/orm OrmModule + Repository<Photo>.",
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
