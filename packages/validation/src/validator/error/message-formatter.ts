import type { ValidationArguments } from "../interfaces/validation-arguments.interface";
import type { ValidationOptions } from "../interfaces/validation-options.interface";

export function constraintToString(constraint: unknown): string {
  if (Array.isArray(constraint)) return constraint.join(", ");
  if (typeof constraint === "symbol") return constraint.description ?? "";
  return `${constraint}`;
}

export function replaceMessageSpecialTokens(
  message: string | ((args: ValidationArguments) => string),
  validationArguments: ValidationArguments,
): string {
  let messageString: string;
  if (typeof message === "function") {
    messageString = message(validationArguments);
  } else if (typeof message === "string") {
    messageString = message;
  } else {
    return "";
  }

  if (messageString.length === 0 || !messageString.includes("$")) {
    return messageString;
  }

  const constraints = validationArguments.constraints;
  if (constraints && constraints.length > 0) {
    for (let i = 0; i < constraints.length; i++) {
      const token = `$constraint${i + 1}`;
      if (messageString.includes(token)) {
        messageString = messageString.replaceAll(
          token,
          constraintToString(constraints[i]),
        );
      }
    }
  }

  if (
    validationArguments.value !== undefined &&
    validationArguments.value !== null &&
    (typeof validationArguments.value === "string" ||
      typeof validationArguments.value === "boolean" ||
      typeof validationArguments.value === "number")
  ) {
    if (messageString.includes("$value")) {
      messageString = messageString.replaceAll(
        "$value",
        `${validationArguments.value}`,
      );
    }
  }

  if (validationArguments.property && messageString.includes("$property")) {
    messageString = messageString.replaceAll(
      "$property",
      validationArguments.property,
    );
  }

  if (validationArguments.targetName && messageString.includes("$target")) {
    messageString = messageString.replaceAll(
      "$target",
      validationArguments.targetName,
    );
  }

  return messageString;
}

export function buildMessage(
  impl: (eachPrefix: string, args?: ValidationArguments) => string,
  validationOptions?: ValidationOptions,
): (validationArguments?: ValidationArguments) => string {
  return (validationArguments?: ValidationArguments): string => {
    const eachPrefix = validationOptions?.each ? "each value in " : "";
    return impl(eachPrefix, validationArguments);
  };
}
