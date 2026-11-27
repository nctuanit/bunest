import { describe, expect, it } from "bun:test";
import { Injectable, Module, diagnosticsChannel } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  Column,
  DataSource,
  DrizzleModule,
  DrizzleTransactionHost,
  DrizzleTransactional,
  Entity,
  InjectDrizzle,
  InjectDrizzleTransactionHost,
  InjectPrisma,
  InjectPrismaTransactionHost,
  ManyToOne,
  MorphMany,
  MorphTo,
  ORM_TRANSACTION_CHANNEL,
  PrimaryGeneratedColumn,
  PrismaModule,
  PrismaTransactionHost,
  PrismaTransactional,
  TransactionPropagationError,
  Transactional,
  onTransactionCommit,
  onTransactionRollback,
  type DrizzleDatabaseLike,
  type DrizzleTransactionConfig,
  type OrmTransactionDiagnosticEvent,
  type PrismaClientLike,
  type PrismaInteractiveTransactionOptions,
} from "../src/index";

// ============================================================================
// Polymorphic Relations Fixtures (`@MorphTo` & `@MorphMany`)
// ============================================================================

@Entity("morph_authors")
class MorphAuthor {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;
}

@Entity("morph_posts")
class MorphPost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @ManyToOne(() => MorphAuthor)
  author?: MorphAuthor | null;

  @MorphMany(() => MorphComment, "commentable", { cascade: true })
  comments?: MorphComment[];
}

@Entity("morph_videos")
class MorphVideo {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  url!: string;

  @ManyToOne(() => MorphAuthor)
  author?: MorphAuthor | null;

  @MorphMany(() => MorphComment, "commentable")
  comments?: MorphComment[];
}

@Entity("morph_comments")
class MorphComment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  body!: string;

  @MorphTo({
    post: () => MorphPost,
    video: () => MorphVideo,
  })
  commentable?: MorphPost | MorphVideo | null;
}

// Array-form `@MorphTo` with explicit columns + mutual eager test
@Entity("morph_articles")
class MorphArticle {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  headline!: string;

  @MorphMany(() => MorphTagging, "taggable", { eager: true })
  taggings?: MorphTagging[];
}

@Entity("morph_taggings")
class MorphTagging {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  tag!: string;

  @Column()
  taggableType!: string;

  @Column("integer")
  taggableId!: number;

  @MorphTo([() => MorphArticle], { eager: true })
  taggable?: MorphArticle | null;
}

