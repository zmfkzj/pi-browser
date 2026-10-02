import type { BrowserEngine } from "./engine.js";
import type { McpContent } from "./output.js";

export function contentText(content: McpContent[]): string {
  return content.filter(item => item.type === "text").map(item => item.text).join("\n");
}
/** Compatibility for raw protocol tests; curated tools use BrowserEngine exclusively. */
export { checkedText, describeError, type PageSession } from "./engines/obscura.js";

export async function summarizePage(engine: BrowserEngine, options: Parameters<BrowserEngine["summarize"]>[0]): Promise<string> {
  const page = await engine.summarize(options);
  let text = page.url || page.title
    ? `URL: ${page.url} | Title: ${page.title} | engine: ${engine.name}\n--- page text (first ${options.maxChars} chars) ---\n${page.text}`
    : page.text;
  if (page.elements) {
    text += `\n--- interactive elements (refs are valid until the next action or navigation) ---\n${page.elements.map(e => e.ref ? `${e.ref} ${e.kind} ${e.label}` : e.label).join("\n")}`;
  }
  return text;
}
