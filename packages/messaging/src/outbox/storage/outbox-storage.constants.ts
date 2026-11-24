/** The methods `OutboxStorage.registerSource()` checks for, per contract (internal). */
export const OUTBOX_STORE_METHODS = [
  "add",
  "claim",
  "markPublished",
  "reschedule",
  "deadLetter",
  "release",
  "stats",
  "listDeadLetters",
  "getDeadLetter",
  "requeueDeadLetters",
  "purgeDeadLetters",
] as const;

export const OUTBOX_INBOX_STORE_METHODS = [
  "recordInbox",
  "hasInbox",
  "pruneInbox",
] as const;