describe("@bunest/orm — Polymorphic Relations (@MorphTo / @MorphMany)", () => {
  it("hydrates @MorphTo and @MorphMany using batched IN (...) queries with ZERO N+1 queries", async () => {
    const executedSql: string[] = [];
    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [MorphAuthor, MorphPost, MorphVideo, MorphComment],
      synchronize: true,
      logging: (ev) => {
        executedSql.push(ev.sql);
      },
    });
    await ds.initialize();

    try {
      const authorRepo = ds.getRepository(MorphAuthor);
      const postRepo = ds.getRepository(MorphPost);
      const videoRepo = ds.getRepository(MorphVideo);
      const commentRepo = ds.getRepository(MorphComment);

      const alice = await authorRepo.save({ name: "Alice" });
      const bob = await authorRepo.save({ name: "Bob" });

      // Save 3 posts (with cascade @MorphMany comments on p1!)
      const p1 = await postRepo.save({
        title: "Post 1",
        author: alice,
        comments: [{ body: "p1-c1" }, { body: "p1-c2" }],
      });
      const p2 = await postRepo.save({ title: "Post 2", author: bob });
      const p3 = await postRepo.save({ title: "Post 3", author: alice });

      // Save 3 videos (note: SQLite IDs 1, 2, 3 overlap with Post IDs 1, 2, 3 — testing discriminator isolation!)
      const v1 = await videoRepo.save({ url: "https://v.test/1", author: bob });
      const v2 = await videoRepo.save({ url: "https://v.test/2", author: alice });
      const v3 = await videoRepo.save({ url: "https://v.test/3", author: bob });

      // Save remaining comments across posts, videos, and one null commentable
      await commentRepo.save([
        { body: "p2-c1", commentable: p2 },
        { body: "p2-c2", commentable: p2 },
        { body: "p3-c1", commentable: p3 },
        { body: "p3-c2", commentable: p3 },
        { body: "v1-c1", commentable: v1 },
        { body: "v1-c2", commentable: v1 },
        { body: "v2-c1", commentable: v2 },
        { body: "v2-c2", commentable: v2 },
        { body: "v3-c1", commentable: v3 },
        { body: "v3-c2", commentable: v3 },
        { body: "orphan", commentable: null },
      ]);

      // 1. Batched @MorphTo loading for 13 comments across 2 concrete target types:
      // MUST execute EXACTLY 3 queries: 1 comments + 1 batched posts IN (...) + 1 batched videos IN (...)!
      executedSql.length = 0;
      const allComments = await commentRepo.find({
        relations: ["commentable"],
        order: { id: "ASC" },
      });

      expect(allComments.length).toBe(13);
      expect(executedSql.length).toBe(3);
      expect(executedSql[1]).toContain('FROM "morph_posts"');
      expect(executedSql[1]).toContain("IN (");
      expect(executedSql[2]).toContain('FROM "morph_videos"');
      expect(executedSql[2]).toContain("IN (");

      const postComments = allComments.filter((c) => c.body.startsWith("p"));
      const videoComments = allComments.filter((c) => c.body.startsWith("v"));
      const orphan = allComments.find((c) => c.body === "orphan")!;

      expect(postComments.length).toBe(6);
      for (const c of postComments) {
        expect(c.commentable).toBeInstanceOf(MorphPost);
      }
      // Shared IdentityMap instance across multiple comments pointing to the same Post!
      expect(postComments[0]!.commentable).toBe(postComments[1]!.commentable);
      expect((postComments[0]!.commentable as MorphPost).title).toBe("Post 1");

      expect(videoComments.length).toBe(6);
      for (const c of videoComments) {
        expect(c.commentable).toBeInstanceOf(MorphVideo);
      }
      expect(videoComments[0]!.commentable).toBe(videoComments[1]!.commentable);
      expect((videoComments[0]!.commentable as MorphVideo).url).toBe(
        "https://v.test/1",
      );
      expect(orphan.commentable).toBeNull();

      // 2. Nested relation loading across polymorphic targets (`commentable.author`)
      executedSql.length = 0;
      const withAuthors = await commentRepo.find({
        relations: { commentable: { author: true } },
        order: { id: "ASC" },
      });
      // 1 comments + 1 posts + 1 videos + 1 batched authors (Posts) + 0/1 authors (Videos cached in IdentityMap!)
      expect(executedSql.length).toBeLessThanOrEqual(4);
      expect(
        (withAuthors[0]!.commentable as MorphPost).author?.name,
      ).toBe("Alice");
      expect(
        (withAuthors.find((c) => c.body === "v1-c1")!.commentable as MorphVideo)
          .author?.name,
      ).toBe("Bob");

      // 3. Batched @MorphMany loading for 3 Posts:
      // MUST execute EXACTLY 2 queries: 1 posts + 1 batched comments WHERE commentable_type = ? AND commentable_id IN (...)!
      executedSql.length = 0;
      const posts = await postRepo.find({
        relations: ["comments"],
        order: { id: "ASC" },
      });
      expect(posts.length).toBe(3);
      expect(executedSql.length).toBe(2);
      expect(executedSql[1]).toContain('"commentable_type" = ?');
      expect(executedSql[1]).toContain('"commentable_id" IN (');

      expect(posts[0]!.comments?.map((c) => c.body)).toEqual(["p1-c1", "p1-c2"]);
      expect(posts[1]!.comments?.map((c) => c.body)).toEqual(["p2-c1", "p2-c2"]);
      expect(posts[2]!.comments?.map((c) => c.body)).toEqual(["p3-c1", "p3-c2"]);

      // 4. Partial update on a comment preserves shadow polymorphic FK columns
      const loadedOne = await commentRepo.findOneByOrFail({ id: allComments[0]!.id });
      loadedOne.body = "p1-c1-edited";
      await commentRepo.save(loadedOne);
      const reloaded = await commentRepo.findOneOrFail({
        where: { id: loadedOne.id },
        relations: ["commentable"],
      });
      expect(reloaded.body).toBe("p1-c1-edited");
      expect(reloaded.commentable).toBeInstanceOf(MorphPost);
      expect((reloaded.commentable as MorphPost).id).toBe(p1.id);

      // 5. Filtering parent entities via @MorphMany `where` subquery
      const postsWithEditedComment = await postRepo.find({
        where: { comments: { body: "p1-c1-edited" } },
      });
      expect(postsWithEditedComment.map((p) => p.title)).toEqual(["Post 1"]);
    } finally {
      await ds.destroy();
    }
  });

  it("supports array-form @MorphTo with explicit columns and cycle-safe mutual eager loading", async () => {
    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [MorphArticle, MorphTagging],
      synchronize: true,
    });
    await ds.initialize();
    try {
      const articleRepo = ds.getRepository(MorphArticle);
      const tagRepo = ds.getRepository(MorphTagging);

      const art = await articleRepo.save({ headline: "Bunest Polymorphic" });
      await tagRepo.save({
        tag: "orm",
        taggableType: "MorphArticle",
        taggableId: art.id,
      });

      // Mutual eager:true must NOT infinite-loop and preserves live IdentityMap references!
      const loaded = await articleRepo.findOneByOrFail({ id: art.id });
      expect(loaded.taggings?.length).toBe(1);
      expect(loaded.taggings?.[0]?.tag).toBe("orm");
      expect(loaded.taggings?.[0]?.taggable).toBe(loaded);
    } finally {
      await ds.destroy();
    }
  });
});

