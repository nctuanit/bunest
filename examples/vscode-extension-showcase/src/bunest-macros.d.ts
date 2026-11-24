// Local class-macro type declarations for workspace-root TypeScript checks
// (which do not include `.bunest/types/bunest.d.ts` to avoid augmenting global
// `@bunest/core/config` / `@bunest/messaging/events` registries across the monorepo).
// Excluded in `examples/vscode-extension-showcase/tsconfig.json`, which loads
// the auto-generated `.bunest/types/bunest.d.ts` directly.

import type { Logger } from "@bunest/core";

declare module "./diagnostics-demo" {
  interface MacroDiagnosticsDemo {
    toString(): string;
  }
}

declare module "./magic/custom-macros" {
  interface AuditNote {
    getId(): number;
    setId(value: number): this;
    withId(value: number): AuditNote;
    getTitle(): string;
    setTitle(value: string): this;
    withTitle(value: string): AuditNote;
    with(patch: Partial<{ id: number; title: string }>): AuditNote;
    equals(other: unknown): boolean;
    hashCode(): number;
    toString(): string;
    toJSON(): { id: number; title: string };
    clone(): AuditNote;
    toBuilder(): AuditNoteBuilder;
    auditTag: string;
    updatedBy?: string;
    markUpdated(actor: string): this;
  }
  interface AuditNoteBuilder {
    id(value: number): this;
    title(value: string): this;
    build(): AuditNote;
  }
  namespace AuditNote {
    export function fromJSON(raw: string | Record<string, unknown>): AuditNote;
    export function of(props: { id: number; title: string }): AuditNote;
    export function from(source: Partial<{ id: number; title: string }>): AuditNote;
    export function builder(): AuditNoteBuilder;
    export const Fields: { readonly id: "id"; readonly title: "title" };
    export function auditVersion(): number;
  }
}

declare module "./orders/coupon.entity" {
  interface CouponEntity {
    getId(): number;
    setId(value: number): this;
    withId(value: number): CouponEntity;
    getCode(): string;
    setCode(value: string): this;
    withCode(value: string): CouponEntity;
    getDiscountPercent(): number;
    setDiscountPercent(value: number): this;
    withDiscountPercent(value: number): CouponEntity;
    getActive(): boolean;
    setActive(value: boolean): this;
    withActive(value: boolean): CouponEntity;
    with(patch: Partial<{ id: number; code: string; discountPercent: number; active: boolean }>): CouponEntity;
    equals(other: unknown): boolean;
    hashCode(): number;
    toString(): string;
    toJSON(): { id: number; code: string; discountPercent: number; active: boolean };
    clone(): CouponEntity;
  }
  namespace CouponEntity {
    export function fromJSON(raw: string | Record<string, unknown>): CouponEntity;
    export function of(props: { id: number; code: string; discountPercent: number; active: boolean }): CouponEntity;
    export function from(source: Partial<{ id: number; code: string; discountPercent: number; active: boolean }>): CouponEntity;
  }
}

declare module "./orders/order.entity" {
  interface OrderEntity {
    getId(): number;
    setId(value: number): this;
    withId(value: number): OrderEntity;
    getOrderCode(): string;
    setOrderCode(value: string): this;
    withOrderCode(value: string): OrderEntity;
    getStatus(): string;
    setStatus(value: string): this;
    withStatus(value: string): OrderEntity;
    getTotalCents(): number;
    setTotalCents(value: number): this;
    withTotalCents(value: number): OrderEntity;
    getDeletedAt(): string | undefined;
    setDeletedAt(value: string | undefined): this;
    withDeletedAt(value: string | undefined): OrderEntity;
    with(patch: Partial<{ id: number; orderCode: string; status: string; totalCents: number; deletedAt?: string }>): OrderEntity;
    equals(other: unknown): boolean;
    hashCode(): number;
    toString(): string;
    toJSON(): { id: number; orderCode: string; status: string; totalCents: number; deletedAt?: string };
    clone(): OrderEntity;
  }
  namespace OrderEntity {
    export function fromJSON(raw: string | Record<string, unknown>): OrderEntity;
    export function of(props: { id: number; orderCode: string; status: string; totalCents: number; deletedAt?: string }): OrderEntity;
    export function from(source: Partial<{ id: number; orderCode: string; status: string; totalCents: number; deletedAt?: string }>): OrderEntity;
  }
}

