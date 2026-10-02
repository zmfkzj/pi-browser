import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundText, mcpContentToToolContent } from "../src/output.js";

let spillDir: string;
beforeEach(async () => { spillDir = await mkdtemp(join(tmpdir(), "pi-browser-output-")); });
afterEach(async () => { await rm(spillDir, { recursive: true, force: true }); });
const bounds = () => ({ maxChars: 100, label: "test", spillDir });

describe("boundText", () => {
  it("passes small text through without writing a file", async () => {
    expect(await boundText("hello", bounds())).toEqual({ text: "hello" });
    expect(await readdir(spillDir)).toEqual([]);
  });

  it("keeps head and tail, reports the exact omitted count, and saves full text", async () => {
    const source = "HEAD" + "x".repeat(1000) + "TAIL";
    const result = await boundText(source, bounds());
    expect(result.text.startsWith("HEAD")).toBe(true);
    expect(result.text.endsWith("TAIL")).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(100);
    const [head, marker, tail] = result.text.split("\n");
    expect(marker).toBe(`… [${source.length - (head?.length ?? 0) - (tail?.length ?? 0)} chars omitted] …`);
    expect(await readFile(result.spilledPath!, "utf8")).toBe(source);
  });

  it("enforces the line budget even when the character budget is ample", async () => {
    const source = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const result = await boundText(source, { ...bounds(), maxChars: 10_000, maxLines: 5 });
    expect(result.text.split("\n").length).toBeLessThanOrEqual(5);
    expect(result.text.startsWith("line 0\nline 1")).toBe(true);
    expect(result.text.endsWith("line 48\nline 49")).toBe(true);
    expect(await readFile(result.spilledPath!, "utf8")).toBe(source);
  });

  it("defaults to 300 lines", async () => {
    const result = await boundText("x\n".repeat(301), { ...bounds(), maxChars: 10_000 });
    expect(result.spilledPath).toBeDefined();
    expect(result.text.split("\n").length).toBeLessThanOrEqual(300);
  });

  it("supports a single-line preview", async () => {
    const result = await boundText("a\nb\nc", { ...bounds(), maxLines: 1 });
    expect(result.text).toBe("… [5 chars omitted] …");
  });

  it("uses the default tmp/pi-browser/key spill directory", async () => {
    const result = await boundText("x".repeat(200), { maxChars: 80, label: "default" });
    expect(relative(join(tmpdir(), "pi-browser"), result.spilledPath!).split(sep)).toHaveLength(2);
    expect(await readFile(result.spilledPath!, "utf8")).toBe("x".repeat(200));
    await rm(dirname(result.spilledPath!), { recursive: true, force: true });
  });

  it("sanitizes labels and creates unique files", async () => {
    const first = await boundText("x".repeat(200), { ...bounds(), label: "../../evil" });
    const second = await boundText("y".repeat(200), { ...bounds(), label: "../../evil" });
    expect(dirname(first.spilledPath!)).toBe(spillDir);
    expect(first.spilledPath).not.toBe(second.spilledPath);
    expect(await readFile(first.spilledPath!, "utf8")).toBe("x".repeat(200));
  });

  it("rejects invalid limits", async () => {
    await expect(boundText("text", { ...bounds(), maxChars: 0 })).rejects.toThrow("positive integers");
    await expect(boundText("text", { ...bounds(), maxLines: 0 })).rejects.toThrow("positive integers");
  });
});

describe("mcpContentToToolContent", () => {
  it("joins text blocks and preserves images", async () => {
    expect(await mcpContentToToolContent([
      { type: "text", text: "one" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "text", text: "two" },
    ], bounds())).toEqual({ content: [
      { type: "text", text: "one\ntwo" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ] });
  });

  it("preserves image-only results and empty results", async () => {
    const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    expect(await mcpContentToToolContent([image], bounds())).toEqual({ content: [image] });
    expect(await mcpContentToToolContent([], bounds())).toEqual({ content: [] });
  });

  it("summarizes resource payloads without exposing base64 or raw text", async () => {
    const result = await mcpContentToToolContent([
      { type: "resource", resource: { uri: "obscura://capture/current-page.pdf", mimeType: "application/pdf", blob: "SECRETBASE64" } },
      { type: "resource", resource: { uri: "obscura://text", text: "SECRETTEXT" } },
    ], { ...bounds(), maxChars: 1000 });
    const item = result.content[0];
    if (item?.type !== "text") throw new Error("expected text");
    expect(item.text).toContain("obscura://capture/current-page.pdf");
    expect(item.text).toContain("application/pdf");
    expect(item.text).toContain("12 base64 chars");
    expect(item.text).toContain("10 text chars");
    expect(item.text).not.toContain("SECRET");
  });

  it("adds a model-facing spill notice and returns its path", async () => {
    const result = await mcpContentToToolContent([{ type: "text", text: "x".repeat(1000) }], bounds());
    const item = result.content[0];
    if (item?.type !== "text") throw new Error("expected text");
    expect(item.text).toContain("chars omitted");
    expect(item.text).toContain(result.spilledPath);
    expect(item.text).toContain("read with offset/limit");
    expect(await readFile(result.spilledPath!, "utf8")).toBe("x".repeat(1000));
  });
});
