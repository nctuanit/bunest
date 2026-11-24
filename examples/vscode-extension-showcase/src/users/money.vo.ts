import {
  Accessors,
  Builder,
  Getter,
  Setter,
  StandardException,
  SuperBuilder,
  UtilityClass,
  Value,
  WithBy,
} from "@bunest/core";

/**
 * Immutable Value Object (`@Value` + `@WithBy`):
 * 👉 Hover để xem `of()`, `getAmount()`, `with()`, `withAmountBy()`, `equals()` (không có setter!).
 */
@Value()
@WithBy()
export class Money {
  amount!: number;
  currency!: string;
}

/**
 * Inheritance Builder (`@SuperBuilder`):
 */
@SuperBuilder()
export class BaseAudit {
  id!: number;

  @Builder.Default("system")
  createdBy!: string;
}

@SuperBuilder()
export class InvoiceRecord extends BaseAudit {
  total!: number;
  status!: string;
}

/**
 * Fluent Accessors (`@Accessors` + `@Getter` + `@Setter`):
 */
@Accessors({ fluent: true, chain: true, prefix: "_" })
@Getter()
@Setter()
export class UserProfile {
  _bio!: string;
  _avatarUrl!: string;
}

/**
 * Standard Custom Exception (`@StandardException`):
 */
@StandardException({ code: "E_USER_NOT_FOUND", statusCode: 404 })
export class UserNotFoundError extends Error { }

/**
 * Static-only Utility Class (`@UtilityClass` — cấm `new`):
 */
@UtilityClass()
export class FormatUtils {
  static slugify(input: string): string {
    return input.trim().toLowerCase().replace(/\s+/g, "-");
  }
}

