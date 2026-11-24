import { describe, expect, it } from "bun:test";
import {
  Accessors,
  Builder,
  Data,
  Delegate,
  EqualsAndHashCode,
  FieldDefaults,
  FieldNameConstants,
  Getter,
  JsonSerializable,
  Locked,
  LogExecution,
  Logger,
  Memoize,
  NonFinal,
  NonNull,
  Secret,
  Setter,
  Singular,
  StandardException,
  SuperBuilder,
  Synchronized,
  ToString,
  UtilityClass,
  Value,
  With,
  WithBy,
  WithLogger,
  clearMemoizeCache,
} from "../../src/common";

describe("Bunest Class Macros (@bunest/common)", () => {
  it("@Data + @Secret + @Builder + @Singular + @Builder.Default + @FieldNameConstants", () => {
    @Data()
    @Builder({ toBuilder: true })
    @FieldNameConstants()
    class User {
      id!: number;
      email!: string;
      @Builder.Default(18)
      age!: number;
      @Secret()
      password!: string;
      @Singular()
      tags!: string[];
    }

    const UserApi = User as unknown as {
      builder(): any;
      of(p: Record<string, unknown>): any;
      fromJSON(raw: unknown): any;
      Fields: Record<string, string>;
    };

    const u1 = UserApi.builder()
      .id(1)
      .email("alice@bunest.dev")
      .password("s3cr3t")
      .tag("admin")
      .tag("founder")
      .build();

    expect(u1).toBeInstanceOf(User);
    expect(u1.age).toBe(18);
    expect(u1.tags).toEqual(["admin", "founder"]);
    expect(u1.getEmail()).toBe("alice@bunest.dev");
    expect(u1.toString()).toContain("password=***");
    expect(u1.toString()).not.toContain("s3cr3t");
    expect(u1.toJSON().password).toBeUndefined();
    expect(u1.toJSON().email).toBe("alice@bunest.dev");

    // Immutable with() + toBuilder() + clearTags()
    const u2 = u1.with({ age: 25 });
    expect(u2.age).toBe(25);
    expect(u1.age).toBe(18);
    expect(u1.equals(u2)).toBe(false);

    const u3 = u1.toBuilder().clearTags().tag("member").build();
    expect(u3.tags).toEqual(["member"]);
    expect(u1.tags).toEqual(["admin", "founder"]);

    // Structural equality + hashCode
    const u1Clone = u1.clone();
    expect(u1.equals(u1Clone)).toBe(true);
    expect(u1.hashCode()).toBe(u1Clone.hashCode());

    // @FieldNameConstants Proxy fallback for stripped fields
    expect(UserApi.Fields.email).toBe("email");
    expect(UserApi.Fields.tags).toBe("tags");

    // fromJSON routes through builder
    const fromJson = UserApi.fromJSON(
      JSON.stringify({ id: 2, email: "bob@bunest.dev", tags: ["ops"] }),
    );
    expect(fromJson.age).toBe(18);
    expect(fromJson.tags).toEqual(["ops"]);
  });

  it("@Value creates frozen immutable objects without setters & supports @WithBy", () => {
    @Value()
    @WithBy()
    class Money {
      amount!: number;
      currency!: string;
    }

    const MoneyApi = Money as unknown as { of(p: Record<string, unknown>): any };
    const m1 = MoneyApi.of({ amount: 100, currency: "USD" });
    expect(Object.isFrozen(m1)).toBe(true);
    expect(m1.getAmount()).toBe(100);
    expect(m1.setAmount).toBeUndefined();

    const m2 = m1.withAmountBy((n: number) => n + 50);
    expect(m2.amount).toBe(150);
    expect(m1.amount).toBe(100);
    expect(Object.isFrozen(m2)).toBe(true);
  });

  it("@SuperBuilder supports class inheritance", () => {
    @SuperBuilder()
    class BaseEntity {
      @Builder.Default("active")
      status!: string;
      id!: number;
    }

    @SuperBuilder()
    class AdminEntity extends BaseEntity {
      role!: string;
    }

    const admin = (AdminEntity as any)
      .builder()
      .id(7)
      .role("superadmin")
      .build();
    expect(admin).toBeInstanceOf(AdminEntity);
    expect(admin).toBeInstanceOf(BaseEntity);
    expect(admin.id).toBe(7);
    expect(admin.status).toBe("active");
    expect(admin.role).toBe("superadmin");
  });

  it("@Accessors fluent + prefix + @Getter/@Setter + @Tolerate non-override", () => {
    @Accessors({ fluent: true, chain: true, prefix: "_" })
    @Getter({ fields: ["_name"] })
    @Setter({ fields: ["_name"] })
    class Profile {
      _name = "init";
      // Explicit user method must never be overwritten (@Tolerate default)
      custom = () => "kept";
    }

    const p = new Profile() as any;
    expect(p.name()).toBe("init");
    expect(p.name("updated")).toBe(p);
    expect(p.name()).toBe("updated");
    expect(p.custom()).toBe("kept");
  });

  it("@WithLogger attaches lazy non-enumerable Logger bound to class name", () => {
    @WithLogger()
    class OrderService {
      name = "orders";
    }

    const svc = new OrderService() as any;
    expect(svc.logger).toBeInstanceOf(Logger);
    expect(svc.logger).toBe(svc.logger);
    expect(Object.keys(svc)).toEqual(["name"]);
  });

  it("@Memoize caches sync & async methods and evicts rejected promises", async () => {
    let syncCalls = 0;
    let asyncCalls = 0;

    class Calc {
      @Memoize()
      expensive(x: number): number {
        syncCalls++;
        return x * 10;
      }

      @Memoize()
      async flaky(shouldFail: boolean): Promise<string> {
        asyncCalls++;
        if (shouldFail) throw new Error("boom");
        return "ok";
      }
    }

    const c = new Calc();
    expect(c.expensive(3)).toBe(30);
    expect(c.expensive(3)).toBe(30);
    expect(syncCalls).toBe(1);

    clearMemoizeCache(c, "expensive");
    expect(c.expensive(3)).toBe(30);
    expect(syncCalls).toBe(2);

    await expect(c.flaky(true)).rejects.toThrow("boom");
    await expect(c.flaky(true)).rejects.toThrow("boom");
    expect(asyncCalls).toBe(2); // rejected promise was evicted!
    expect(await c.flaky(false)).toBe("ok");
    expect(await c.flaky(false)).toBe("ok");
    expect(asyncCalls).toBe(3);
  });

  it("@NonNull enforces non-null on method parameters and model fields", () => {
    @Data()
    class Account {
      @NonNull()
      email!: string;

      greet(@NonNull() name: string): string {
        return `hi ${name}`;
      }
    }

    expect(() => (Account as any).of({ email: null })).toThrow(TypeError);
    const acc = (Account as any).of({ email: "a@b.com" });
    expect(acc.greet("Tuan")).toBe("hi Tuan");
    expect(() => acc.greet(undefined)).toThrow(TypeError);
  });

  it("@Synchronized serializes concurrent async calls in FIFO order", async () => {
    const timeline: string[] = [];

    class Counter {
      @Synchronized()
      async work(label: string, delayMs: number): Promise<string> {
        timeline.push(`start:${label}`);
        await new Promise((r) => setTimeout(r, delayMs));
        timeline.push(`end:${label}`);
        return label;
      }
    }

    const counter = new Counter();
    await Promise.all([counter.work("A", 20), counter.work("B", 5)]);
    expect(timeline).toEqual(["start:A", "end:A", "start:B", "end:B"]);
  });

  it("@Locked.Read allows concurrent readers and @Locked.Write is exclusive", async () => {
    let activeReaders = 0;
    let maxConcurrentReaders = 0;
    let writerSawReaders = false;

    class Store {
      @Locked.Read()
      async read(): Promise<void> {
        activeReaders++;
        maxConcurrentReaders = Math.max(maxConcurrentReaders, activeReaders);
        await new Promise((r) => setTimeout(r, 15));
        activeReaders--;
      }

      @Locked.Write()
      async write(): Promise<void> {
        if (activeReaders > 0) writerSawReaders = true;
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    const s = new Store();
    await Promise.all([s.read(), s.read(), s.write(), s.read()]);
    expect(maxConcurrentReaders).toBeGreaterThanOrEqual(2);
    expect(writerSawReaders).toBe(false);
  });

  it("@Delegate forwards methods from composed field without overriding own methods", () => {
    class Engine {
      start(mode: string): string {
        return `engine:${mode}`;
      }
      stop(): string {
        return "engine:stop";
      }
    }

    class Car {
      @Delegate({ target: Engine })
      private readonly engine = new Engine();

      stop(): string {
        return "car:custom-stop";
      }
    }

    const car = new Car() as any;
    expect(car.start("sport")).toBe("engine:sport");
    expect(car.stop()).toBe("car:custom-stop");
  });

  it("@StandardException, @UtilityClass, @FieldDefaults, @NonFinal, @JsonSerializable, @LogExecution", () => {
    @StandardException({ code: "E_DOMAIN", statusCode: 422 })
    class DomainError extends Error {}

    const cause = new Error("root");
    const err = (DomainError as any).from("invalid state", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.name).toBe("DomainError");
    expect(err.code).toBe("E_DOMAIN");
    expect(err.statusCode).toBe(422);
    expect(err.cause).toBe(cause);

    @UtilityClass()
    class MathHelpers {
      static double(x: number): number {
        return x * 2;
      }
    }
    expect(MathHelpers.double(4)).toBe(8);
    expect(() => new MathHelpers()).toThrow(TypeError);

    @FieldDefaults({ readonly: true })
    @Data()
    class RecordItem {
      id!: number;
      @NonFinal()
      note!: string;
    }
    const item = (RecordItem as any).of({ id: 1, note: "a" });
    item.note = "b";
    expect(item.note).toBe("b");
    expect(() => {
      item.id = 2;
    }).toThrow();

    @JsonSerializable()
    @ToString({ exclude: ["hidden"] })
    @EqualsAndHashCode({ exclude: ["hidden"] })
    class Payload {
      id = 1;
      @Secret()
      apiKey = "secret-key";
      hidden = "x";
    }
    const p1 = new Payload() as any;
    const p2 = new Payload() as any;
    p2.hidden = "y";
    expect(p1.equals(p2)).toBe(true);
    expect(p1.toJSON()).toEqual({ id: 1, hidden: "x" });

    const logged: string[] = [];
    class LoggedSvc {
      logger = new Logger("LoggedSvc", {
        writer: (line) => logged.push(line),
      });
      @LogExecution({ level: "log", logResult: true })
      compute(a: number, b: number): number {
        return a + b;
      }
    }
    const ls = new LoggedSvc();
    expect(ls.compute(2, 3)).toBe(5);
    expect(logged.some((l) => l.includes("LoggedSvc.compute"))).toBe(true);
  });
});
