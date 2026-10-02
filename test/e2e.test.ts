import { constants, accessSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { createHarness, tool, type Harness } from "./helpers/harness.js";
import { DEFAULT_BROWSER_CONFIG } from "../src/config.js";
import { decodeEvaluation, wrapExpression } from "../src/extension/index.js";
import { registerInteractionTools } from "../src/extension/tools.js";
import { checkedText, contentText, summarizePage } from "../src/page.js";
import { BrowserSession } from "../src/session.js";

const binary = "/tmp/obscura-investigation-bin/obscura";
let binaryAvailable = false;
try { accessSync(binary, constants.X_OK); binaryAvailable = true; } catch { /* Optional local binary only; never downloaded. */ }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The original BrowserSession E2E now also executes the actual registered interaction tools.
describe.skipIf(!binaryAvailable)("obscura v0.2.3 real-binary E2E", () => {
  it("interacts, extracts, exports artifacts/state, manages tabs, resets, and recovers from a hung script", async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      if (request.url === "/next") {
        response.end(`<!doctype html><html><head><title>Pi Browser Next</title></head><body>Second fixture page<a href="/">Back</a></body></html>`);
        return;
      }
      response.end(`<!doctype html><html><head><title>Pi Browser Fixture</title></head><body>
<label for="name">Name</label><input id="name" name="name" type="text">
<button id="go" onclick="document.getElementById('result').textContent='Clicked'">Go</button>
<div id="result">Ready</div>
<form id="form" onsubmit="event.preventDefault(); document.getElementById('submitted').textContent='Submitted'">
<label for="second">Second</label><input id="second" name="second" type="text">
<select id="choice" name="choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
<button type="submit">Submit</button></form><div id="submitted">Not submitted</div>
<a href="/next">Next</a><script>console.log('hello from page');</script></body></html>`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port");
    const url = `http://127.0.0.1:${address.port}/`;
    const cwd = await mkdtemp(join(tmpdir(), "browser-e2e-"));
    const config = { ...DEFAULT_BROWSER_CONFIG, artifactsDir: "artifacts", allowPrivateNetwork: true, evaluateTimeoutMs: 2000 };
    const session = new BrowserSession({ binary, source: "config", config });
    const observed = new Map<string, string>();
    const originalCall = session.call.bind(session);
    session.call = async (name, args, options) => {
      const result = await originalCall(name, args, options);
      if (!result.isError) observed.set(name, contentText(result.content));
      return result;
    };
    const tools = new Map<string, ToolDefinition>();
    registerInteractionTools({ registerTool: (definition: ToolDefinition) => { tools.set(definition.name, definition); } } as ExtensionAPI, {
      config: () => config, getSession: async () => session, now: Date.now, guideline: "Use current refs.",
    });
    const ctx = { cwd } as ExtensionToolContext;
    const run = async (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.execute("e2e", args, undefined, undefined, ctx);
    const runText = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await run(name, args);
      return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    };
    const evaluate = async (expression: string) => JSON.parse(decodeEvaluation(checkedText(await session.call("browser_evaluate", { expression: wrapExpression(expression) })))).value;
    try {
      checkedText(await session.call("browser_navigate", { url }));
      const rawSnapshot = checkedText(await session.call("browser_snapshot", { max_chars: 4000 }));
      const rawListing = checkedText(await session.call("browser_interactive_elements", { limit: 60 }));
      const summary = await summarizePage(session, { maxChars: 4000 });
      expect(summary).toContain("Pi Browser Fixture");
      // Obscura uses the name attribute as the label here, not the associated <label> text.
      expect(summary).toMatch(/e1\s+input(?:\[text\])?\s+/);
      console.info("Observed obscura snapshot:", JSON.stringify(rawSnapshot));
      console.info("Observed obscura listing:", JSON.stringify(rawListing));
      expect(await evaluate("document.title")).toBe("Pi Browser Fixture");
      console.info("Observed obscura evaluate (wrapped):", JSON.stringify(observed.get("browser_evaluate")));

      expect(await runText("browser_fill", { ref: "e1", value: "Alice" })).toContain("--- interactive elements");
      console.info("Observed obscura fill:", JSON.stringify(observed.get("browser_fill")));
      expect(await evaluate("document.getElementById('name').value")).toBe("Alice");
      await run("browser_click", { selector: "#go" });
      console.info("Observed obscura click:", JSON.stringify(observed.get("browser_click")));
      expect(await evaluate("document.getElementById('result').textContent")).toBe("Clicked");
      expect(await runText("browser_type", { selector: "#second", text: "Bob", pressEnter: true })).toContain("Pressed key 'Enter'");
      expect(await evaluate("document.getElementById('second').value")).toBe("Bob");
      await run("browser_select", { selector: "#choice", value: "b" });
      expect(await evaluate("document.getElementById('choice').value")).toBe("b");
      expect(await runText("browser_wait", { text: "Clicked", timeoutMs: 2000 })).toContain("Found text");
      expect(await runText("browser_extract", { mode: "markdown" })).toContain("Clicked");
      expect(await runText("browser_extract", { mode: "links" })).toContain(`${url}next`);
      expect(await runText("browser_extract", { mode: "search", query: "Clicked" })).toContain("Clicked");
      expect(await runText("browser_extract", { mode: "console" })).toContain("hello from page");
      expect(await runText("browser_extract", { mode: "network" })).toContain(url);

      const screenshot = await run("browser_screenshot", { width: 320, height: 200 });
      expect(screenshot.content.filter((item) => item.type === "image")).toHaveLength(1);
      expect(screenshot.content.find((item) => item.type === "text")?.text).toContain("320×200 px");
      const png = await readFile((screenshot.details as { path: string }).path);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([320, 200]);
      const pdf = await run("browser_pdf", { printBackground: true, landscape: false });
      const pdfBytes = await readFile((pdf.details as { path: string }).path);
      expect(pdfBytes.toString("ascii", 0, 4)).toBe("%PDF");
      expect(pdf.content).toEqual([{ type: "text", text: expect.stringMatching(/^PDF saved to .* \(\d+ bytes\)$/) }]);
      expect(JSON.stringify(pdf.content)).not.toContain(pdfBytes.toString("base64"));

      await run("browser_tabs", { action: "new", url: `${url}next` });
      const tabList = await runText("browser_tabs", { action: "list" });
      console.info("Observed obscura tab_list:", JSON.stringify(observed.get("browser_tab_list")));
      expect([...new Set(tabList.match(/tab-\d+/g))]).toHaveLength(2);
      expect(tabList).toContain("Pi Browser Next");
      await run("browser_tabs", { action: "switch", tabId: "tab-1" });
      await run("browser_tabs", { action: "close", tabId: "tab-2" });
      expect([...new Set((await runText("browser_tabs", { action: "list" })).match(/tab-\d+/g))]).toEqual(["tab-1"]);

      expect(await runText("browser_state", { action: "cookies" })).toBe("No cookies.");
      await run("browser_state", { action: "set_cookie", cookie: { name: "pi_session", value: "roundtrip", domain: "127.0.0.1", path: "/", httpOnly: true } });
      const cookies = await runText("browser_state", { action: "cookies", domain: "127.0.0.1" });
      console.info("Observed obscura get_cookies:", JSON.stringify(observed.get("browser_get_cookies")));
      expect(cookies).toContain("pi_session");
      expect(cookies).toContain("roundtrip");
      await evaluate("(() => { localStorage.setItem('fixtureKey', 'fixtureValue'); sessionStorage.setItem('fixtureSessionKey', 'fixtureSessionValue'); })()");
      const exported = await run("browser_state", { action: "export" });
      console.info("Observed obscura storage_state:", JSON.stringify(observed.get("browser_storage_state")));
      const statePath = (exported.details as { path: string }).path;
      const state = JSON.parse(await readFile(statePath, "utf8"));
      expect(state.cookies).toHaveLength(1);
      expect(state.origins).toHaveLength(1);
      expect(state.origins[0].origin).toBe(new URL(url).origin);
      expect(state.origins[0].localStorage).toContainEqual(["fixtureKey", "fixtureValue"]);
      expect(state.origins[0].sessionStorage).toContainEqual(["fixtureSessionKey", "fixtureSessionValue"]);
      await run("browser_state", { action: "clear_cookies" });
      expect(await runText("browser_state", { action: "cookies" })).toBe("No cookies.");
      await evaluate("(() => { localStorage.clear(); sessionStorage.clear(); })()");
      expect(await evaluate("localStorage.getItem('fixtureKey')")).toBeNull();
      expect(await evaluate("sessionStorage.getItem('fixtureSessionKey')")).toBeNull();
      expect(await runText("browser_state", { action: "import", path: statePath })).toContain("applied 2 storage entries");
      expect(await runText("browser_state", { action: "cookies" })).toContain("roundtrip");
      console.info("Observed obscura set_storage_state:", JSON.stringify(observed.get("browser_set_storage_state")));
      const importedStorage = await evaluate("({ localStorage: localStorage.getItem('fixtureKey'), sessionStorage: sessionStorage.getItem('fixtureSessionKey') })");
      expect(importedStorage).toEqual({ localStorage: "fixtureValue", sessionStorage: "fixtureSessionValue" });
      console.info("Observed restored origin storage via workaround:", JSON.stringify(importedStorage));

      const resetPid = session.status().pid!;
      expect(await runText("browser_state", { action: "reset" })).toBe("Browser reset: cookies cleared, tabs closed, process restarted.");
      expect(session.status().pid).not.toBe(resetPid);
      expect(alive(resetPid)).toBe(false);
      expect(await runText("browser_state", { action: "cookies" })).toBe("No cookies.");
      checkedText(await session.call("browser_navigate", { url }));
      expect(checkedText(await session.call("browser_evaluate", { expression: "document.title" }))).toBe("Pi Browser Fixture");
      expect(checkedText(await session.call("browser_evaluate", { expression: "(() => { throw new Error('failure'); })()" }))).toBe("null");
      const oldPid = session.status().pid!;
      await expect(session.call("browser_evaluate", { expression: wrapExpression("(() => { while (true) {} })()") })).rejects.toThrow(/browser process was terminated.*tabs.*lost/i);
      await expect.poll(() => alive(oldPid), { timeout: 4000 }).toBe(false);
      checkedText(await session.call("browser_navigate", { url }));
      expect(await summarizePage(session, { maxChars: 4000 })).toContain("Pi Browser Fixture");
      const pid = session.status().pid!;
      expect(pid).not.toBe(oldPid);
      await session.stop();
      expect(alive(pid)).toBe(false);
    } finally {
      await session.stop();
      await rm(cwd, { recursive: true, force: true });
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 60_000);

  it("restores localStorage and sessionStorage after reset, immediately and after queued navigation", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><html><head><title>Storage Fixture</title></head><body>Storage fixture</body></html>");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port");
    const url = `http://127.0.0.1:${address.port}/`;
    const origin = new URL(url).origin;
    let h: Harness | undefined;
    try {
      h = await createHarness({ config: { binaryPath: binary, allowPrivateNetwork: true, autoInstall: "never" },
        extension: { launch: undefined, install: async () => { throw new Error("Real installer must never run in E2E"); } } });
      const run = async (name: string, args: Parameters<typeof tool>[1] = {}) => {
        h!.main.faux.setResponses([tool(name, args), reply("done")]);
        await h!.session.prompt(`Call ${name}`);
        const result = h!.session.messages.filter((message) => message.role === "toolResult").at(-1)!;
        expect(result.isError).toBe(false);
        return result;
      };
      const text = (result: Awaited<ReturnType<typeof run>>) => result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      const evaluate = async (expression: string) => JSON.parse(text(await run("browser_evaluate", { expression }))).value;
      const storage = "({ localStorage: localStorage.getItem('k'), sessionStorage: sessionStorage.getItem('s') })";
      await run("browser_navigate", { url });
      await evaluate("(() => { localStorage.setItem('k', 'v'); sessionStorage.setItem('s', '1'); return true; })()");
      expect(await evaluate(storage)).toEqual({ localStorage: "v", sessionStorage: "1" });
      const exported = await run("browser_state", { action: "export" });
      const path = (exported.details as { path: string }).path;
      const state = JSON.parse(await readFile(path, "utf8"));
      expect(state.origins[0]).toMatchObject({ origin, localStorage: [["k", "v"]], sessionStorage: [["s", "1"]] });
      await run("browser_state", { action: "reset" });
      await run("browser_navigate", { url });
      const empty = await evaluate(storage);
      expect(empty).toEqual({ localStorage: null, sessionStorage: null });
      console.info("Observed storage after fresh-process reset:", JSON.stringify(empty));
      const imported = await run("browser_state", { action: "import", path });
      expect(imported.details).toMatchObject({ storageApplied: 2, storageOrigin: origin, queuedOrigins: [] });
      expect(text(imported)).toContain(`applied 2 storage entries to ${origin}`);
      const restored = await evaluate(storage);
      expect(restored).toEqual({ localStorage: "v", sessionStorage: "1" });
      console.info("Observed immediate storage restore on obscura v0.2.3:", JSON.stringify(restored));
      await run("browser_state", { action: "reset" });
      expect(await evaluate("location.origin")).toBe("null");
      const queued = await run("browser_state", { action: "import", path });
      expect(queued.details).toMatchObject({ storageApplied: 0, storageOrigin: null, queuedOrigins: [origin] });
      expect(text(queued)).toContain("queued storage for 1 other origin");
      console.info("Observed queued storage import on about:blank:", JSON.stringify(queued.details));
      const navigated = await run("browser_navigate", { url });
      expect(text(navigated)).toContain(`Applied 2 queued storage entries for ${origin}.`);
      const afterNavigation = await evaluate(storage);
      expect(afterNavigation).toEqual({ localStorage: "v", sessionStorage: "1" });
      console.info("Observed queued storage restore after navigation on obscura v0.2.3:", JSON.stringify(afterNavigation));
    } finally {
      await h?.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);


  it("fetches text, markdown and links through AgentSession without MCP state, and times out on an unresponsive route", async () => {
    let neverRequested = false;
    const server = createServer((request, response) => {
      if (request.url === "/never") { neverRequested = true; return; }
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`<!doctype html><html><head><title>Pi Fetch Fixture</title></head>
        <body><h1>Fetch fixture heading</h1><p>One-shot read-only content.</p><a href="/next">Next fixture</a></body></html>`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port");
    const url = `http://127.0.0.1:${address.port}/`;
    let h: Harness | undefined;
    const start = Date.now();
    try {
      h = await createHarness({ config: { binaryPath: binary, allowPrivateNetwork: true, autoInstall: "never" },
        extension: { launch: undefined, install: async () => { throw new Error("Real installer must never run in E2E"); } } });
      const results = () => h!.session.messages.filter((message) => message.role === "toolResult");
      const fetch = async (args: Parameters<typeof tool>[1]) => {
        const before = results().length;
        h!.main.faux.setResponses([tool("browser_fetch", args), reply("done")]);
        await h!.session.prompt("Read the fixture once");
        expect(results()).toHaveLength(before + 1);
        return results().at(-1)!;
      };
      for (const format of ["text", "markdown", "links"]) {
        const result = await fetch({ url, format, timeoutMs: 5000 });
        const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
        expect(result.isError).toBe(false);
        if (format === "links") expect(text).toContain(`${url}next`);
        else {
          expect(text).toContain("Fetch fixture heading");
          expect(text).toContain("One-shot read-only content.");
          if (format === "markdown") expect(text).toContain("# Fetch fixture heading");
        }
      }
      const timedOut = await fetch({ url: `${url}never`, timeoutMs: 1000 });
      expect(timedOut.isError).toBe(true);
      // v0.2.3 can return exit 1 from its navigation deadline before the exit-124 backstop.
      expect(timedOut.content).toContainEqual({ type: "text", text: expect.stringMatching(/Fetch timed out after 1000 ms|navigation exceeded 1000ms deadline/) });
      expect(neverRequested).toBe(true);
      expect(h.confirmations).toEqual([]);
      expect(h.errors).toEqual([]);
      expect(h.statuses.filter((status) => status.text?.startsWith("browser: running"))).toEqual([]);
      expect(Date.now() - start).toBeLessThan(15000);
    } finally {
      await h?.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 20_000);
});