// ============================================================================
// First-Class Zero-Dep `DrizzleModule` & `PrismaModule`
// ============================================================================

interface MockDrizzleDb extends DrizzleDatabaseLike<MockDrizzleDb> {
  readonly id: string;
  readonly log: string[];
  readonly configs: Array<DrizzleTransactionConfig | undefined>;
  insertRow(val: string): void;
}

function createMockDrizzleDb(
  id = "root",
  shared?: {
    log: string[];
    configs: Array<DrizzleTransactionConfig | undefined>;
    rows: string[];
    txSeq: { n: number };
    failNext?: Error | null;
  },
): MockDrizzleDb & { readonly committedRows: string[] } {
  const state = shared ?? {
    log: [],
    configs: [],
    rows: [],
    txSeq: { n: 0 },
    failNext: null,
  };

  const makeHandle = (
    handleId: string,
    staging: string[] | null,
    isRoot: boolean,
  ): MockDrizzleDb => ({
    id: handleId,
    log: state.log,
    configs: state.configs,
    insertRow(val: string) {
      state.log.push(`${handleId}:insert:${val}`);
      if (staging) {
        staging.push(val);
      } else {
        state.rows.push(val);
      }
    },
    async transaction<T>(
      fn: (tx: MockDrizzleDb) => Promise<T>,
      config?: DrizzleTransactionConfig,
    ): Promise<T> {
      const txNum = ++state.txSeq.n;
      const nextId = isRoot ? `tx#${txNum}` : `${handleId}.sp#${txNum}`;
      state.log.push(`begin:${nextId}`);
      state.configs.push(config);
      const localStaging: string[] = [];
      const txHandle = makeHandle(nextId, localStaging, false);
      try {
        if (state.failNext) {
          const err = state.failNext;
          state.failNext = null;
          throw err;
        }
        const res = await fn(txHandle);
        if (staging) {
          staging.push(...localStaging);
        } else {
          state.rows.push(...localStaging);
        }
        state.log.push(`commit:${nextId}`);
        return res;
      } catch (err) {
        state.log.push(`rollback:${nextId}`);
        throw err;
      }
    },
  });

  const root = makeHandle(id, null, true);
  return Object.assign(root, {
    get committedRows() {
      return state.rows;
    },
  });
}

