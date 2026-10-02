import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { BROWSER_USAGE, decodeEvaluation } from "../src/extension/index.js";
import { summarizePage } from "../src/page.js";
import { ObscuraEngine } from "../src/engines/obscura.js";
import { DEFAULT_BROWSER_CONFIG } from "../src/config.js";
import type { BrowserSession } from "../src/session.js";
import { createHarness, tool, type Harness } from "./helpers/harness.js";

const open: Harness[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.dispose(); });
async function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const h = await createHarness({ ...options, config: { exposure: "direct", ...options.config } }); open.push(h); return h;
}
const results = (h: Harness) => h.session.messages.filter((message) => message.role === "toolResult");
const resultText = (h: Harness) => results(h).map((message) => message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n")).join("\n");
const lastText = (h: Harness) => results(h).at(-1)!.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
async function run(h: Harness, name: string, args: Parameters<typeof tool>[1] = {}) {
  if (!h.manager.active()) await h.manager.select();
  h.main.faux.setResponses([tool(name, args), reply("done")]);
  await h.session.prompt(`Call ${name}`);
  expect(results(h).at(-1)?.isError).toBe(false);
  return results(h).at(-1)!;
}
const savedStorage = { cookies: [], origins: [{ origin: "https://stored.example", localStorage: [["k", "v"]], sessionStorage: [["s", "1"]] }] };
const storageExpression = "({ localStorage: localStorage.getItem('k'), sessionStorage: sessionStorage.getItem('s') })";
async function writeState(h: Harness) {
  const path = join(h.cwd, "state.json");
  await writeFile(path, JSON.stringify(savedStorage));
  return path;
}

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

describe("browser extension (real AgentSession, faux provider)", () => {
  it.each(["ask", "never"] as const)("shows exactly one short startup notice for autoInstall %s when obscura is missing", async (autoInstall) => {
    const version = "0.2.4";
    const h = await harness({
      config: { autoInstall, version, binaryPath: "/nonexistent/pi-browser/obscura" },
      extension: { env: {}, pathDirs: [] },
    });
    expect(h.notifications).toEqual([{
      message: autoInstall === "ask"
        ? "browser: obscura is not installed yet. Run /browser install, or accept the download prompt when a browser tool is first used."
        : `browser: obscura not found (config.binaryPath / PI_BROWSER_OBSCURA_BIN / PATH / ${join(h.agentDir, "pi-browser", "obscura", version, process.platform === "win32" ? "obscura.exe" : "obscura")}). Install it manually or run /browser install.`,
      type: autoInstall === "ask" ? "info" : "warning",
    }]);
    expect(h.confirmations).toEqual([]);
    expect(h.children).toHaveLength(0);
  });

  it.each(["ask", "never"] as const)("does not notify at startup when obscura resolves with autoInstall %s", async (autoInstall) => {
    const h = await harness({
      config: { autoInstall, binaryPath: process.execPath },
      extension: { env: {}, pathDirs: [] },
    });
    expect(h.notifications).toEqual([]);
    expect(h.children).toHaveLength(0);
  });

  it.each(["browser_navigate", "browser_fetch"])("keeps full missing-binary diagnostics for %s errors", async (name) => {
    const h = await harness({
      config: { autoInstall: "never", binaryPath: "/nonexistent/pi-browser/obscura" },
      extension: { env: {}, pathDirs: [] },
      steps: [tool(name, { url: "https://example.com" }), reply("done")],
    });
    await h.session.prompt("Open the page");
    expect(results(h)[0]?.isError).toBe(true);
    expect(resultText(h)).toContain("Obscura executable not found");
    expect(resultText(h)).toContain("PI_BROWSER_OBSCURA_BIN");
    expect(resultText(h)).toContain("The managed cache was also checked");
    expect(resultText(h)).toContain('Run /browser install to download the pinned release v0.2.3, or set autoInstall to "ask" to be prompted on first use.');
    expect(h.children).toHaveLength(0);
    expect(h.confirmations).toEqual([]);
  });


  it("registers core active tools without launching, including safety annotations and guidelines", async () => {
    const h = await harness();
    expect(h.children).toHaveLength(0);
    expect(h.errors).toEqual([]);
    for (const name of ["browser_navigate", "browser_snapshot", "browser_evaluate"]) {
      expect(h.session.getActiveToolNames()).toContain(name);
      const info = h.session.getAllTools().find((item) => item.name === name)!;
      expect(info.exposure).toBe("direct");
      expect(info.annotations).toEqual({ openWorldHint: true, readOnlyHint: name === "browser_snapshot" });
      expect(info.promptGuidelines?.join()).toContain("invalidated by every action");
      expect(h.session.getToolDefinition(name)?.executionMode).toBe("sequential");
    }
    expect(h.statuses).toContainEqual({ key: "browser", text: "browser: idle" });
  });

  it("navigates via the faux model, returns current refs, and shutdown kills the child", async () => {
    const h = await harness({ steps: [tool("browser_navigate", { url: "https://example.com", waitUntil: "domcontentloaded" }), reply("done")] });
    await h.session.prompt("Open the page");
    expect(resultText(h)).toContain("URL: https://example.com | Title: Fake Browser Page");
    expect(resultText(h)).toContain('e1 input "Name"');
    expect(resultText(h)).toContain('e2 button "Go"');
    expect(resultText(h)).not.toContain("ref=");
    expect(resultText(h)).not.toContain("element(s) registered");
    expect(results(h)[0]).toMatchObject({ isError: false, details: { tool: "browser_navigate", durationMs: expect.any(Number) } });
    const pid = h.children[0]!.pid!;
    expect(alive(pid)).toBe(true);
    expect(h.statuses).toContainEqual({ key: "browser", text: `browser: running (pid ${pid})` });
    await h.shutdown();
    expect(alive(pid)).toBe(false);
    await h.shutdown();
    expect(h.statuses.at(-1)?.text).toBe("browser: idle");
  });

  it.each([
    ["document.title", false, '"value": "Fake Browser Page"'],
    ["undefined", false, '"value": null'],
    ["null", false, '"ok": true'],
    ["1n", false, '"value": "1"'],
    ["Symbol('x')", false, '"value": "Symbol(x)"'],
    ["(() => 1)", false, '"value": "() => 1"'],
    ["(() => { const a = {}; a.self = a; return a; })()", false, '"value": "[object Object]"'],
    ["(() => { throw new Error('OH_NO'); })()", true, "OH_NO"],
    ["let x = 1;", true, "single expression or an IIFE"],
  ])("maps evaluation %s (error=%s)", async (expression, isError, expected) => {
    const h = await harness({ steps: [tool("browser_evaluate", { expression }), reply("done")] });
    await h.manager.select();
    await h.session.prompt("Evaluate");
    expect(results(h)[0]?.isError).toBe(isError);
    expect(resultText(h)).toContain(expected);
  });

  it.each(["file:///tmp/page", "data:text/html,hi", "javascript:alert(1)", "not a URL"])("rejects unsafe or invalid URL %s without starting", async (url) => {
    const h = await harness({ steps: [tool("browser_navigate", { url }), reply("done")] });
    await h.session.prompt("Open");
    expect(results(h)[0]?.isError).toBe(true);
    expect(resultText(h)).toContain("http:");
    expect(h.children).toHaveLength(0);
  });

  it("adds the private-network opt-in hint to obscura errors", async () => {
    const h = await harness({ steps: [tool("browser_navigate", { url: "https://private-block.example" }), reply("done")] });
    await h.session.prompt("Open");
    expect(results(h)[0]?.isError).toBe(true);
    expect(resultText(h)).toContain('"allowPrivateNetwork": true');
    expect(resultText(h)).toContain(`${h.cwd}/.pi/browser.config.json`);
  });

  it("bounds output, records the spill path, and supports snapshot without interactive refs", async () => {
    const h = await harness({ config: { maxOutputChars: 100 }, steps: [tool("browser_snapshot", { maxChars: 4000, interactive: false }), reply("done")] });
    if (!h.notifications.some(n => n.message.includes("unknown key"))) await h.manager.select();
    await h.session.prompt("Read");
    const details = results(h)[0]?.details as { spilledPath: string };
    const full = await readFile(details.spilledPath, "utf8");
    expect(full).toContain("Fake Browser Page");
    expect(full).not.toContain("--- interactive elements");
    expect(resultText(h)).toContain("chars omitted");
  });

  it("prints status and strict command usage, then restarts with changed config", async () => {
    const h = await harness();
    await h.session.prompt("/browser status");
    expect(h.notifications.at(-1)?.message).toContain(`Binary: ${process.execPath} (config)`);
    expect(h.notifications.at(-1)?.message).toContain(`Config sources: ${join(h.agentDir, "browser.config.json")}`);
    expect(h.notifications.at(-1)?.message).toContain("Config errors: none");
    for (const args of ["", "install extra args", "Status", "status extra", "stop extra", "restart now"]) {
      await h.session.prompt(`/browser ${args}`.trimEnd());
      expect(h.notifications.at(-1)?.message).toBe(BROWSER_USAGE);
    }
    expect(h.children).toHaveLength(0);
    await writeFile(join(h.agentDir, "browser.config.json"), JSON.stringify({ binaryPath: process.execPath, exposure: "deferred" }));
    await h.session.prompt("/browser restart");
    expect(h.children).toHaveLength(1);
    expect(h.session.getActiveToolNames()).not.toContain("browser_navigate");
    expect(h.session.getAllTools().find((info) => info.name === "browser_navigate")?.exposure).toBe("deferred");
    await h.session.prompt("/browser status");
    expect(h.notifications.at(-1)?.message).toContain("browser: running");
    await h.session.prompt("/browser stop");
    expect(alive(h.children[0]!.pid!)).toBe(false);
  });

  it("profile load reports and restores storage to the matching active origin", async () => {
    const h = await harness();
    await run(h, "browser_navigate", { url: "https://stored.example/page" });
    const dir = join(h.agentDir, "pi-browser", "profiles");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "test.json"), JSON.stringify(savedStorage));
    await h.session.prompt("/browser profile load test");
    expect(h.notifications.at(-1)?.message).toContain("Restored 0 cookies; applied 2 storage entries to https://stored.example.");
    await run(h, "browser_evaluate", { expression: storageExpression });
    expect(JSON.parse(lastText(h)).value).toEqual({ localStorage: "v", sessionStorage: "1" });
  });

  it("shares queued state imports with browser_navigate and applies once without notifications", async () => {
    const h = await harness();
    const path = await writeState(h);
    const imported = await run(h, "browser_state", { action: "import", path });
    expect(imported.details).toMatchObject({ queuedOrigins: ["https://stored.example"], storageApplied: 0 });
    expect(lastText(h)).toContain("queued storage for 1 other origin");
    const notifications = h.notifications.length;
    await run(h, "browser_navigate", { url: "https://stored.example/page" });
    expect(lastText(h)).toContain("Applied 2 queued storage entries for https://stored.example.");
    expect(h.notifications).toHaveLength(notifications);
    await run(h, "browser_evaluate", { expression: storageExpression });
    expect(JSON.parse(lastText(h)).value).toEqual({ localStorage: "v", sessionStorage: "1" });
    await run(h, "browser_navigate", { url: "https://stored.example/next" });
    expect(lastText(h)).not.toContain("queued storage entries");
  });

  it.each(["stop", "restart"])("%s clears pending origin storage", async (command) => {
    const h = await harness();
    await run(h, "browser_state", { action: "import", path: await writeState(h) });
    expect(lastText(h)).toContain("queued storage for 1 other origin");
    await h.session.prompt(`/browser ${command}`);
    await run(h, "browser_navigate", { url: "https://stored.example/page" });
    expect(lastText(h)).not.toContain("queued storage entries");
    await run(h, "browser_evaluate", { expression: storageExpression });
    expect(JSON.parse(lastText(h)).value).toEqual({ localStorage: null, sessionStorage: null });
  });

  it("auto-restored profile storage queues after handshake and applies on first navigation", async () => {
    const h = await harness({ config: { profile: "test" } });
    const dir = join(h.agentDir, "pi-browser", "profiles");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "test.json"), JSON.stringify(savedStorage));
    await run(h, "browser_navigate", { url: "https://stored.example/page" });
    expect(lastText(h)).toContain("Applied 2 queued storage entries for https://stored.example.");
    await run(h, "browser_evaluate", { expression: storageExpression });
    expect(JSON.parse(lastText(h)).value).toEqual({ localStorage: "v", sessionStorage: "1" });
  });


  it("warns about invalid config and absent binary but leaves tools registered", async () => {
    const h = await harness({ config: { mystery: true }, extension: { env: {}, pathDirs: [] }, steps: [tool("browser_navigate", { url: "https://example.com" }), reply("done")] });
    expect(h.notifications.some((note) => note.message.includes("unknown key"))).toBe(true);
    expect(h.notifications.some((note) => note.message.includes("/browser install"))).toBe(true);
    if (!h.notifications.some(n => n.message.includes("unknown key"))) await h.manager.select();
    await h.session.prompt("Read");
    expect(results(h)[0]?.isError).toBe(true);
    expect(resultText(h)).toContain("PI_BROWSER_OBSCURA_BIN");
    expect(h.children).toHaveLength(0);
  });
});

describe("page parsing and evaluation defenses", () => {
  it("calls snapshot first and listing last, preserving unknown formats", async () => {
    const order: string[] = [];
    const summary = await summarizePage(new ObscuraEngine({ config: DEFAULT_BROWSER_CONFIG, session: { async call(name: string) {
      order.push(name);
      return { content: [{ type: "text", text: name === "browser_snapshot" ? "Unknown raw format" : 'ref=e1    input[text]            "Name" name="n"' }], isError: false };
    } } as unknown as BrowserSession }), { maxChars: 4000 });
    expect(order).toEqual(["browser_snapshot", "browser_interactive_elements"]);
    expect(summary).toContain("Unknown raw format");
    expect(summary).toContain('e1 input[text] "Name" name="n"');
  });
  it("rejects malformed evaluate responses", () => {
    for (const raw of ["null", "not json", "{}", '"hello"']) expect(() => decodeEvaluation(raw)).toThrow("could not be evaluated");
  });
});
