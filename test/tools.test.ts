import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { createHarness, tool, type Harness } from "./helpers/harness.js";

const open: Harness[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.dispose(); });
async function harness(config: Record<string, unknown> = {}) {
  const h = await createHarness({ config: { artifactsDir: "artifacts", ...config } });
  open.push(h);
  return h;
}
const results = (h: Harness) => h.session.messages.filter((message) => message.role === "toolResult");
type Result = ReturnType<typeof results>[number];
const text = (result: Result) => result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
async function run(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const before = results(h).length;
  h.main.faux.setResponses([tool(name, args as Parameters<typeof tool>[1]), reply("done")]);
  await h.session.prompt(`Call ${name}`);
  expect(results(h)).toHaveLength(before + 1);
  return results(h).at(-1)!;
}
async function navigate(h: Harness) {
  expect((await run(h, "browser_navigate", { url: "https://example.com" })).isError).toBe(false);
}
const summaryMarker = "--- interactive elements";
const newTools = [
  "browser_click", "browser_fill", "browser_type", "browser_press_key", "browser_select", "browser_scroll",
  "browser_wait", "browser_screenshot", "browser_pdf", "browser_extract", "browser_tabs", "browser_state",
];

describe("interaction tools (real AgentSession, fake MCP child)", () => {
  it("registers all tools with sequential execution, exposure, and safety annotations", async () => {
    const h = await harness();
    const readOnly = new Set(["browser_wait", "browser_screenshot", "browser_pdf", "browser_extract"]);
    for (const name of newTools) {
      expect(h.session.getActiveToolNames()).toContain(name);
      expect(h.session.getToolDefinition(name)?.executionMode).toBe("sequential");
      const info = h.session.getAllTools().find((item) => item.name === name)!;
      expect(info.exposure).toBe("direct");
      expect(info.annotations).toEqual({ openWorldHint: true, readOnlyHint: readOnly.has(name) });
      expect(h.session.getToolDefinition(name)?.promptSnippet).toBeTruthy();
    }
    expect(h.children).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });

  const actions: [string, Record<string, unknown>, string][] = [
    ["browser_click", { ref: "e2" }, "Clicked 'button'"],
    ["browser_fill", { ref: "e1", value: "Alice" }, "Filled '#name' with value"],
    ["browser_type", { ref: "e1", text: "Alice", pressEnter: true }, "Pressed key 'Enter'"],
    ["browser_press_key", { key: "Tab", ref: "e1" }, "Pressed key 'Tab'"],
    ["browser_select", { ref: "e1", value: "blue" }, "Selected 'blue' in '#name'"],
    ["browser_scroll", { direction: "down", amount: 120 }, "Scrolled down."],
    ["browser_tabs", { action: "new", url: "https://example.com/next" }, "Opened tab-2"],
    ["browser_tabs", { action: "switch", tabId: "tab-1" }, "Switched to tab-1"],
    ["browser_tabs", { action: "back" }, "Navigated to"],
    ["browser_tabs", { action: "forward" }, "Navigated to"],
    ["browser_tabs", { action: "reload" }, "Navigated to"],
  ];
  it.each(actions)("%s %j adds a summary by default and permits snapshot:false", async (name, args, headline) => {
    const h = await harness({ actionSummaryChars: 17 });
    await navigate(h);
    const withSummary = await run(h, name, args);
    expect(withSummary.isError).toBe(false);
    expect(text(withSummary)).toContain(headline);
    expect(text(withSummary)).toContain("--- page text (first 17 chars) ---");
    expect(text(withSummary)).toContain("Welcome to the fa");
    expect(text(withSummary)).toContain(summaryMarker);
    expect(withSummary.details).toMatchObject({ tool: name, durationMs: expect.any(Number) });
    const withoutSummary = await run(h, name, { ...args, snapshot: false });
    expect(withoutSummary.isError).toBe(false);
    expect(text(withoutSummary)).toContain(headline.replace("Opened tab-2", "Opened tab-3"));
    expect(text(withoutSummary)).not.toContain(summaryMarker);
    expect(text(withoutSummary)).not.toContain("--- page text");
  });

  it("supports selectors, optional targets, and empty fill/type values", async () => {
    const h = await harness();
    for (const [name, args] of [
      ["browser_click", { selector: "button" }],
      ["browser_fill", { selector: "#name", value: "" }],
      ["browser_type", { selector: "#name", text: "", pressEnter: true }],
      ["browser_press_key", { key: "Escape" }],
      ["browser_press_key", { key: "Enter", selector: "#name" }],
      ["browser_select", { selector: "select", value: "blue" }],
      ["browser_scroll", {}],
      ["browser_scroll", { selector: "#name", direction: "top" }],
      ["browser_scroll", { ref: "e1", direction: "bottom" }],
    ] as [string, Record<string, unknown>][]) {
      expect((await run(h, name, args)).isError).toBe(false);
    }
  });

  it("fills forms with all field types and forwards both kinds of submit target", async () => {
    const h = await harness();
    await navigate(h);
    const fields = [
      { ref: "e1", value: "Alice", type: "text" },
      { selector: "#check", type: "check" },
      { selector: "#uncheck", type: "uncheck" },
      { selector: "select", value: "blue", type: "select" },
    ];
    const first = await run(h, "browser_fill", { fields, submit: { ref: "e2" } });
    expect(first.isError).toBe(false);
    expect(text(first)).toContain("Filled 4 fields.");
    expect(text(first)).toContain(summaryMarker);
    const second = await run(h, "browser_fill", { fields, submit: { selector: "button" }, snapshot: false });
    expect(second.isError).toBe(false);
    expect(text(second)).toBe("Filled 4 fields.");
    const value = await run(h, "browser_evaluate", { expression: "document.getElementById('name').value" });
    expect(JSON.parse(text(value))).toEqual({ ok: true, value: "Alice" });
  });

  it("preserves partial form errors verbatim without turning success into failure", async () => {
    const h = await harness();
    const result = await run(h, "browser_fill", {
      fields: [{ selector: "#name", value: "Alice" }, { selector: "#missing", value: "Bob" }], snapshot: false,
    });
    expect(result.isError).toBe(false);
    expect(text(result)).toBe("Filled 1 fields. Errors: Element not found: #missing");
  });

  const requiredTargets: [string, Record<string, unknown>][] = [
    ["browser_click", {}], ["browser_fill", { value: "Alice" }],
    ["browser_type", { text: "Alice" }], ["browser_select", { value: "blue" }],
  ];
  it.each(requiredTargets)("%s rejects both and neither target, and malformed refs", async (name, extras) => {
    const h = await harness();
    for (const target of [{ ref: "e1", selector: "#name" }, {}]) {
      const result = await run(h, name, { ...extras, ...target });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe("Provide exactly one of ref or selector.");
    }
    for (const ref of ["ref=e1", "e-1", "E1", "e1x"]) {
      const result = await run(h, name, { ...extras, ref });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("ref must match /^e\\d+$/");
    }
    expect(h.children).toHaveLength(0);
  });

  it.each(["browser_press_key", "browser_scroll"])("%s rejects ambiguous optional targets", async (name) => {
    const h = await harness();
    const result = await run(h, name, { key: "Enter", ref: "e1", selector: "#name" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Provide exactly one of ref or selector.");
  });

  it.each([
    [{}, "Provide exactly one fill mode"],
    [{ ref: "e1", value: "Alice", fields: [{ selector: "#name", value: "Bob" }] }, "Provide exactly one fill mode"],
    [{ ref: "e1" }, "Single fill mode requires value."],
    [{ selector: "#name", value: "Alice", submit: { selector: "button" } }, "submit is only supported in form fill mode."],
    [{ fields: [] }, "fields"],
    [{ fields: [{ value: "Alice" }] }, "Provide exactly one of ref or selector."],
    [{ fields: [{ selector: "#name" }], submit: { ref: "e2", selector: "button" } }, "Provide exactly one of ref or selector."],
  ] as [Record<string, unknown>, string][])("rejects invalid fill mode %j", async (args, expected) => {
    const h = await harness();
    const result = await run(h, "browser_fill", args);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(expected);
    expect(h.children).toHaveLength(0);
  });

  it("adds the refresh hint to unknown-ref errors, and snapshot makes refs usable again", async () => {
    const h = await harness();
    await navigate(h);
    expect((await run(h, "browser_click", { ref: "e2", snapshot: false })).isError).toBe(false);
    const stale = await run(h, "browser_click", { ref: "e2" });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toBe("unknown ref 'e2'; call browser_snapshot first\nRefs change after every action or navigation; call browser_snapshot and use a ref from the latest result.");
    await run(h, "browser_snapshot");
    expect((await run(h, "browser_click", { ref: "e2" })).isError).toBe(false);
  });

  it.each([
    [{ selector: "#name", timeoutMs: 1001 }, "Found '#name'"],
    [{ text: "Welcome", timeoutMs: 1 }, 'Found text "Welcome"'],
    [{ ms: 1 }, "Waited 1 ms."],
  ] as [Record<string, unknown>, string][])("waits by %j without a default summary", async (args, headline) => {
    const h = await harness();
    const result = await run(h, "browser_wait", args);
    expect(result.isError).toBe(false);
    expect(text(result)).toBe(headline);
    const summarized = await run(h, "browser_wait", { ...args, snapshot: true });
    expect(summarized.isError).toBe(false);
    expect(text(summarized)).toContain(summaryMarker);
  });

  it.each([{}, { selector: "#name", text: "Welcome" }, { text: "Welcome", ms: 1 }, { selector: "#name", ms: 1 }])("rejects ambiguous wait %j", async (args) => {
    const h = await harness();
    const result = await run(h, "browser_wait", args);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Provide exactly one of selector, text or ms.");
    expect(h.children).toHaveLength(0);
  });

  it("kills a never-resolving wait at timeoutMs + 5000 and starts a new process on the next call", async () => {
    const h = await harness({ timeoutMs: 1000 });
    await navigate(h);
    const oldPid = h.children[0]!.pid!;
    const start = Date.now();
    const result = await run(h, "browser_wait", { selector: "#never", timeoutMs: 1 });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Browser request exceeded 5001 ms");
    expect(text(result)).toContain("open tabs were lost");
    expect(Date.now() - start).toBeGreaterThanOrEqual(4900);
    expect((await run(h, "browser_snapshot")).isError).toBe(false);
    expect(h.children).toHaveLength(2);
    expect(h.children[1]!.pid).not.toBe(oldPid);
    expect(h.children[0]!.exitCode !== null || h.children[0]!.signalCode !== null).toBe(true);
  }, 10_000);

  it("aborts an in-process wait without launching a browser", async () => {
    const h = await harness();
    const unsubscribe = h.session.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolName === "browser_wait") {
        setTimeout(() => { void h.session.abort(); }, 20);
      }
    });
    const start = Date.now();
    try {
      h.main.faux.setResponses([tool("browser_wait", { ms: 30000 }), reply("done")]);
      await h.session.prompt("Wait, then abort");
      expect(Date.now() - start).toBeLessThan(2000);
      expect(h.children).toHaveLength(0);
    } finally { unsubscribe(); }
  });
});

