import type {
  DataSourceLike,
  DataSourceOptionsLike,
} from "../runtime/typeorm-runtime";

export type DataSourceRef = DataSourceLike | DataSourceOptionsLike | string;
