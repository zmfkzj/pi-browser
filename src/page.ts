import type { CallOptions, McpToolResult } from "./mcp-client.js";
import type { McpContent } from "./output.js";

export interface PageSession {
  call(tool: string, args: Record<string, unknown>, options?: CallOptions): Promise<McpToolResult>;
}

export function contentText(content: McpContent[]): string {
  return content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

export function describeError(message: string, cwd?: string): string {
  if (/unknown ref/i.test(message)) {
    message += "\nRefs change after every action or navigation; call browser_snapshot and use a ref from the latest result.";
  }
  if (/private\/internal IP|private.*address.*block/i.test(message)) {
    message += `\nPrivate/loopback addresses are blocked by default. Set "allowPrivateNetwork": true in ${cwd ? `${cwd}/.pi/browser.config.json` : ".pi/browser.config.json"} (trusted project) or ~/.pi/agent/browser.config.json, then /browser restart.`;
  }
  return message;
}

export function checkedText(result: McpToolResult, cwd?: string): string {
  const text = contentText(result.content);
  if (result.isError) throw new Error(describeError(text || "Obscura reported a tool error", cwd));
  return text;
}

/** Listing must be LAST: both snapshot and listing rebuild obscura's ref table. */
export async function summarizePage(session: PageSession, options: {
  maxChars: number;
  limit?: number;
  includeInteractive?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const raw = checkedText(await session.call("browser_snapshot", { max_chars: options.maxChars }, { signal: options.signal }));
  const match = /^URL: ([^\n]*)\r?\nTitle: ([^\n]*)\r?\n\r?\n([\s\S]*)$/.exec(raw);
  let text = raw;
  if (match) {
    const body = (match[3] ?? "").replace(/\n\n\d+ interactive element\(s\) registered\. Call browser_interactive_elements[^\n]*\s*$/, "");
    text = `URL: ${match[1]?.trim()} | Title: ${match[2]?.trim()}\n--- page text (first ${options.maxChars} chars) ---\n${body}`;
  }
  if (options.includeInteractive !== false) {
    const listing = checkedText(await session.call("browser_interactive_elements", { limit: options.limit ?? 60 }, { signal: options.signal }));
    const elements = listing.split("\n").map((line) => {
      const ref = /^\s*ref=(\S+)\s+(\S+)\s+([\s\S]*)$/.exec(line);
      return ref ? `${ref[1]} ${ref[2]} ${ref[3]}` : line;
    }).join("\n");
    text += `\n--- interactive elements (refs are valid until the next action or navigation) ---\n${elements}`;
  }
  return text;
}
