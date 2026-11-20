import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Inject,
  Injectable,
  Module,
} from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  CannotDetermineTypeError,
  DEFAULT_DB_CONNECTION,
  DefinitionsFactory,
  InjectConnection,
  InjectModel,
  IsObjectIdPipe,
  MONGOOSE_CONNECTION_NAME,
  MONGOOSE_MODULE_OPTIONS,
  MongooseConnection,
  MongooseError,
  MongooseModel,
  MongooseModule,
  MongooseSchema,
  ObjectId,
  ParseObjectIdPipe,
  Prop,
  RAW_OBJECT_DEFINITION,
  Schema,
  SchemaFactory,
  SchemaTypes,
  TypeMetadataStorage,
  Virtual,
  VirtualsFactory,
  getConnectionToken,
  getModelToken,
  handleRetry,
  raw,
  type HydratedDocument,
  type MongooseModuleOptions,
  type MongooseOptionsFactory,
} from "../src";

describe("@bunest/mongoose", () => {
  describe("tokens, constants, ObjectId, and pipes", () => {
    it("matches exact upstream token formulas and constants", () => {
      expect(DEFAULT_DB_CONNECTION).toBe("DatabaseConnection");
      expect(MONGOOSE_MODULE_OPTIONS).toBe("MongooseModuleOptions");
      expect(MONGOOSE_CONNECTION_NAME).toBe("MongooseConnectionName");
      expect(RAW_OBJECT_DEFINITION).toBe("RAW_OBJECT_DEFINITION");

      expect(getConnectionToken()).toBe("DatabaseConnection");
      expect(getConnectionToken(DEFAULT_DB_CONNECTION)).toBe("DatabaseConnection");
      expect(getConnectionToken("cats")).toBe("catsConnection");

      expect(getModelToken("Cat")).toBe("CatModel");
      expect(getModelToken("Cat", "cats")).toBe("catsConnection/CatModel");
      expect(getModelToken("Cat", DEFAULT_DB_CONNECTION)).toBe(
        "DatabaseConnection/CatModel",
      );
    });

    it("implements BSON-compatible ObjectId and validates with IsObjectIdPipe & ParseObjectIdPipe", () => {
      const id1 = new ObjectId();
      const id2 = new ObjectId();
      expect(id1.toHexString()).toMatch(/^[0-9a-f]{24}$/);
      expect(id1.equals(id2)).toBe(false);
      expect(id1.equals(id1.toHexString())).toBe(true);
      expect(id1.equals(new ObjectId(id1.toHexString()))).toBe(true);
      expect(id1.toJSON()).toBe(id1.toHexString());
      expect(id1.getTimestamp()).toBeInstanceOf(Date);

      const fromTime = ObjectId.createFromTime(1_700_000_000);
      expect(Math.floor(fromTime.getTimestamp().getTime() / 1000)).toBe(
        1_700_000_000,
      );

      expect(ObjectId.isValid(id1)).toBe(true);
      expect(ObjectId.isValid("507f1f77bcf86cd799439011")).toBe(true);
      expect(ObjectId.isValid("not-an-object-id")).toBe(false);
      expect(ObjectId.isValid("507f1f77bcf86cd79943901g")).toBe(false);
      expect(ObjectId.isValid(null)).toBe(false);

      const isPipe = new IsObjectIdPipe();
      const parsePipe = new ParseObjectIdPipe();
      const hex = "507f1f77bcf86cd799439011";

      expect(isPipe.transform(hex)).toBe(hex);
      const parsed = parsePipe.transform(hex);
      expect(parsed).toBeInstanceOf(ObjectId);
      expect(parsed.toHexString()).toBe(hex);

      expect(() => isPipe.transform("invalid-id")).toThrow(BadRequestException);
      expect(() => parsePipe.transform("12345")).toThrow(BadRequestException);
    });
  });

  describe("decorators and schema factories", () => {
    it("infers design:type, supports raw(), nested @Schema, inheritance, ref thunks, and @Virtual", () => {
      @Schema({ _id: false })
      class Address {
        @Prop({ required: true })
        city!: string;

        @Prop()
        zip!: string;
      }

      @Schema()
      class Owner {
        @Prop({ required: true })
        name!: string;
      }

      @Schema()
      class BaseAnimal {
        @Prop({ default: true })
        active!: boolean;
      }

      @Schema({ timestamps: true, collection: "cats_collection" })
      class Cat extends BaseAnimal {
        @Prop({ required: true, trim: true })
        firstName!: string;

        @Prop({ required: true })
        lastName!: string;

        @Prop({ min: 0 })
        age!: number;

        @Prop([String])
        tags!: string[];

        @Prop({ type: Address })
        address!: Address;

        @Prop(
          raw({
            color: { type: String },
            weight: { type: Number },
          }),
        )
        details!: Record<string, any>;

        @Prop({ type: SchemaTypes.ObjectId, ref: () => Owner })
        owner!: ObjectId;

        @Virtual({
          get(this: Cat) {
            return `${this.firstName} ${this.lastName}`;
          },
          set(this: Cat, value: string) {
            const [first, last] = value.split(" ");
            this.firstName = first ?? "";
            this.lastName = last ?? "";
          },
        })
        fullName!: string;
      }

      expect(TypeMetadataStorage.getSchemaMetadataByTarget(Cat)).toBeDefined();

      const definition = DefinitionsFactory.createForClass(Cat);
      expect((definition.firstName as any).type).toBe(String);
      expect((definition.age as any).type).toBe(Number);
      expect((definition.active as any).type).toBe(Boolean);
      expect((definition.owner as any).ref).toBe("Owner");
      expect((definition.details as any).color.type).toBe(String);
      expect((definition.address as any).type).toBeInstanceOf(MongooseSchema);

      const schema = SchemaFactory.createForClass(Cat);
      expect(schema).toBeInstanceOf(MongooseSchema);
      expect(schema.options.collection).toBe("cats_collection");
      expect(schema.options.timestamps).toBe(true);
      expect(schema.virtualpath("fullName")).toBeDefined();
      expect(schema.requiredPaths()).toContain("firstName");
      expect(schema.requiredPaths()).toContain("lastName");

      // VirtualsFactory direct invocation
      const manualSchema = new MongooseSchema({ firstName: String, lastName: String });
      VirtualsFactory.inspect(Cat, manualSchema);
      expect(manualSchema.virtualpath("fullName")).toBeDefined();
    });

    it("throws CannotDetermineTypeError when type is ambiguous/union/Object", () => {
      expect(() => {
        @Schema()
        class AmbiguousDoc {
          @Prop()
          ambiguous!: string | number;
        }
        return AmbiguousDoc;
      }).toThrow(CannotDetermineTypeError);
    });

    it("throws helpful error when bare class constructor is passed to ref without arrow wrapper", () => {
      class TargetRef {}

      @Schema()
      class BadRefDoc {
        @Prop({ type: SchemaTypes.ObjectId, ref: TargetRef as any })
        refField!: ObjectId;
      }

      expect(() => DefinitionsFactory.createForClass(BadRefDoc)).toThrow(
        /wrap your class reference in an arrow function/,
      );
    });
  });

  describe("MongooseModule DI, CRUD, queries, hooks, validation, population, discriminators, and shutdown", () => {
    it("supports forRoot, forFeature, CRUD, operators, hooks, virtuals, population, aggregation, and graceful shutdown", async () => {
      @Schema()
      class Owner {
        @Prop({ required: true })
        name!: string;
      }
      const OwnerSchema = SchemaFactory.createForClass(Owner);

      @Schema({ timestamps: true })
      class Cat {
        @Prop({ required: true, trim: true })
        name!: string;

        @Prop({ required: true, min: 0, max: 30 })
        age!: number;

        @Prop({ enum: ["tabby", "siamese", "bengal"], default: "tabby" })
        breed!: string;

        @Prop({ unique: true, sparse: true, lowercase: true })
        email?: string;

        @Prop([String])
        toys!: string[];

        @Prop({ type: SchemaTypes.ObjectId, ref: () => Owner })
        owner?: ObjectId;

        @Virtual({
          get(this: Cat) {
            return `${this.name} (${this.breed})`;
          },
        })
        label!: string;
      }
      const CatSchema = SchemaFactory.createForClass(Cat);

      const hookLog: string[] = [];
      CatSchema.pre("save", function (this: any) {
        hookLog.push(`pre-save:${this.name}`);
      });
      CatSchema.post("save", function (doc: any) {
        hookLog.push(`post-save:${doc.name}`);
      });
      CatSchema.method("meow", function (this: any) {
        return `${this.name} says meow!`;
      });
      CatSchema.static("findByBreed", function (this: MongooseModel<Cat>, breed: string) {
        return this.find({ breed });
      });

      @Injectable()
      class CatsService {
        constructor(
          @InjectModel(Cat.name) readonly catModel: MongooseModel<Cat>,
          @InjectModel(Owner.name) readonly ownerModel: MongooseModel<Owner>,
          @InjectConnection() readonly connection: MongooseConnection,
        ) {}
      }

      let onCreateCalled = false;

      @Module({
        imports: [
          MongooseModule.forRoot("mongodb://localhost:27017/bunest_test", {
            onConnectionCreate: (conn) => {
              onCreateCalled = true;
              expect(conn.name).toBe("bunest_test");
            },
          }),
          MongooseModule.forFeature([
            { name: Owner.name, schema: OwnerSchema },
            { name: Cat.name, schema: CatSchema },
          ]),
        ],
        providers: [CatsService],
      })
      class AppModule {}

      const app = await BunestFactory.createApplicationContext(AppModule);
      const service = app.get(CatsService);

      expect(onCreateCalled).toBe(true);
      expect(service.connection.readyState).toBe(1);
      expect(service.connection.name).toBe("bunest_test");

      // Create owner & cats
      const alice = await service.ownerModel.create({ name: "Alice" });
      const whisk = await service.catModel.create({
        name: "  Whiskers  ",
        age: 3,
        breed: "siamese",
        email: "WHISKERS@CATS.DEV",
        toys: ["mouse", "laser"],
        owner: alice._id,
      });

      expect(whisk.name).toBe("Whiskers"); // trimmed
      expect(whisk.email).toBe("whiskers@cats.dev"); // lowercased
      expect((whisk as any).label).toBe("Whiskers (siamese)"); // virtual getter
      expect((whisk as any).meow()).toBe("Whiskers says meow!"); // instance method
      expect((whisk as any).createdAt).toBeInstanceOf(Date);
      expect(hookLog).toEqual(["pre-save:Whiskers", "post-save:Whiskers"]);

      // Unique constraint check
      await expect(
        service.catModel.create({
          name: "Clone",
          age: 1,
          email: "whiskers@cats.dev",
        }),
      ).rejects.toThrow(/E11000/);

      // Validation check (min/max/enum/required)
      await expect(
        service.catModel.create({ name: "BadAge", age: 99 }),
      ).rejects.toThrow(/validation failed/);
      await expect(
        service.catModel.create({ name: "BadBreed", age: 2, breed: "lion" as any }),
      ).rejects.toThrow(/validation failed/);

      await service.catModel.insertMany([
        { name: "Luna", age: 5, breed: "bengal", toys: ["yarn"], owner: alice._id },
        { name: "Milo", age: 1, breed: "tabby", toys: ["ball", "mouse"] },
        { name: "Nala", age: 7, breed: "bengal", toys: ["feather"] },
      ]);

      // Static method + queries + sort + skip + limit + projection + lean
      const bengals = await (service.catModel as any).findByBreed("bengal").sort({ age: -1 }).lean();
      expect(bengals.map((c: any) => c.name)).toEqual(["Nala", "Luna"]);

      const queryFiltered = await service.catModel
        .find({ age: { $gte: 3 }, toys: { $in: ["mouse", "yarn"] } })
        .select("name age")
        .sort("age")
        .lean();
      expect(queryFiltered.map((c: any) => c.name)).toEqual(["Whiskers", "Luna"]);
      expect((queryFiltered[0] as any).breed).toBeUndefined();

      // Populate reference
      const populated = await service.catModel
        .findById(whisk._id)
        .populate("owner")
        .exec();
      expect((populated?.owner as any)?.name).toBe("Alice");

      // Update operators ($inc, $addToSet, $set) & findByIdAndUpdate
      const updated = await service.catModel
        .findByIdAndUpdate(
          whisk._id,
          { $inc: { age: 1 }, $addToSet: { toys: "catnip" } },
          { new: true },
        )
        .exec();
      expect(updated?.age).toBe(4);
      expect(updated?.toys).toContain("catnip");

      // Upsert
      const upserted = await service.catModel
        .findOneAndUpdate(
          { name: "Shadow" },
          { $set: { age: 2, breed: "tabby", toys: [] } },
          { upsert: true, new: true },
        )
        .exec();
      expect(upserted?.name).toBe("Shadow");

      // Aggregation pipeline
      const stats = await service.catModel
        .aggregate<{ _id: string; count: number; avgAge: number }>([
          { $group: { _id: "$breed", count: { $sum: 1 }, avgAge: { $avg: "$age" } } },
          { $sort: { count: -1, _id: 1 } },
        ])
        .exec();
      expect(stats.find((s: { _id: string }) => s._id === "bengal")).toEqual({
        _id: "bengal",
        count: 2,
        avgAge: 6,
      });

      // Distinct, countDocuments, exists, delete
      expect(await service.catModel.countDocuments({ breed: "tabby" })).toBe(2);
      expect(await service.catModel.exists({ name: "Luna" })).toBeTruthy();
      expect((await service.catModel.distinct("breed")).sort()).toEqual([
        "bengal",
        "siamese",
        "tabby",
      ]);

      const deleted = await service.catModel.findByIdAndDelete(upserted!._id);
      expect(deleted?.name).toBe("Shadow");
      expect(await service.catModel.countDocuments()).toBe(4);

      // Graceful shutdown closes connection
      await app.close();
      expect(service.connection.readyState).toBe(0);
    });

    it("supports forFeatureAsync with plugins, discriminators, and multiple named connections via forRootAsync", async () => {
      @Schema({ discriminatorKey: "kind" })
      class Event {
        @Prop({ required: true })
        message!: string;
      }
      const EventSchema = SchemaFactory.createForClass(Event);

      @Schema()
      class ClickEvent {
        @Prop({ required: true })
        url!: string;
      }
      const ClickEventSchema = SchemaFactory.createForClass(ClickEvent);

      @Schema()
      class SignUpEvent {
        @Prop({ required: true })
        email!: string;
      }
      const SignUpEventSchema = SchemaFactory.createForClass(SignUpEvent);

      const PLUGIN_PREFIX = "PLUGIN_PREFIX";
      let pluginApplied = false;

      @Injectable()
      class AnalyticsConfigService implements MongooseOptionsFactory {
        createMongooseOptions(): MongooseModuleOptions {
          return {
            uri: "memory://localhost/analytics_db",
            connectionFactory: (conn: MongooseConnection) => {
              conn.plugin((schema) => {
                schema.add({ trackedBy: { type: String, default: "analytics" } });
              });
              return conn;
            },
          };
        }
      }

      @Module({
        providers: [{ provide: PLUGIN_PREFIX, useValue: "[evt] " }],
        exports: [PLUGIN_PREFIX],
      })
      class PrefixModule {}

      @Injectable()
      class EventsService {
        constructor(
          @InjectModel(Event.name, "analytics")
          readonly eventModel: MongooseModel<Event & { trackedBy?: string }>,
          @InjectModel(ClickEvent.name, "analytics")
          readonly clickModel: MongooseModel<Event & ClickEvent & { trackedBy?: string }>,
          @InjectModel(SignUpEvent.name, "analytics")
          readonly signUpModel: MongooseModel<Event & SignUpEvent & { trackedBy?: string }>,
          @InjectConnection("analytics")
          readonly analyticsConn: MongooseConnection,
          @InjectConnection("primary")
          readonly primaryConn: MongooseConnection,
        ) {}
      }

      @Module({
        imports: [
          MongooseModule.forRootAsync({
            connectionName: "primary",
            useFactory: async () => ({
              uri: "memory://localhost/primary_db",
            }),
          }),
          MongooseModule.forRootAsync({
            connectionName: "analytics",
            useClass: AnalyticsConfigService,
          }),
          MongooseModule.forFeatureAsync(
            [
              {
                name: Event.name,
                imports: [PrefixModule],
                inject: [PLUGIN_PREFIX],
                useFactory: async (prefix: string) => {
                  const s = EventSchema.clone();
                  s.plugin((schema) => {
                    pluginApplied = true;
                    schema.pre("save", function (this: any) {
                      if (typeof this.message === "string" && !this.message.startsWith(prefix)) {
                        this.message = `${prefix}${this.message}`;
                      }
                    });
                  });
                  return s;
                },
                discriminators: [
                  { name: ClickEvent.name, schema: ClickEventSchema, value: "click" },
                  { name: SignUpEvent.name, schema: SignUpEventSchema, value: "signup" },
                ],
              },
            ],
            "analytics",
          ),
        ],
        providers: [EventsService],
      })
      class MultiConnAppModule {}

      const app = await BunestFactory.createApplicationContext(MultiConnAppModule);
      const svc = app.get(EventsService);

      expect(pluginApplied).toBe(true);
      expect(svc.primaryConn.name).toBe("primary_db");
      expect(svc.analyticsConn.name).toBe("analytics_db");

      const clickDoc = await svc.clickModel.create({
        message: "button clicked",
        url: "https://bunest.dev",
      });
      const signUpDoc = await svc.signUpModel.create({
        message: "user joined",
        email: "dev@bunest.dev",
      });

      expect(clickDoc.message).toBe("[evt] button clicked");
      expect((clickDoc as any).kind).toBe("click");
      expect(clickDoc.trackedBy).toBe("analytics");
      expect(signUpDoc.message).toBe("[evt] user joined");
      expect((signUpDoc as any).kind).toBe("signup");

      // Base model queries all discriminators; child model filters by discriminator key
      expect(await svc.eventModel.countDocuments()).toBe(2);
      expect(await svc.clickModel.countDocuments()).toBe(1);
      expect(await svc.signUpModel.countDocuments()).toBe(1);

      await app.close();
      expect(svc.primaryConn.readyState).toBe(0);
      expect(svc.analyticsConn.readyState).toBe(0);
    });

    it("supports handleRetry (Promise-only) and connectionErrorFactory on failures", async () => {
      let attempts = 0;
      const retry = handleRetry(3, 5, false);
      const result = await retry(async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("transient failure");
        }
        return "connected";
      });
      expect(result).toBe("connected");
      expect(attempts).toBe(3);

      let failCount = 0;
      @Module({
        imports: [
          MongooseModule.forRoot("memory://localhost/fail_test", {
            retryAttempts: 2,
            retryDelay: 5,
            connectionFactory: () => {
              failCount += 1;
              throw new Error("boom");
            },
            connectionErrorFactory: (err) =>
              new MongooseError(`wrapped:${err.message}`),
          }),
        ],
      })
      class FailingModule {}

      await expect(
        BunestFactory.createApplicationContext(FailingModule, { logger: false }),
      ).rejects.toThrow("wrapped:boom");
      expect(failCount).toBe(2);
    });

    it("supports lazyConnection and useExisting in forRootAsync", async () => {
      @Injectable()
      class SharedConfig implements MongooseOptionsFactory {
        createMongooseOptions(): MongooseModuleOptions {
          return {
            uri: "memory://localhost/lazy_db",
            lazyConnection: true,
          };
        }
      }

      @Module({
        providers: [SharedConfig],
        exports: [SharedConfig],
      })
      class ConfigModule {}

      @Injectable()
      class Consumer {
        constructor(
          @InjectConnection() readonly conn: MongooseConnection,
        ) {}
      }

      @Module({
        imports: [
          MongooseModule.forRootAsync({
            imports: [ConfigModule],
            useExisting: SharedConfig,
          }),
        ],
        providers: [Consumer],
      })
      class LazyAppModule {}

      const app = await BunestFactory.createApplicationContext(LazyAppModule);
      const consumer = app.get(Consumer);
      // lazyConnection returns before asPromise() sets readyState = 1
      expect(consumer.conn.readyState).toBe(2);
      await consumer.conn.asPromise();
      expect(consumer.conn.readyState).toBe(1);
      await app.close();
    });
  });
});
