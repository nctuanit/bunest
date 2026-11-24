import { registerAs } from "../../../../../packages/core/src/config";

export default registerAs("database", () => ({
  host: "host",
  port: 4000,
}));
