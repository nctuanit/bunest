#!/usr/bin/env bun
const args = process.argv.slice(2);
const command = args[0] ?? "help";

if (command === "--version" || command === "-v") {
  console.log("@bunest/observe 0.1.0");
  process.exit(0);
}

if (command === "help" || command === "--help" || command === "-h") {
  console.log(
    "Usage: observe <command>\n\nCommands:\n  status   Inspect OBSERVE_* environment variables\n  help     Show this help text",
  );
  process.exit(0);
}

if (command === "status") {
  const endpoint =
    process.env.OBSERVE_ENDPOINT ?? "https://observe-api.nestjs.com";
  const hasKey = Boolean(process.env.OBSERVE_APP_KEY);
  const hasSecret = Boolean(process.env.OBSERVE_APP_SECRET);
  console.log(
    JSON.stringify(
      {
        endpoint,
        configured: hasKey && hasSecret,
        serviceVersion: process.env.OBSERVE_SERVICE_VERSION ?? null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.error(`Unknown observe command: ${command}`);
process.exit(1);