declare module "./orders/orders.service" {
  interface OrdersService {
    readonly logger: Logger;
  }
}

declare module "./users/money.vo" {
  interface BaseAudit {
    toBuilder(): BaseAuditBuilder;
  }
  interface BaseAuditBuilder {
    id(value: number): this;
    createdBy(value: string): this;
    build(): BaseAudit;
  }
  namespace BaseAudit {
    export function builder(): BaseAuditBuilder;
  }
  interface InvoiceRecord {
    toBuilder(): InvoiceRecordBuilder;
  }
  interface InvoiceRecordBuilder {
    id(value: number): this;
    createdBy(value: string): this;
    total(value: number): this;
    status(value: string): this;
    build(): InvoiceRecord;
  }
  namespace InvoiceRecord {
    export function builder(): InvoiceRecordBuilder;
  }
  interface Money {
    getAmount(): number;
    withAmount(value: number): Money;
    withAmountBy(updater: (current: number) => number): Money;
    getCurrency(): string;
    withCurrency(value: string): Money;
    withCurrencyBy(updater: (current: string) => string): Money;
    with(patch: Partial<{ amount: number; currency: string }>): Money;
    equals(other: unknown): boolean;
    hashCode(): number;
    toString(): string;
    toJSON(): { amount: number; currency: string };
    clone(): Money;
  }
  namespace Money {
    export function fromJSON(raw: string | Record<string, unknown>): Money;
    export function of(props: { amount: number; currency: string }): Money;
    export function from(source: Partial<{ amount: number; currency: string }>): Money;
  }
  interface UserNotFoundError {
    code?: string;
    statusCode?: number;
  }
  namespace UserNotFoundError {
    export function from(message: string, cause?: unknown): UserNotFoundError;
  }
  interface UserProfile {
    bio(): string;
    bio(value: string): this;
    avatarUrl(): string;
    avatarUrl(value: string): this;
  }
}

declare module "./users/user.entity" {
  interface UserEntity {
    getId(): number;
    setId(value: number): this;
    withId(value: number): UserEntity;
    getEmail(): string;
    setEmail(value: string): this;
    withEmail(value: string): UserEntity;
    getName(): string;
    setName(value: string): this;
    withName(value: string): UserEntity;
    getAge(): number;
    setAge(value: number): this;
    withAge(value: number): UserEntity;
    getActive(): boolean;
    setActive(value: boolean): this;
    withActive(value: boolean): UserEntity;
    getPasswordHash(): string | undefined;
    setPasswordHash(value: string | undefined): this;
    withPasswordHash(value: string | undefined): UserEntity;
    getTags(): string[] | undefined;
    setTags(value: string[] | undefined): this;
    withTags(value: string[] | undefined): UserEntity;
    with(patch: Partial<{ id: number; email: string; name: string; age?: number; active?: boolean; passwordHash?: string; tags?: string[] }>): UserEntity;
    equals(other: unknown): boolean;
    hashCode(): number;
    toString(): string;
    toJSON(): { id: number; email: string; name: string; age?: number; active?: boolean; tags?: string[] };
    clone(): UserEntity;
    toBuilder(): UserEntityBuilder;
  }
  interface UserEntityBuilder {
    id(value: number): this;
    email(value: string): this;
    name(value: string): this;
    age(value: number): this;
    active(value: boolean): this;
    passwordHash(value: string | undefined): this;
    tag(item: string): this;
    tags(value: string[] | undefined): this;
    clearTags(): this;
    build(): UserEntity;
  }
  namespace UserEntity {
    export function fromJSON(raw: string | Record<string, unknown>): UserEntity;
    export function of(props: { id: number; email: string; name: string; age?: number; active?: boolean; passwordHash?: string; tags?: string[] }): UserEntity;
    export function from(source: Partial<{ id: number; email: string; name: string; age?: number; active?: boolean; passwordHash?: string; tags?: string[] }>): UserEntity;
    export function builder(): UserEntityBuilder;
    export const Fields: { readonly id: "id"; readonly email: "email"; readonly name: "name"; readonly age: "age"; readonly active: "active"; readonly passwordHash: "passwordHash"; readonly tags: "tags" };
  }
}

declare module "./users/users.events" {
  interface UsersEventsListener {
    readonly logger: Logger;
    formatAuditLine(action: string, subject: string): string;
  }
}

declare module "./users/users.service" {
  interface UsersService {
    readonly logger: Logger;
  }
}

export {};
