import { registerAs } from "@bunest/core/config";

export const appConfig = registerAs("app", () => ({
  name: Bun.env.APP_NAME ?? "Bunest Showcase",
  port: Number(Bun.env.PORT ?? 3100),
  debug: Bun.env.NODE_ENV !== "production",
}));