describe("artifact tools", () => {
  it("writes a PNG under the relative artifactsDir and returns exactly one matching image block", async () => {
    const h = await harness();
    const result = await run(h, "browser_screenshot", { width: 320, height: 200 });
    expect(result.isError).toBe(false);
    const details = result.details as { path: string; bytes: number; width: number; height: number };
    expect(details).toMatchObject({ tool: "browser_screenshot", durationMs: expect.any(Number), width: 320, height: 200 });
    expect(details.path).toMatch(new RegExp(`^${join(h.cwd, "artifacts")}/screenshot-\\d+\\.png$`));
    const bytes = await readFile(details.path);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([320, 200]);
    const images = result.content.filter((item) => item.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]!.mimeType).toBe("image/png");
    expect(Buffer.from(images[0]!.data, "base64")).toEqual(bytes);
    expect(result.content.filter((item) => item.type === "text")).toHaveLength(1);
    expect(text(result)).toBe(`Screenshot saved to ${details.path} (320×200 px, ${bytes.length} bytes)`);
    expect((await stat(join(h.cwd, "artifacts"))).mode & 0o777).toBe(0o700);
    expect((await stat(details.path)).mode & 0o777).toBe(0o600);
  });

  it("saves PDF bytes at a cwd-relative explicit path, never exposing the resource or base64", async () => {
    const h = await harness();
    const result = await run(h, "browser_pdf", {
      path: "captures/report.pdf", landscape: true, printBackground: false, scale: 0.5,
      paperWidth: 8.5, paperHeight: 11, marginTop: 0, marginBottom: 1, marginLeft: 2, marginRight: 3,
    });
    expect(result.isError).toBe(false);
    const path = join(h.cwd, "captures/report.pdf");
    expect(result.details).toMatchObject({ path, tool: "browser_pdf", durationMs: expect.any(Number) });
    const bytes = await readFile(path);
    expect(bytes.toString("ascii", 0, 4)).toBe("%PDF");
    expect(result.content).toEqual([{ type: "text", text: `PDF saved to ${path} (${bytes.length} bytes)` }]);
    expect(JSON.stringify(result.content)).not.toContain(bytes.toString("base64"));
    expect(JSON.stringify(result.content)).not.toMatch(/blob|base64|obscura:\/\//);
  });

  it.each([
    ["browser_screenshot", { path: "fixed.png" }],
    ["browser_pdf", { path: "fixed.pdf" }],
    ["browser_state", { action: "export", path: "fixed.json" }],
  ] as [string, Record<string, unknown>][])("%s refuses to overwrite an explicit path", async (name, args) => {
    const h = await harness();
    const first = await run(h, name, args);
    expect(first.isError).toBe(false);
    const path = join(h.cwd, String(args.path));
    const original = await readFile(path);
    const second = await run(h, name, args);
    expect(second.isError).toBe(true);
    expect(text(second)).toContain("File already exists:");
    expect(text(second)).toContain("Pick another path");
    expect(await readFile(path)).toEqual(original);
  });

  it("uses unique default artifact filenames", async () => {
    const h = await harness();
    for (const [name, args, prefix, ext] of [
      ["browser_screenshot", {}, "screenshot", "png"], ["browser_pdf", {}, "page", "pdf"],
      ["browser_state", { action: "export" }, "state", "json"],
    ] as [string, Record<string, unknown>, string, string][]) {
      const first = await run(h, name, args);
      const second = await run(h, name, args);
      expect(first.isError || second.isError).toBe(false);
      const a = (first.details as { path: string }).path, b = (second.details as { path: string }).path;
      expect(a).not.toBe(b);
      expect(a).toMatch(new RegExp(`/${prefix}-\\d+\\.${ext}$`));
      expect((await stat(a)).isFile()).toBe(true);
      expect((await stat(b)).isFile()).toBe(true);
    }
  });

  it.each([
    ["browser_screenshot", { width: 0 }], ["browser_screenshot", { height: 32769 }],
    ["browser_pdf", { scale: 0.09 }], ["browser_pdf", { scale: 2.1 }],
    ["browser_pdf", { paperWidth: 201 }], ["browser_pdf", { paperHeight: 201 }],
    ["browser_pdf", { marginTop: -1 }], ["browser_pdf", { marginBottom: -1 }],
    ["browser_pdf", { marginLeft: -1 }], ["browser_pdf", { marginRight: -1 }],
    ["browser_wait", { ms: 0 }], ["browser_wait", { ms: 30001 }],
  ] as [string, Record<string, unknown>][])("validates numeric bounds in %s %j", async (name, args) => {
    const h = await harness();
    expect((await run(h, name, args)).isError).toBe(true);
    expect(h.children).toHaveLength(0);
  });
});