interface MockPrismaTx {
  readonly txId: string;
  createUser(name: string): void;
}

interface MockPrismaClient extends PrismaClientLike<MockPrismaTx> {
  readonly txId: string;
  readonly log: string[];
  readonly txOptionsSeen: Array<PrismaInteractiveTransactionOptions | undefined>;
  readonly committedUsers: string[];
  connected: boolean;
  disconnected: boolean;
  createUser(name: string): void;
  setTransientFailures(count: number): void;
}

function createMockPrismaClient(): MockPrismaClient {
  const log: string[] = [];
  const txOptionsSeen: Array<PrismaInteractiveTransactionOptions | undefined> = [];
  const committedUsers: string[] = [];
  let txSeq = 0;
  let transientFailures = 0;

  const client: MockPrismaClient = {
    txId: "root",
    log,
    txOptionsSeen,
    committedUsers,
    connected: false,
    disconnected: false,
    setTransientFailures(count: number) {
      transientFailures = count;
    },
    async $connect() {
      client.connected = true;
      log.push("$connect");
    },
    async $disconnect() {
      client.disconnected = true;
      log.push("$disconnect");
    },
    createUser(name: string) {
      log.push(`root:create:${name}`);
      committedUsers.push(name);
    },
    async $transaction<T>(
      fn: (tx: MockPrismaTx) => Promise<T>,
      options?: PrismaInteractiveTransactionOptions,
    ): Promise<T> {
      const txId = `ptx#${++txSeq}`;
      log.push(`begin:${txId}`);
      txOptionsSeen.push(options);
      const staged: string[] = [];
      const tx: MockPrismaTx = {
        txId,
        createUser(name: string) {
          log.push(`${txId}:create:${name}`);
          staged.push(name);
        },
      };
      try {
        const res = await fn(tx);
        if (transientFailures > 0) {
          transientFailures -= 1;
          throw Object.assign(new Error("could not serialize access"), {
            code: "40001",
          });
        }
        committedUsers.push(...staged);
        log.push(`commit:${txId}`);
        return res;
      } catch (err) {
        log.push(`rollback:${txId}`);
        throw err;
      }
    },
  };

  return client;
}

