/**
 * GraphQL October 2021 Spec AST Printer.
 * Produces spec-compliant formatted GraphQL executable documents & SDL.
 * Zero external dependencies.
 */

import { type ASTNode, Kind } from "./ast";

export function printString(str: string): string {
  return JSON.stringify(str);
}

export function printBlockString(
  value: string,
  options?: { readonly minimize?: boolean },
): string {
  const escapedValue = value.replace(/"""/g, '\\"""');
  const lines = escapedValue.split(/\r\n|\n|\r/);
  const isSingleLine = lines.length === 1;

  const forceLeadingNewLine =
    lines.length > 1 &&
    lines
      .slice(1)
      .every((line) => line.length === 0 || /^[ \t]/.test(line));

  const hasTrailingTripleQuotes = escapedValue.endsWith('\\"""');
  const hasTrailingQuote =
    value.endsWith('"') && !hasTrailingTripleQuotes;
  const hasTrailingSlash = value.endsWith("\\");
  const forceTrailingNewline = hasTrailingQuote || hasTrailingSlash;

  const printAsMultipleLines =
    !options?.minimize &&
    (!isSingleLine ||
      value.length > 70 ||
      forceTrailingNewline ||
      forceLeadingNewLine ||
      hasTrailingTripleQuotes);

  let result = "";
  const skipLeadingNewLine = isSingleLine && /^["\s]/.test(value);
  if (
    (printAsMultipleLines && !skipLeadingNewLine) ||
    forceLeadingNewLine
  ) {
    result += "\n";
  }

  result += escapedValue;

  if (printAsMultipleLines || forceTrailingNewline) {
    result += "\n";
  }

  return `"""${result}"""`;
}

function join(
  items: readonly (string | null | undefined)[] | undefined,
  separator = "",
): string {
  return (items?.filter((x): x is string => Boolean(x)) ?? []).join(separator);
}

function indent(str: string): string {
  return str.replace(/\n/g, "\n  ");
}

function block(array: readonly (string | null | undefined)[] | undefined): string {
  return wrap("{\n", indent(join(array, "\n")), "\n}");
}

function wrap(
  start: string,
  maybeString: string | null | undefined,
  end = "",
): string {
  return maybeString ? start + maybeString + end : "";
}

function hasMultilineItems(maybeArray: readonly string[] | undefined): boolean {
  return Boolean(maybeArray?.some((str) => str.includes("\n")));
}

function printNode(node: ASTNode): string {
  switch (node.kind) {
    case Kind.NAME:
      return node.value;

    case Kind.VARIABLE:
      return `$${printNode(node.name)}`;

    case Kind.DOCUMENT:
      return join(node.definitions.map(printNode), "\n\n");

    case Kind.OPERATION_DEFINITION: {
      const varDefs = wrap(
        "(",
        join(node.variableDefinitions?.map(printNode), ", "),
        ")",
      );
      const directives = join(node.directives?.map(printNode), " ");
      const selectionSet = printNode(node.selectionSet);
      const name = node.name ? printNode(node.name) : "";
      if (!name && !directives && !varDefs && node.operation === "query") {
        return selectionSet;
      }
      return join(
        [node.operation, join([name, varDefs]), directives, selectionSet],
        " ",
      );
    }

    case Kind.VARIABLE_DEFINITION:
      return (
        `${printNode(node.variable)}: ${printNode(node.type)}` +
        wrap(" = ", node.defaultValue ? printNode(node.defaultValue) : "") +
        wrap(" ", join(node.directives?.map(printNode), " "))
      );

    case Kind.SELECTION_SET:
      return block(node.selections.map(printNode));

    case Kind.FIELD: {
      const alias = node.alias ? `${printNode(node.alias)}: ` : "";
      const name = printNode(node.name);
      const args = node.arguments?.map(printNode) ?? [];
      const directives = join(node.directives?.map(printNode), " ");
      const selectionSet = node.selectionSet
        ? printNode(node.selectionSet)
        : "";
      let prefix = alias + name;
      let argsLine = prefix + wrap("(", join(args, ", "), ")");
      if (argsLine.length > 80) {
        argsLine = prefix + wrap("(\n", indent(join(args, "\n")), "\n)");
      }
      return join([argsLine, directives, selectionSet], " ");
    }

    case Kind.ARGUMENT:
      return `${printNode(node.name)}: ${printNode(node.value)}`;

    case Kind.FRAGMENT_SPREAD:
      return (
        `...${printNode(node.name)}` +
        wrap(" ", join(node.directives?.map(printNode), " "))
      );

    case Kind.INLINE_FRAGMENT:
      return join(
        [
          "...",
          wrap("on ", node.typeCondition ? printNode(node.typeCondition) : ""),
          join(node.directives?.map(printNode), " "),
          printNode(node.selectionSet),
        ],
        " ",
      );

    case Kind.FRAGMENT_DEFINITION: {
      const varDefs = wrap(
        "(",
        join(node.variableDefinitions?.map(printNode), ", "),
        ")",
      );
      return (
        `fragment ${printNode(node.name)}${varDefs} on ${printNode(node.typeCondition)} ` +
        wrap("", join(node.directives?.map(printNode), " "), " ") +
        printNode(node.selectionSet)
      );
    }

    case Kind.INT:
    case Kind.FLOAT:
    case Kind.ENUM:
      return node.value;

    case Kind.STRING:
      return node.block
        ? printBlockString(node.value)
        : printString(node.value);

    case Kind.BOOLEAN:
      return node.value ? "true" : "false";

    case Kind.NULL:
      return "null";

    case Kind.LIST:
      return `[${join(node.values.map(printNode), ", ")}]`;

    case Kind.OBJECT:
      return `{${join(node.fields.map(printNode), ", ")}}`;

    case Kind.OBJECT_FIELD:
      return `${printNode(node.name)}: ${printNode(node.value)}`;

    case Kind.DIRECTIVE:
      return (
        `@${printNode(node.name)}` +
        wrap("(", join(node.arguments?.map(printNode), ", "), ")")
      );

    case Kind.NAMED_TYPE:
      return printNode(node.name);

    case Kind.LIST_TYPE:
      return `[${printNode(node.type)}]`;

    case Kind.NON_NULL_TYPE:
      return `${printNode(node.type)}!`;

    case Kind.SCHEMA_DEFINITION:
      return join(
        [
          node.description ? printNode(node.description) : "",
          join(
            [
              "schema",
              join(node.directives?.map(printNode), " "),
              block(node.operationTypes.map(printNode)),
            ],
            " ",
          ),
        ],
        "\n",
      );

    case Kind.OPERATION_TYPE_DEFINITION:
      return `${node.operation}: ${printNode(node.type)}`;

    case Kind.SCALAR_TYPE_DEFINITION:
      return join(
        [
          node.description ? printNode(node.description) : "",
          join(
            [
              "scalar",
              printNode(node.name),
              join(node.directives?.map(printNode), " "),
            ],
            " ",
          ),
        ],
        "\n",
      );

    case Kind.OBJECT_TYPE_DEFINITION:
      return join(
        [
          node.description ? printNode(node.description) : "",
          join(
            [
              "type",
              printNode(node.name),
              wrap(
                "implements ",
                join(node.interfaces?.map(printNode), " & "),
              ),
              join(node.directives?.map(printNode), " "),
              block(node.fields?.map(printNode)),
            ],
            " ",
          ),
        ],
        "\n",
      );

    case Kind.FIELD_DEFINITION: {
      const args = node.arguments?.map(printNode) ?? [];
      const argsBlock = hasMultilineItems(args)
        ? wrap("(\n", indent(join(args, "\n")), "\n)")
        : wrap("(", join(args, ", "), ")");
      return join(
        [
          node.description ? printNode(node.description) : "",
          `${printNode(node.name)}${argsBlock}: ${printNode(node.type)}` +
            wrap(" ", join(node.directives?.map(printNode), " ")),
        ],
        "\n",
      );
    }

    case Kind.INPUT_VALUE_DEFINITION:
      return join(
        [
          node.description ? printNode(node.description) : "",
          join(
            [
              `${printNode(node.name)}: ${printNode(node.type)}`,
              wrap(
                "= ",
                node.defaultValue ? printNode(node.defaultValue) : "",
              ),
              join(node.directives?.map(printNode), " "),
            ],
            " ",
          ),
        ],
        "\n",
      );

    case Kind.INTERFACE_TYPE_DEFINITION:
      return join(
        [
          node.description ? printNode(node.description) : "",
          join(
            [
              "interface",
              printNode(node.name),
              wrap(
                "implements ",
                join(node.interfaces?.map(printNode), " & "),
              ),
              join(node.directives?.map(printNode), " "),
              block(node.fields?.map(printNode)),
            ],
            " ",
          ),
        ],
        "\n",
      );

    case Kind.UNION_TYPE_DEFINITION:
      return join(
        [
          node.description ? printNode(node.description) : "",
          join(
            [
              "union",
              printNode(node.name),
              join(node.directives?.map(printNode), " "),
              wrap("= ", join(node.types?.map(printNode), " | ")),
            ],
            " ",
          ),
        ],
        "\n",
      );

    case Kind.ENUM_TYPE_DEFINITION:
      return join(
        [
          node.description ? printNode(node.description) : "",
          join(
            [
              "enum",
              printNode(node.name),
              join(node.directives?.map(printNode), " "),
              block(node.values?.map(printNode)),
            ],
            " ",
          ),
        ],
        "\n",
      );

    case Kind.ENUM_VALUE_DEFINITION:
      return join(
        [
          node.description ? printNode(node.description) : "",
          join(
            [
              printNode(node.name),
              join(node.directives?.map(printNode), " "),
            ],
            " ",
          ),
        ],
        "\n",
      );

    case Kind.INPUT_OBJECT_TYPE_DEFINITION:
      return join(
        [
          node.description ? printNode(node.description) : "",
          join(
            [
              "input",
              printNode(node.name),
              join(node.directives?.map(printNode), " "),
              block(node.fields?.map(printNode)),
            ],
            " ",
          ),
        ],
        "\n",
      );

    case Kind.DIRECTIVE_DEFINITION: {
      const args = node.arguments?.map(printNode) ?? [];
      const argsBlock = hasMultilineItems(args)
        ? wrap("(\n", indent(join(args, "\n")), "\n)")
        : wrap("(", join(args, ", "), ")");
      return join(
        [
          node.description ? printNode(node.description) : "",
          `directive @${printNode(node.name)}${argsBlock}` +
            (node.repeatable ? " repeatable" : "") +
            ` on ${join(node.locations.map(printNode), " | ")}`,
        ],
        "\n",
      );
    }

    case Kind.SCHEMA_EXTENSION:
      return join(
        [
          "extend schema",
          join(node.directives?.map(printNode), " "),
          block(node.operationTypes?.map(printNode)),
        ],
        " ",
      );

    case Kind.SCALAR_TYPE_EXTENSION:
      return join(
        [
          "extend scalar",
          printNode(node.name),
          join(node.directives?.map(printNode), " "),
        ],
        " ",
      );

    case Kind.OBJECT_TYPE_EXTENSION:
      return join(
        [
          "extend type",
          printNode(node.name),
          wrap(
            "implements ",
            join(node.interfaces?.map(printNode), " & "),
          ),
          join(node.directives?.map(printNode), " "),
          block(node.fields?.map(printNode)),
        ],
        " ",
      );

    case Kind.INTERFACE_TYPE_EXTENSION:
      return join(
        [
          "extend interface",
          printNode(node.name),
          wrap(
            "implements ",
            join(node.interfaces?.map(printNode), " & "),
          ),
          join(node.directives?.map(printNode), " "),
          block(node.fields?.map(printNode)),
        ],
        " ",
      );

    case Kind.UNION_TYPE_EXTENSION:
      return join(
        [
          "extend union",
          printNode(node.name),
          join(node.directives?.map(printNode), " "),
          wrap("= ", join(node.types?.map(printNode), " | ")),
        ],
        " ",
      );

    case Kind.ENUM_TYPE_EXTENSION:
      return join(
        [
          "extend enum",
          printNode(node.name),
          join(node.directives?.map(printNode), " "),
          block(node.values?.map(printNode)),
        ],
        " ",
      );

    case Kind.INPUT_OBJECT_TYPE_EXTENSION:
      return join(
        [
          "extend input",
          printNode(node.name),
          join(node.directives?.map(printNode), " "),
          block(node.fields?.map(printNode)),
        ],
        " ",
      );
  }
}

export function print(ast: ASTNode): string {
  return printNode(ast);
}