describe("extraction, tabs, and storage state", () => {
  it.each([
    [{ mode: "markdown", maxChars: 100 }, "# Fake Browser Page"],
    [{ mode: "links", limit: 1, internalOnly: true }, "Next → https://example.com/next"],
    [{ mode: "search", query: "welcome", caseSensitive: false, limit: 1, contextChars: 2 }, "1. Welcome"],
    [{ mode: "schema", schema: { "links[]": "a@href", body: "body" } }, '"links": ['],
    [{ mode: "forms" }, '"fields": ['],
    [{ mode: "console" }, "hello from page"],
    [{ mode: "network" }, "GET https://example.com → 200"],
  ] as [Record<string, unknown>, string][])("extracts %j without adding a summary", async (args, expected) => {
    const h = await harness();
    await navigate(h);
    const result = await run(h, "browser_extract", args);
    expect(result.isError).toBe(false);
    expect(text(result)).toContain(expected);
    expect(text(result)).not.toContain(summaryMarker);
    expect(result.details).toMatchObject({ tool: "browser_extract", durationMs: expect.any(Number), mode: args.mode });
    if (args.mode === "schema") expect(JSON.parse(text(result))).toMatchObject({ links: ["https://example.com/next"], body: expect.any(String) });
  });

  it.each([
    ["browser_tabs", { action: "switch" }, "Switch action requires tabId."],
    ["browser_tabs", { action: "new", url: "file:///tmp/page" }, "only http: and https:"],
    ["browser_tabs", { action: "new", url: "not a URL" }, "valid http: or https:"],
    ["browser_extract", { mode: "search" }, "Search mode requires query."],
    ["browser_extract", { mode: "schema" }, "Schema mode requires a schema object."],
    ["browser_state", { action: "set_cookie" }, "set_cookie action requires cookie."],
    ["browser_state", { action: "import" }, "Import action requires path."],
  ] as [string, Record<string, unknown>, string][])("%s validates required action parameters %j", async (name, args, expected) => {
    const h = await harness();
    const result = await run(h, name, args);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(expected);
    expect(h.children).toHaveLength(0);
  });

  it("lists, switches, and closes tabs; list and close never include summaries", async () => {
    const h = await harness();
    await navigate(h);
    await run(h, "browser_tabs", { action: "new", url: "https://example.com/next" });
    const list = await run(h, "browser_tabs", { action: "list", snapshot: true });
    expect(list.isError).toBe(false);
    expect(text(list)).toContain("tab-1:");
    expect(text(list)).toContain("tab-2 (active):");
    expect(text(list)).not.toContain(summaryMarker);
    const switched = await run(h, "browser_tabs", { action: "switch", tabId: "tab-1" });
    expect(text(switched)).toContain("URL: https://example.com | Title:");
    const closed = await run(h, "browser_tabs", { action: "close", tabId: "tab-2", snapshot: true });
    expect(text(closed)).toBe("Closed tab-2.");
    expect(closed.details).toMatchObject({ action: "close" });
    expect(text(await run(h, "browser_tabs", { action: "close" }))).toBe("Closed tab-1.");
    expect(text(await run(h, "browser_tabs", { action: "list" }))).toBe("No open tabs.");
  });

  it("roundtrips cookies and active-origin storage via a JSON file", async () => {
    const h = await harness();
    await navigate(h);
    expect((await run(h, "browser_state", { action: "set_cookie", cookie: {
      name: "session", value: "secret", domain: "example.com", path: "/", secure: true, httpOnly: true,
    } })).isError).toBe(false);
    const cookies = await run(h, "browser_state", { action: "cookies", domain: "example.com" });
    expect(JSON.parse(text(cookies))).toMatchObject({ name: "session", value: "secret", http_only: true, secure: true });
    expect(text(await run(h, "browser_state", { action: "cookies", domain: "other.example" }))).toBe("No cookies.");
    await run(h, "browser_evaluate", { expression: "localStorage.setItem('name', 'Alice')" });
    const exported = await run(h, "browser_state", { action: "export", path: "states/saved.json" });
    expect(exported.isError).toBe(false);
    const path = join(h.cwd, "states/saved.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    expect(state).toMatchObject({ cookies: [{ name: "session" }], origins: [{ origin: "https://example.com", localStorage: [["name", "Alice"]], sessionStorage: [] }] });
    expect(text(exported)).toContain("(1 cookies, 1 origins)");
    expect(text(exported)).toContain("Only the active page's origin storage is included.");
    expect(exported.details).toMatchObject({ path, cookies: 1, origins: 1 });
    expect(text(await run(h, "browser_state", { action: "clear_cookies" }))).toBe("Cleared all cookies.");
    await run(h, "browser_evaluate", { expression: "localStorage.clear()" });
    expect(text(await run(h, "browser_state", { action: "cookies" }))).toBe("No cookies.");
    const imported = await run(h, "browser_state", { action: "import", path: "states/saved.json" });
    expect(imported.isError).toBe(false);
    expect(text(imported)).toBe("Restored 1 cookies; applied 1 storage entries to https://example.com.");
    expect(imported.details).toMatchObject({ path, cookies: 1, origins: 1, storageApplied: 1, storageOrigin: "https://example.com", queuedOrigins: [] });
    expect(JSON.parse(text(await run(h, "browser_state", { action: "cookies" })))).toMatchObject({ name: "session", value: "secret" });
    expect(JSON.parse(text(await run(h, "browser_evaluate", { expression: "localStorage.getItem('name')" })))).toEqual({ ok: true, value: "Alice" });
  });

  it("imports both stores as safe JSON data, including quotes, backslashes, script tags and newlines", async () => {
    const h = await harness();
    await navigate(h);
    const value = "quotes \"' backslash \\ </script>\nline two";
    const key = "key\"\\\n";
    await writeFile(join(h.cwd, "safe.json"), JSON.stringify({ cookies: [], origins: [{ origin: "https://example.com", localStorage: [[key, value]], sessionStorage: [["s", value]] }] }));
    const imported = await run(h, "browser_state", { action: "import", path: "safe.json" });
    expect(imported.isError).toBe(false);
    expect(text(imported)).toBe("Restored 0 cookies; applied 2 storage entries to https://example.com.");
    const result = await run(h, "browser_evaluate", { expression: `({ local: localStorage.getItem(${JSON.stringify(key)}), session: sessionStorage.getItem('s') })` });
    expect(JSON.parse(text(result))).toEqual({ ok: true, value: { local: value, session: value } });
  });

  it.each(["new", "switch"])("queues other-origin storage and applies it on tab %s", async (action) => {
    const h = await harness();
    await navigate(h);
    if (action === "switch") {
      await run(h, "browser_tabs", { action: "new", url: "https://other.example/page" });
      await run(h, "browser_tabs", { action: "switch", tabId: "tab-1" });
    }
    await writeFile(join(h.cwd, "queued.json"), JSON.stringify({ cookies: [], origins: [{ origin: "https://other.example", localStorage: [["k", "v"]], sessionStorage: [["s", "1"]] }] }));
    const imported = await run(h, "browser_state", { action: "import", path: "queued.json" });
    expect(imported.isError).toBe(false);
    expect(text(imported)).toContain("queued storage for 1 other origin (applied on the next navigation there)");
    expect(imported.details).toMatchObject({ storageApplied: 0, queuedOrigins: ["https://other.example"] });
    const before = await run(h, "browser_evaluate", { expression: "localStorage.getItem('k')" });
    expect(JSON.parse(text(before)).value).toBeNull();
    const applied = await run(h, "browser_tabs", action === "new" ? { action, url: "https://other.example/page", snapshot: false } : { action, tabId: "tab-2", snapshot: false });
    expect(text(applied)).toContain("Applied 2 queued storage entries for https://other.example.");
    expect(JSON.parse(text(await run(h, "browser_evaluate", { expression: "[localStorage.getItem('k'), sessionStorage.getItem('s')]" }))).value).toEqual(["v", "1"]);
    expect(text(await run(h, "browser_tabs", { action: "reload", snapshot: false }))).not.toContain("queued storage");
  });

  it("reset clears pending origin storage", async () => {
    const h = await harness();
    await writeFile(join(h.cwd, "queued.json"), JSON.stringify({ cookies: [], origins: [{ origin: "https://other.example", localStorage: [["k", "v"]] }] }));
    expect(text(await run(h, "browser_state", { action: "import", path: "queued.json" }))).toContain("queued storage for 1 other origin");
    await run(h, "browser_state", { action: "reset" });
    expect(text(await run(h, "browser_tabs", { action: "new", url: "https://other.example", snapshot: false }))).not.toContain("queued storage");
    expect(JSON.parse(text(await run(h, "browser_evaluate", { expression: "localStorage.getItem('k')" }))).value).toBeNull();
  });


  it.each(["null", "{}", '{"cookies":{},"origins":[]}', '{"cookies":[],"origins":{}}'])("rejects invalid storage-state shape %s before starting", async (json) => {
    const h = await harness();
    await writeFile(join(h.cwd, "invalid.json"), json);
    const result = await run(h, "browser_state", { action: "import", path: "invalid.json" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Storage state must be a JSON object with cookies and origins arrays");
    expect(h.children).toHaveLength(0);
  });

  it("reset kills the old process, clears cookies and tabs, and starts a fresh pid", async () => {
    const h = await harness();
    await navigate(h);
    await run(h, "browser_tabs", { action: "new" });
    await run(h, "browser_state", { action: "set_cookie", cookie: { name: "session", value: "secret", domain: "example.com" } });
    const previousPid = h.children[0]!.pid!;
    const reset = await run(h, "browser_state", { action: "reset" });
    expect(reset.isError).toBe(false);
    expect(text(reset)).toBe("Browser reset: cookies cleared, tabs closed, process restarted.");
    expect(h.children).toHaveLength(2);
    const pid = h.children[1]!.pid!;
    expect(pid).not.toBe(previousPid);
    expect(reset.details).toMatchObject({ action: "reset", previousPid, pid });
    expect(h.children[0]!.exitCode !== null || h.children[0]!.signalCode !== null).toBe(true);
    expect(text(await run(h, "browser_state", { action: "cookies" }))).toBe("No cookies.");
    const tabs = text(await run(h, "browser_tabs", { action: "list" }));
    expect(tabs).not.toContain("tab-2");
    expect(tabs).not.toContain("https://example.com");
  });

  it("deferred exposure removes every registered browser tool from the active set, including after reload", async () => {
    const h = await harness({ exposure: "deferred" });
    const names = h.session.getAllTools().map((item) => item.name).filter((name) => name.startsWith("browser_"));
    expect(names).toHaveLength(16);
    expect(names).toContain("browser_fetch");
    expect(names).toEqual(expect.arrayContaining(newTools));
    for (const name of names) {
      expect(h.session.getActiveToolNames()).not.toContain(name);
      expect(h.session.getAllTools().find((item) => item.name === name)?.exposure).toBe("deferred");
    }
    expect(h.children).toHaveLength(0);
    await h.session.prompt("/browser restart");
    expect(h.children).toHaveLength(1);
    expect(h.session.getActiveToolNames().filter((name) => name.startsWith("browser_"))).toEqual([]);
  });
});
