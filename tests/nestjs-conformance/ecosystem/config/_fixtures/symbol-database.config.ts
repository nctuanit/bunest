import "reflect-metadata";
import { registerAs } from "../../../../../packages/config/src";

export const DATABASE_SYMBOL_TOKEN = Symbol("database");

export default registerAs(DATABASE_SYMBOL_TOKEN, () => ({
  host: "host",
  port: 4000,
}));
