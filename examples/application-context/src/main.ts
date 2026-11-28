import { BunestFactory } from "@bunest/core";
import { AppModule } from "./app.module";
import { JobRunnerService } from "./context/job-runner.service";

const ctx = await BunestFactory.createApplicationContext(AppModule);
try {
  const runner = ctx.get(JobRunnerService);
  const results = await runner.runBatch("acme-corp", "nightly-sync", [
    "users",
    "invoices",
  ]);
  console.log("Batch finished:", JSON.stringify(results));
} finally {
  await ctx.close();
}
