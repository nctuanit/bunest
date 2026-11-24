import { afterEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  ParseIntPipe,
  Post,
} from "../../../../../packages/core/src/common";
import {
  Column,
  Entity,
  InjectRepository,
  OrmModule,
  PrimaryGeneratedColumn,
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

  @Column({ type: "integer" })
  views!: number;
}

@Injectable()
class PhotoService {
  constructor(
    @InjectRepository(Photo) private readonly repo: Repository<Photo>,
  ) {}

  create(name: string) {
    return this.repo.save({ name, description: "desc", views: 0 });
  }

  findAll() {
    return this.repo.find();
  }

  findOne(id: number) {
    return this.repo.findOne({ where: { id } });
  }
}

@Controller("photos")
class PhotoController {
  constructor(private readonly service: PhotoService) {}

  @Post()
  create() {
    return this.service.create("sunset");
  }

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }
}

@Injectable()
class PhotoOrmOptionsFactory implements OrmOptionsFactory {
  createOrmOptions() {
    return {
      type: "sqlite" as const,
      database: ":memory:",
      entities: [Photo],
      synchronize: true,
    };
  }
}

@Module({
  providers: [PhotoOrmOptionsFactory],
  exports: [PhotoOrmOptionsFactory],
})
class PhotoConfigModule {}

describeConformance(
  "Persistence (drizzle parity) - OrmModule registration modes (e2e)",
  {
    upstreamPath: "drizzle/tests/e2e/drizzle-module-modes.e2e.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts DrizzleModule forRoot / forRootAsync (useFactory, useClass, useExisting) HTTP e2e tests to @bunest/orm OrmModule.",
  },
  () => {
    const apps: Array<{ close: () => Promise<unknown> }> = [];

    afterEach(async () => {
      while (apps.length > 0) {
        await apps.pop()!.close();
      }
    });

    const modes = [
      {
        label: "forRoot",
        imports: [
          OrmModule.forRoot({
            type: "sqlite",
            database: ":memory:",
            entities: [Photo],
            synchronize: true,
          }),
          OrmModule.forFeature([Photo]),
        ],
      },
      {
        label: "forRootAsync (useFactory)",
        imports: [
          OrmModule.forRootAsync({
            useFactory: async () => ({
              type: "sqlite",
              database: ":memory:",
              entities: [Photo],
              synchronize: true,
            }),
          }),
          OrmModule.forFeature([Photo]),
        ],
      },
      {
        label: "forRootAsync (useClass)",
        imports: [
          OrmModule.forRootAsync({ useClass: PhotoOrmOptionsFactory }),
          OrmModule.forFeature([Photo]),
        ],
      },
      {
        label: "forRootAsync (useExisting)",
        imports: [
          OrmModule.forRootAsync({
            imports: [PhotoConfigModule],
            useExisting: PhotoOrmOptionsFactory,
          }),
          OrmModule.forFeature([Photo]),
        ],
      },
    ];

    for (const mode of modes) {
      describe(mode.label, () => {
        it("persists and queries entities over HTTP", async () => {
          const mod = await Test.createTestingModule({
            imports: mode.imports,
            controllers: [PhotoController],
            providers: [PhotoService],
          }).compile({ logger: false });
          const app = mod.createNestApplication();
          await app.init();
          apps.push(app);

          const created = await request(app).post("/photos").expect(201);
          expect(created.body.name).toBe("sunset");
          expect(created.body.id).toBeGreaterThan(0);

          const list = await request(app).get("/photos").expect(200);
          expect(list.body).toHaveLength(1);

          const single = await request(app)
            .get(`/photos/${created.body.id}`)
            .expect(200);
          expect(single.body.name).toBe("sunset");
        });
      });
    }
  },
);
