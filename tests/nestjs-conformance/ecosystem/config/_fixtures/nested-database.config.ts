import { registerAs } from "../../../../../packages/core/src/config";

export default registerAs("database.driver", () => ({
  host: "host",
  port: 4000,
}));
