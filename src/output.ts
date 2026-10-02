import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; blob?: string; text?: string } };

export interface TextBounds {
  maxChars: number;
  maxLines?: number;
  spillDir?: string;
  label: string;
}

const spillKey = randomBytes(8).toString("hex");
let spillSequence = 0;

export function defaultSpillDir(): string { return join(tmpdir(), "pi-browser", spillKey); }

function headEnd(text: string, maxChars: number, maxLines: number): number {
  let end = Math.min(text.length, maxChars);
  let cursor = 0;
  for (let count = 0; count < maxLines; count++) {
    const next = text.indexOf("\n", cursor);
    if (next === -1 || next >= end) return end;
    cursor = next + 1;
  }
  end = Math.min(end, Math.max(0, cursor - 1));
  return maxLines > 0 ? end : 0;
}

function tailStart(text: string, maxChars: number, maxLines: number): number {
  let start = Math.max(0, text.length - maxChars);
  let cursor = text.length;
  for (let count = 0; count < maxLines; count++) {
    const previous = text.lastIndexOf("\n", cursor - 1);
    if (previous === -1 || previous < start) return start;
    cursor = previous;
  }
  start = Math.max(start, cursor + 1);
  return maxLines > 0 ? start : text.length;
}

/** Keep the beginning and end inline, storing the unmodified full output when either limit is exceeded. */
export async function boundText(text: string, bounds: TextBounds): Promise<{ text: string; spilledPath?: string }> {
  const maxLines = bounds.maxLines ?? 300;
  if (!Number.isSafeInteger(bounds.maxChars) || bounds.maxChars < 1 || !Number.isSafeInteger(maxLines) || maxLines < 1) {
    throw new Error("Output bounds must be positive integers");
  }
  if (text.length <= bounds.maxChars && text.split("\n").length <= maxLines) return { text };

  // Reserve the maximum possible marker length up front so its actual count
  // never pushes a normal preview beyond maxChars. Tiny budgets still show the
  // marker (there is no way to fit its mandated wording in fewer characters).
  const markerBudget = `\n… [${text.length} chars omitted] …\n`.length;
  const chars = Math.max(0, bounds.maxChars - markerBudget);
  const lines = Math.max(0, maxLines - 1);
  const end = headEnd(text, Math.floor(chars / 2), Math.ceil(lines / 2));
  const start = Math.max(end, tailStart(text, chars - Math.floor(chars / 2), Math.floor(lines / 2)));
  const omitted = start - end;
  const head = text.slice(0, end);
  const tail = text.slice(start);
  const preview = [head, `… [${omitted} chars omitted] …`, tail].filter(Boolean).join("\n");
  const dir = bounds.spillDir ?? defaultSpillDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const label = bounds.label.replace(/[^\w-]/g, "_").slice(0, 100) || "output";
  const spilledPath = join(dir, `${label}-${++spillSequence}.txt`);
  await writeFile(spilledPath, text, { flag: "wx", mode: 0o600 });
  return { text: preview, spilledPath };
}

/** Join and bound text, preserve images, and describe embedded resources without dumping their payload. */
export async function mcpContentToToolContent(content: McpContent[], bounds: TextBounds): Promise<{
  content: (TextContent | ImageContent)[];
  spilledPath?: string;
}> {
  const texts: string[] = [];
  const images: ImageContent[] = [];
  for (const item of content) {
    if (item.type === "text") texts.push(item.text);
    else if (item.type === "image") images.push({ type: "image", data: item.data, mimeType: item.mimeType });
    else {
      const resource = item.resource;
      const payload = resource.blob !== undefined ? `${resource.blob.length} base64 chars`
        : resource.text !== undefined ? `${resource.text.length} text chars` : "no payload";
      texts.push(`[Embedded resource: ${resource.uri}; ${resource.mimeType ?? "unknown MIME type"}; ${payload}. Use browser_pdf to export a PDF file.]`);
    }
  }
  const bounded = await boundText(texts.join("\n"), bounds);
  const notice = bounded.spilledPath ? `\n\n[Full output saved to ${bounded.spilledPath}; use read with offset/limit or grep to inspect it.]` : "";
  return {
    content: [...(texts.length > 0 ? [{ type: "text" as const, text: bounded.text + notice }] : []), ...images],
    ...(bounded.spilledPath ? { spilledPath: bounded.spilledPath } : {}),
  };
}