describe("@bunest/orm — Zero-Dep DrizzleModule & PrismaModule", () => {
  it("provides DrizzleModule.forRoot, ALS DrizzleTransactionHost, nested savepoints, REQUIRES_NEW, hooks, and @DrizzleTransactional / @Transactional", async () => {
    const mockDb = createMockDrizzleDb();
    let shutdownCalled = false;
    const hookLog: string[] = [];
    const txEvents: OrmTransactionDiagnosticEvent[] = [];
    const txCh = diagnosticsChannel(ORM_TRANSACTION_CHANNEL);
    const listener = (msg: unknown) =>
      txEvents.push(msg as OrmTransactionDiagnosticEvent);
    txCh.subscribe(listener);

    @Injectable()
    class OrdersService {
      constructor(
        @InjectDrizzle()
        public readonly rawDb: MockDrizzleDb,
        public readonly txHost: DrizzleTransactionHost<MockDrizzleDb>,
      ) {}

      @DrizzleTransactional({ isolationLevel: "SERIALIZABLE", readOnly: false })
      async placeOrder(item: string): Promise<string> {
        expect(this.txHost.isInTransaction()).toBe(true);
        const active = this.txHost.getDb();
        expect(active.id).not.toBe("root");
        active.insertRow(item);
        onTransactionCommit(() => {
          expect(this.txHost.isInTransaction()).toBe(false);
          hookLog.push(`outer-commit:${item}`);
        });

        await this.nestedLineItem(`${item}:line1`);
        return active.id;
      }

      @DrizzleTransactional({ propagation: "REQUIRED" })
      async nestedLineItem(line: string): Promise<void> {
        const active = this.txHost.getDb();
        expect(active.id).toContain(".sp#");
        active.insertRow(line);
        onTransactionCommit(() => {
          hookLog.push(`nested-commit:${line}`);
        });
      }

      @DrizzleTransactional({ propagation: "REQUIRES_NEW" })
      async writeAuditLog(entry: string): Promise<string> {
        const active = this.txHost.getDb();
        active.insertRow(`audit:${entry}`);
        onTransactionCommit(() => {
          // Must run outside BOTH inner REQUIRES_NEW and suspended outer tx!
          expect(this.txHost.isInTransaction()).toBe(false);
          expect(this.txHost.getDb()).toBe(this.rawDb);
          hookLog.push(`audit-commit:${entry}`);
        });
        return active.id;
      }

      @Transactional({ isolationLevel: "READ COMMITTED" })
      async plainTransactionalMethod(val: string): Promise<string> {
        const active = this.txHost.getDb();
        active.insertRow(val);
        return active.id;
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        DrizzleModule.forRoot({
          db: mockDb,
          bindTransactional: true,
          onShutdown: () => {
            shutdownCalled = true;
          },
        }),
      ],
      providers: [OrdersService],
    }).compile();

    await mod.init();
    try {
      const svc = mod.get(OrdersService);
      expect(svc.rawDb).toBe(mockDb);
      expect(svc.txHost.getDb()).toBe(mockDb);
      expect(svc.txHost.isInTransaction()).toBe(false);

      // 1. Nested @DrizzleTransactional + savepoint + commit hooks
      const txId = await svc.placeOrder("ord-1");
      expect(txId).toBe("tx#1");
      expect(mockDb.committedRows).toEqual(["ord-1", "ord-1:line1"]);
      expect(mockDb.configs[0]).toEqual({ isolationLevel: "serializable" });
      expect(hookLog).toEqual(["outer-commit:ord-1", "nested-commit:ord-1:line1"]);

      // 2. REQUIRES_NEW commits independently even when outer rolls back!
      hookLog.length = 0;
      await expect(
        svc.txHost.withTransaction(async (tx) => {
          tx.insertRow("outer-aborted");
          onTransactionRollback(() => {
            hookLog.push("outer-rolled-back");
          });
          const auditTxId = await svc.writeAuditLog("failed-attempt");
          expect(auditTxId).not.toBe(tx.id);
          expect(auditTxId).not.toContain(".sp#");
          throw new Error("outer-fail");
        }),
      ).rejects.toThrow("outer-fail");

      expect(mockDb.committedRows).toContain("audit:failed-attempt");
      expect(mockDb.committedRows).not.toContain("outer-aborted");
      expect(hookLog).toEqual([
        "audit-commit:failed-attempt",
        "outer-rolled-back",
      ]);

      // 3. Plain @Transactional() works via bindTransactional: true
      const plainTxId = await svc.plainTransactionalMethod("via-transactional");
      expect(plainTxId).toMatch(/^tx#/);
      expect(mockDb.committedRows).toContain("via-transactional");

      // 4. MANDATORY & NEVER enforcement
      await expect(
        svc.txHost.withTransaction(() => {}, { propagation: "MANDATORY" }),
      ).rejects.toThrow(TransactionPropagationError);
      await expect(
        svc.txHost.withTransaction(
          () => svc.txHost.withTransaction(() => {}, { propagation: "NEVER" }),
        ),
      ).rejects.toThrow(TransactionPropagationError);

      // 5. Diagnostics events fired for Drizzle transactions
      expect(txEvents.some((e) => e.dataSource === "drizzle:default" && e.phase === "commit")).toBe(true);
      expect(txEvents.some((e) => e.dataSource === "drizzle:default" && e.phase === "rollback")).toBe(true);
    } finally {
      txCh.unsubscribe(listener);
      await mod.close();
      expect(shutdownCalled).toBe(true);
    }
  });

  it("supports DrizzleModule.forRootAsync and named tokens", async () => {
    const analyticsDb = createMockDrizzleDb("analytics");

    @Injectable()
    class AnalyticsService {
      constructor(
        @InjectDrizzle("analytics")
        public readonly db: MockDrizzleDb,
        @InjectDrizzleTransactionHost("analytics")
        public readonly host: DrizzleTransactionHost<MockDrizzleDb>,
      ) {}

      @DrizzleTransactional({ token: "analytics", readOnly: true })
      async runReport(): Promise<string> {
        return this.host.getDb().id;
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        DrizzleModule.forRootAsync({
          token: "analytics",
          useFactory: async () => analyticsDb,
        }),
      ],
      providers: [AnalyticsService],
    }).compile();

    await mod.init();
    try {
      const svc = mod.get(AnalyticsService);
      expect(svc.db).toBe(analyticsDb);
      const txId = await svc.runReport();
      expect(txId).toBe("tx#1");
      expect(analyticsDb.configs[0]).toEqual({ accessMode: "read only" });
    } finally {
      await mod.close();
    }
  });

  it("provides PrismaModule.forRoot & forRootAsync, ALS interactive $transaction propagation, retries, isolation mapping, and lifecycle hooks", async () => {
    const primaryClient = createMockPrismaClient();
    const reportingClient = createMockPrismaClient();
    const hookLog: string[] = [];

    @Module({
      providers: [{ provide: "REPORTING_PRISMA", useValue: reportingClient }],
      exports: ["REPORTING_PRISMA"],
    })
    class ReportingConfigMod {}

    @Injectable()
    class UsersPrismaService {
      constructor(
        @InjectPrisma()
        public readonly rawClient: MockPrismaClient,
        public readonly txHost: PrismaTransactionHost<MockPrismaClient>,
        @InjectPrisma("reporting")
        public readonly reportingRaw: MockPrismaClient,
        @InjectPrismaTransactionHost("reporting")
        public readonly reportingHost: PrismaTransactionHost<MockPrismaClient>,
      ) {}

      @PrismaTransactional({
        isolationLevel: "SERIALIZABLE",
        maxWait: 2000,
        timeout: 5000,
      })
      async createAccountWithProfile(name: string): Promise<string> {
        const active = this.txHost.getClient();
        expect(this.txHost.isInTransaction()).toBe(true);
        active.createUser(name);
        onTransactionCommit(() => {
          expect(this.txHost.isInTransaction()).toBe(false);
          hookLog.push(`outer-commit:${name}`);
        });

        await this.nestedCreateAudit(`${name}:profile`);
        return this.txHost.getTx()!.txId;
      }

      @PrismaTransactional({ propagation: "REQUIRED" })
      async nestedCreateAudit(label: string): Promise<void> {
        // Reuses the exact outer interactive $transaction client!
        this.txHost.getClient().createUser(label);
        onTransactionCommit(() => {
          hookLog.push(`nested-commit:${label}`);
        });
      }

      @PrismaTransactional({ propagation: "REQUIRES_NEW" })
      async independentLog(label: string): Promise<string> {
        this.txHost.getClient().createUser(label);
        onTransactionCommit(() => {
          // Must run outside BOTH inner REQUIRES_NEW and suspended outer tx!
          expect(this.txHost.isInTransaction()).toBe(false);
          expect(this.txHost.getTx()).toBeUndefined();
          expect(this.txHost.getClient()).toBe(this.rawClient);
          hookLog.push(`independent-commit:${label}`);
        });
        return this.txHost.getTx()!.txId;
      }

      @Transactional({ isolationLevel: "REPEATABLE READ", retries: 2, retryDelayMs: 2 })
      async retryableViaTransactional(name: string): Promise<void> {
        this.txHost.getClient().createUser(name);
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        PrismaModule.forRoot({
          client: primaryClient,
          autoConnect: true,
          autoDisconnect: true,
          bindTransactional: true,
        }),
        PrismaModule.forRootAsync({
          token: "reporting",
          imports: [ReportingConfigMod],
          inject: ["REPORTING_PRISMA"],
          useFactory: (client: MockPrismaClient) => ({
            client,
            autoConnect: false,
            autoDisconnect: true,
          }),
        }),
      ],
      providers: [UsersPrismaService],
    }).compile();

    await mod.init();
    try {
      const svc = mod.get(UsersPrismaService);
      expect(primaryClient.connected).toBe(true);
      expect(reportingClient.connected).toBe(false);
      expect(svc.rawClient).toBe(primaryClient);
      expect(svc.reportingRaw).toBe(reportingClient);
      expect(svc.txHost.getClient()).toBe(primaryClient);

      // 1. Nested @PrismaTransactional reuses single interactive $transaction + maps isolationLevel to PascalCase
      const txId = await svc.createAccountWithProfile("alice");
      expect(txId).toBe("ptx#1");
      expect(primaryClient.committedUsers).toEqual(["alice", "alice:profile"]);
      expect(primaryClient.txOptionsSeen[0]).toEqual({
        isolationLevel: "Serializable",
        maxWait: 2000,
        timeout: 5000,
      });
      expect(hookLog).toEqual([
        "outer-commit:alice",
        "nested-commit:alice:profile",
      ]);

      // 2. REQUIRES_NEW opens an independent $transaction even if outer rolls back
      await expect(
        svc.txHost.withTransaction(async (outerTx) => {
          outerTx.createUser("outer-aborted");
          const innerTxId = await svc.independentLog("audit-independent");
          expect(innerTxId).not.toBe(outerTx.txId);
          throw new Error("rollback-outer-prisma");
        }),
      ).rejects.toThrow("rollback-outer-prisma");

      expect(primaryClient.committedUsers).toContain("audit-independent");
      expect(primaryClient.committedUsers).not.toContain("outer-aborted");
      expect(hookLog).toContain("independent-commit:audit-independent");

      // 3. Plain @Transactional() with retries retries transient 40001 and commits on retry
      primaryClient.setTransientFailures(1);
      await svc.retryableViaTransactional("bob-retried");
      expect(primaryClient.committedUsers).toContain("bob-retried");
      expect(
        primaryClient.txOptionsSeen[primaryClient.txOptionsSeen.length - 1],
      ).toEqual({
        isolationLevel: "RepeatableRead",
      });

      // 4. MANDATORY & NEVER enforcement
      await expect(
        svc.txHost.withTransaction(() => {}, { propagation: "MANDATORY" }),
      ).rejects.toThrow(TransactionPropagationError);
      await expect(
        svc.txHost.withTransaction(
          () => svc.txHost.withTransaction(() => {}, { propagation: "NEVER" }),
        ),
      ).rejects.toThrow(TransactionPropagationError);

      // 5. Named reporting host isolated from primary
      const repTxId = await svc.reportingHost.withTransaction((tx) => {
        tx.createUser("report-row");
        return tx.txId;
      });
      expect(repTxId).toBe("ptx#1");
      expect(reportingClient.committedUsers).toEqual(["report-row"]);
    } finally {
      await mod.close();
      expect(primaryClient.disconnected).toBe(true);
      expect(reportingClient.disconnected).toBe(true);
    }
  });
});
