/**
 * System signals recognized by application shutdown hooks, matching
 * `@nestjs/common` runtime `ShutdownSignal` enum (11 members).
 */
export enum ShutdownSignal {
  SIGHUP = "SIGHUP",
  SIGINT = "SIGINT",
  SIGQUIT = "SIGQUIT",
  SIGILL = "SIGILL",
  SIGTRAP = "SIGTRAP",
  SIGABRT = "SIGABRT",
  SIGBUS = "SIGBUS",
  SIGFPE = "SIGFPE",
  SIGSEGV = "SIGSEGV",
  SIGUSR2 = "SIGUSR2",
  SIGTERM = "SIGTERM",
}
