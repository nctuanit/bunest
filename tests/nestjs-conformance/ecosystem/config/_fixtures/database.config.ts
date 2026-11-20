import "reflect-metadata";
import { registerAs } from "../../../../../packages/config/src";

export default registerAs("database", () => ({
  host: "host",
  port: 4000,
}));
