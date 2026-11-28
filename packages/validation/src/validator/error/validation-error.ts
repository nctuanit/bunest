export class ValidationError {
  declare target?: object;
  declare property: string;
  declare value?: unknown;
  declare constraints?: Record<string, string>;
  declare children?: ValidationError[];
  declare contexts?: Record<string, unknown>;

  toString(
    shouldDecorate = false,
    hasParent = false,
    parentPath = "",
    showConstraintMessages = false,
  ): string {
    const boldStart = shouldDecorate ? "\x1b[1m" : "";
    const boldEnd = shouldDecorate ? "\x1b[22m" : "";
    const constraintsToString = (): string => {
      const c = this.constraints ?? {};
      return (showConstraintMessages ? Object.values(c) : Object.keys(c)).join(
        ", ",
      );
    };
    const propConstraintFailed = (propertyName: string): string =>
      ` - property ${boldStart}${parentPath}${propertyName}${boldEnd} has failed the following constraints: ${boldStart}${constraintsToString()}${boldEnd} \n`;

    if (!hasParent) {
      return (
        `An instance of ${boldStart}${this.target ? this.target.constructor.name : "an object"}${boldEnd} has failed the validation:\n` +
        (this.constraints ? propConstraintFailed(this.property) : "") +
        (this.children
          ? this.children
              .map((childError) =>
                childError.toString(
                  shouldDecorate,
                  true,
                  this.property,
                  showConstraintMessages,
                ),
              )
              .join("")
          : "")
      );
    }

    const separator = parentPath ? "." : "";
    const formattedProperty = Number.isInteger(+this.property)
      ? `[${this.property}]`
      : `${separator}${this.property}`;

    if (this.constraints) {
      return propConstraintFailed(formattedProperty);
    }

    return this.children
      ? this.children
          .map((childError) =>
            childError.toString(
              shouldDecorate,
              true,
              `${parentPath}${formattedProperty}`,
              showConstraintMessages,
            ),
          )
          .join("")
      : "";
  }
}
