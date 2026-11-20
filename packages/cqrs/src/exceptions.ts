export class CommandHandlerNotFoundException extends Error {
  constructor(commandName: string) {
    super(`No @CommandHandler() registered for command "${commandName}".`);
    this.name = "CommandHandlerNotFoundException";
  }
}

export class DuplicateCommandHandlerException extends Error {
  constructor(commandName: string) {
    super(
      `Duplicate @CommandHandler() registration for command "${commandName}". Each command must have exactly one handler.`,
    );
    this.name = "DuplicateCommandHandlerException";
  }
}

export class QueryHandlerNotFoundException extends Error {
  constructor(queryName: string) {
    super(`No @QueryHandler() registered for query "${queryName}".`);
    this.name = "QueryHandlerNotFoundException";
  }
}

export class DuplicateQueryHandlerException extends Error {
  constructor(queryName: string) {
    super(
      `Duplicate @QueryHandler() registration for query "${queryName}". Each query must have exactly one handler.`,
    );
    this.name = "DuplicateQueryHandlerException";
  }
}

export class InvalidCommandHandlerException extends Error {
  constructor() {
    super(
      "An invalid command handler has been provided. Please ensure that the provided handler is a class annotated with @CommandHandler and contains an 'execute' method.",
    );
    this.name = "InvalidCommandHandlerException";
  }
}

export class InvalidQueryHandlerException extends Error {
  constructor() {
    super(
      "An invalid query handler has been provided. Please ensure that the provided handler is a class annotated with @QueryHandler and contains an 'execute' method.",
    );
    this.name = "InvalidQueryHandlerException";
  }
}

export class InvalidEventsHandlerException extends Error {
  constructor() {
    super(
      "An invalid events handler has been provided. Please ensure that the provided handler is a class annotated with @EventsHandler and contains a 'handle' method.",
    );
    this.name = "InvalidEventsHandlerException";
  }
}

export class InvalidSagaException extends Error {
  constructor() {
    super(
      "Invalid saga. Each saga must be a function reacting to published events.",
    );
    this.name = "InvalidSagaException";
  }
}

export class UnsupportedSagaScopeException extends Error {
  constructor() {
    super(
      'Request-scoped saga hosts are not supported. Instead, retrieve async-context-specific instances within the saga itself using the "ModuleRef" provider.',
    );
    this.name = "UnsupportedSagaScopeException";
  }
}
