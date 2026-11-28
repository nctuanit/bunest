import { Prop } from "../prop/prop.decorator";

export type SortOrder = "asc" | "desc";

const SORT_ORDERS: readonly SortOrder[] = ["asc", "desc"];

/**
 * Reusable offset-pagination & sorting query DTO powered by `@Prop()`.
 * Automatically validates, coerces query strings (`page`, `limit`), and generates
 * OpenAPI documentation with zero boilerplate.
 */
export class OffsetPaginationQueryDto {
  @Prop({
    int: true,
    min: 1,
    optional: true,
    coerce: true,
    default: 1,
    description: "1-based page number",
    example: 1,
  })
  page: number = 1;

  @Prop({
    int: true,
    min: 1,
    max: 100,
    optional: true,
    coerce: true,
    default: 20,
    description: "Number of items per page (1–100)",
    example: 20,
  })
  limit: number = 20;

  @Prop({
    string: true,
    optional: true,
    description: "Field name to sort results by",
    example: "createdAt",
  })
  sortBy?: string;

  @Prop({
    isIn: SORT_ORDERS,
    optional: true,
    default: "desc",
    description: "Sort direction (asc or desc)",
    example: "desc",
  })
  sortOrder?: SortOrder;

  @Prop({
    string: true,
    optional: true,
    description: "Optional free-text search query",
  })
  search?: string;

  /** Computed zero-based SQL/ORM `skip` offset. */
  get offset(): number {
    return (this.page - 1) * this.limit;
  }
}

/**
 * Reusable cursor-pagination & sorting query DTO powered by `@Prop()`.
 */
export class CursorPaginationQueryDto {
  @Prop({
    string: true,
    optional: true,
    description: "Opaque cursor returned by the previous page",
  })
  cursor?: string;

  @Prop({
    int: true,
    min: 1,
    max: 100,
    optional: true,
    coerce: true,
    default: 20,
    description: "Number of items to fetch (1–100)",
    example: 20,
  })
  limit: number = 20;

  @Prop({
    string: true,
    optional: true,
    description: "Field name to sort results by",
    example: "id",
  })
  sortBy?: string;

  @Prop({
    isIn: SORT_ORDERS,
    optional: true,
    default: "desc",
    description: "Sort direction (asc or desc)",
    example: "desc",
  })
  sortOrder?: SortOrder;
}

export interface PaginatedMeta {
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly totalPages: number;
  readonly hasNextPage: boolean;
  readonly hasPrevPage: boolean;
}

export interface PaginatedResponse<T> {
  readonly data: readonly T[];
  readonly meta: PaginatedMeta;
}

/**
 * Builds a canonical offset-paginated response envelope `{ data, meta }`.
 */
export function createPaginatedResponse<T>(
  data: readonly T[],
  options: { readonly total: number; readonly page: number; readonly limit: number },
): PaginatedResponse<T> {
  const total = Math.max(0, Math.floor(options.total));
  const limit = Math.max(1, Math.floor(options.limit));
  const page = Math.max(1, Math.floor(options.page));
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    data,
    meta: {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
}
