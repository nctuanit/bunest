import type {
  ObserveOptions,
  SkipSpansContext,
} from "../interfaces/observe-types";

export type SkipSpansPredicate = (operation: SkipSpansContext) => boolean;

export function resolveSkipSpans(
  option: ObserveOptions["skipSpans"],
): SkipSpansPredicate | undefined {
  if (!option) {
    return undefined;
  }
  if (typeof option === "function") {
    return option;
  }
  if (Array.isArray(option) && option.length > 0) {
    const codes = new Set(option);
    return (ctx) =>
      typeof ctx.statusCode === "number" && codes.has(ctx.statusCode);
  }
  return undefined;
}
