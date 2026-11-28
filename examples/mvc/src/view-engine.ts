import { join, type ViewEngineRenderer } from "@bunest/core";

function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const val = data[key];
    return val === undefined || val === null ? "" : Bun.escapeHTML(String(val));
  });
}

export const bunHtmlViewEngine: ViewEngineRenderer = async (
  view: string,
  model: Record<string, unknown>,
  options?: { baseViewsDir?: string | string[] },
): Promise<string> => {
  const baseDir = Array.isArray(options?.baseViewsDir)
    ? (options.baseViewsDir[0] ?? ".")
    : (options?.baseViewsDir ?? ".");
  const filePath = join(baseDir, view.endsWith(".html") ? view : `${view}.html`);
  const source = await Bun.file(filePath).text();

  const withLoops = source.replace(
    /\{\{#each\s+([a-zA-Z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_match, listKey: string, inner: string) => {
      const items = model[listKey];
      if (!Array.isArray(items)) return "";
      return items
        .map((item) =>
          item && typeof item === "object"
            ? interpolate(inner, item as Record<string, unknown>)
            : interpolate(inner, { value: item }),
        )
        .join("");
    },
  );

  return interpolate(withLoops, model);
};
