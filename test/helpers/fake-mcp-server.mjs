/* Mirrors obscura v0.2.3 crates/obscura-mcp/src/lib.rs:
 * navigate: Navigated to <url> — "<title>"
 * snapshot: URL: <url>\nTitle: <title>\n\n<body>\n\nN interactive element(s) registered. ...
 * listing: ref=<ref padded to 5> <kind padded to 22> "<label>" [name="..."]
 * evaluate: strings verbatim, null/failed evaluation as "null", other values pretty JSON.
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { runInNewContext } from "node:vm";
import { deflateSync } from "node:zlib";

if (process.env.OBSCURA_FAKE_IGNORE_SIGTERM) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000); // Remain alive after stdin EOF to test SIGKILL fallback.
}

const names = [
  "echo", "big", "image", "error", "hang", "crash", "slow", "env", "handshake", "protocol_error", "partial",
  "recorded_calls",
  "browser_navigate", "browser_snapshot", "browser_interactive_elements", "browser_evaluate",
  "browser_click", "browser_fill", "browser_fill_form", "browser_type", "browser_press_key",
  "browser_select_option", "browser_scroll", "browser_wait_for", "browser_wait_for_text",
  "browser_screenshot", "browser_pdf", "browser_markdown", "browser_links", "browser_search",
  "browser_extract", "browser_detect_forms", "browser_console_messages", "browser_network_requests",
  "browser_tab_new", "browser_tab_list", "browser_tab_switch", "browser_tab_close",
  "browser_back", "browser_forward", "browser_reload", "browser_get_cookies", "browser_set_cookie",
  "browser_clear_cookies", "browser_storage_state", "browser_set_storage_state", "browser_close",
];
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const title = "Fake Browser Page";
const body = "Welcome to the fake page. Name Go Next";
const elements = [["e1", "input", "Name", "#name"], ["e2", "button", "Go", "button"], ["e3", "a", "Next", "a"]];
let initialized = false;
let initialization;
let sequence = 0;
let nextTab = 1;
let activeTab;
let cookies = [];
const tabs = new Map();
const originStorage = new Map();
const refs = new Map();
const recordedCalls = [];
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const text = (value, isError = false) => ({ content: [{ type: "text", text: value }], isError });

function newTab(url = "about:blank") {
  const id = `tab-${nextTab++}`;
  tabs.set(id, { url, title, history: [url], historyIndex: 0, values: new Map(), result: "Ready" });
  activeTab = id;
  refs.clear();
  return id;
}
newTab();
function page() { return tabs.get(activeTab); }
function currentUrl() { return page()?.url ?? "about:blank"; }
function origin() { try { return new URL(currentUrl()).origin; } catch { return "null"; } }
function storage() {
  const key = origin();
  if (!originStorage.has(key)) originStorage.set(key, { localStorage: new Map(), sessionStorage: new Map() });
  return originStorage.get(key);
}
function rebuildRefs() {
  refs.clear();
  if (page()) for (const [ref, , , selector] of elements) refs.set(ref, selector);
}
function target(args, optional = false) {
  if (args.ref !== undefined && args.selector !== undefined) throw new Error("Provide exactly one of ref or selector.");
  if (args.ref !== undefined) {
    if (!refs.has(args.ref)) throw new Error(`unknown ref '${args.ref}'; call browser_snapshot first`);
    return refs.get(args.ref);
  }
  if (args.selector !== undefined) {
    // Tools taking only a selector still rely on the latest obscura ref attributes.
    const ref = /^\[data-obscura-ref="(e\d+)"\]$/.exec(args.selector)?.[1];
    if (ref) {
      if (!refs.has(ref)) throw new Error(`unknown ref '${ref}'; call browser_snapshot first`);
      return refs.get(ref);
    }
    if (["#missing", "#never"].includes(args.selector)) throw new Error(`Element not found: ${args.selector}`);
    return args.selector;
  }
  if (!optional) throw new Error("Provide exactly one of ref or selector.");
}
function navigate(url) {
  if (url.includes("private-block")) throw new Error("Access to private/internal IP address 127.0.0.1 is not allowed");
  if (!page()) newTab();
  const tab = page();
  tab.url = url;
  tab.history.splice(tab.historyIndex + 1);
  tab.history.push(url);
  tab.historyIndex++;
  refs.clear();
}
function setCookie(cookie) {
  const value = { path: "/", secure: false, http_only: false, expires: null, ...cookie };
  value.domain = value.domain.toLowerCase().replace(/^\./, "");
  cookies = cookies.filter((entry) => !(entry.name === value.name && entry.domain === value.domain && entry.path === value.path));
  cookies.push(value);
}
function storageObject(map) {
  return {
    getItem: (key) => map.get(String(key)) ?? null,
    setItem: (key, value) => map.set(String(key), String(value)),
    removeItem: (key) => map.delete(String(key)), clear: () => map.clear(),
  };
}

// PNG chunks include CRC-32, not merely an edited IHDR, so image consumers can decode them.
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}
function screenshot(width, height) {
  if (width === undefined && height === undefined) return tinyPng;
  width ??= 1;
  height ??= 1;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 32768 || height > 32768 || width * height > 16 * 1024 * 1024) {
    throw new Error("Screenshot dimensions must be 1–32768 and at most 16 Mpx.");
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit grayscale: one zero filter byte followed by width black pixels per row.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))), pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = request;
  if (method === "initialize") {
    initialization = params;
    if (process.env.OBSCURA_FAKE_INIT_HANG) return;
    if (process.env.OBSCURA_FAKE_INIT_ERROR) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Handshake refused" } })}\n`);
      return;
    }
    reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-obscura", version: "0.2.3" } });
    return;
  }
  if (method === "notifications/initialized") { initialized = true; return; }
  if (!initialized) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Not initialized" } })}\n`);
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: names.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) });
    return;
  }
  if (method !== "tools/call") return;
  const args = params.arguments ?? {};
  const order = ++sequence;
  if (params.name !== "recorded_calls") {
    const record = { name: params.name, args, order };
    recordedCalls.push(record);
    if (process.env.OBSCURA_FAKE_RECORD) appendFileSync(process.env.OBSCURA_FAKE_RECORD, JSON.stringify(record) + "\n");
  }
  try {
    switch (params.name) {
      case "recorded_calls": reply(id, text(JSON.stringify(recordedCalls))); break;
      case "echo": reply(id, text(JSON.stringify(args))); break;
      case "big": reply(id, text("x".repeat(args.chars ?? 20000))); break;
      case "image": reply(id, { content: [{ type: "text", text: "A tiny PNG" }, { type: "image", mimeType: "image/png", data: tinyPng }], isError: false }); break;
      case "error": reply(id, text("Fake tool failure", true)); break;
      case "hang": break;
      case "crash": process.stderr.write("x".repeat(5000) + "\nFAKE_CRASH_DIAGNOSTIC\n", () => process.exit(3)); break;
      case "slow": await new Promise((resolve) => setTimeout(resolve, args.ms ?? 50)); reply(id, text(JSON.stringify({ order, ...args }))); break;
      case "env": reply(id, text(JSON.stringify(process.env))); break;
      case "handshake": reply(id, text(JSON.stringify({ initialized, initialization }))); break;
      case "protocol_error": process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "Bad fake arguments" } })}\n`); break;
      case "partial": {
        const response = JSON.stringify({ jsonrpc: "2.0", id, result: text("partial works") }) + "\n";
        process.stdout.write("non-JSON diagnostic line\n");
        process.stdout.write(response.slice(0, 13));
        setTimeout(() => process.stdout.write(response.slice(13)), 5);
        break;
      }
      case "browser_navigate":
        navigate(args.url);
        reply(id, text(`Navigated to ${currentUrl()} — "${title}"`));
        break;
      case "browser_snapshot": {
        rebuildRefs();
        const max = args.max_chars ?? 4000;
        const truncated = body.length > max ? `${body.slice(0, max)}\n...(truncated, ${body.length - max} more chars)` : body;
        reply(id, text(`URL: ${currentUrl()}\nTitle: ${title}\n\n${truncated}\n\n${refs.size} interactive element(s) registered. Call browser_interactive_elements to list, or pass \`ref\` to browser_click/browser_fill/browser_type.`));
        break;
      }
      case "browser_interactive_elements":
        rebuildRefs();
        reply(id, text(elements.slice(0, args.limit ?? 100)
          .map(([ref, kind, label]) => `ref=${ref.padEnd(5)} ${kind.padEnd(22)} ${JSON.stringify(label)}`).join("\n")));
        break;
      case "browser_evaluate": {
        try {
          const tab = page();
          const value = runInNewContext(args.expression, {
            document: { title, URL: currentUrl(), getElementById: (key) => ({ textContent: key === "result" ? tab?.result : "", value: tab?.values.get(`#${key}`) ?? "" }) },
            location: { href: currentUrl(), origin: origin() },
            localStorage: storageObject(storage().localStorage), sessionStorage: storageObject(storage().sessionStorage),
          });
          reply(id, text(typeof value === "string" ? value : value == null ? "null" : JSON.stringify(value, null, 2) ?? "null"));
        } catch { reply(id, text("null")); }
        break;
      }
      case "browser_click": {
        const selector = target(args);
        if (page()) page().result = "Clicked";
        refs.clear();
        reply(id, text(`Clicked '${selector}'`));
        break;
      }
      case "browser_fill": {
        const selector = target(args);
        if (typeof args.value !== "string") throw new Error("Missing required 'value'");
        page()?.values.set(selector, args.value);
        refs.clear();
        reply(id, text(`Filled '${selector}' with value`));
        break;
      }
      case "browser_fill_form": {
        if (!Array.isArray(args.fields) || !args.fields.length) throw new Error("Missing required 'fields'");
        let filled = 0;
        const errors = [];
        for (const field of args.fields) {
          try {
            const selector = target(field);
            page()?.values.set(selector, field.type === "check" ? true : field.type === "uncheck" ? false : field.value ?? "");
            filled++;
          } catch (error) { errors.push(error.message); }
        }
        if (args.submit_ref !== undefined || args.submit_selector !== undefined) {
          try { target({ ...(args.submit_ref !== undefined ? { ref: args.submit_ref } : {}), ...(args.submit_selector !== undefined ? { selector: args.submit_selector } : {}) }); }
          catch (error) { errors.push(error.message); }
        }
        refs.clear();
        reply(id, text(`Filled ${filled} fields.${errors.length ? ` Errors: ${errors.join("; ")}` : ""}`));
        break;
      }
      case "browser_type": {
        const selector = target(args);
        if (typeof args.text !== "string") throw new Error("Missing required 'text'");
        page()?.values.set(selector, `${page()?.values.get(selector) ?? ""}${args.text}`);
        // Obscura type preserves ref attributes until a subsequent action such as Enter.
        reply(id, text(`Typed into '${selector}'`));
        break;
      }
      case "browser_press_key":
        target(args, true);
        if (!args.key) throw new Error("Missing required 'key'");
        refs.clear();
        reply(id, text(`Pressed key '${args.key}'`));
        break;
      case "browser_select_option": {
        const selector = target(args);
        page()?.values.set(selector, args.value);
        refs.clear();
        reply(id, text(`Selected '${args.value}' in '${selector}'`));
        break;
      }
      case "browser_scroll": {
        const selector = target(args, true);
        refs.clear();
        reply(id, text(selector ? "Scrolled element into view. " : `Scrolled ${args.direction ?? "down"}. `));
        break;
      }
      case "browser_wait_for":
        if (args.selector === "#never") break; // Deliberately no reply; the client must kill on its deadline.
        reply(id, text(`Found '${target(args)}'`));
        break;
      case "browser_wait_for_text":
        reply(id, text(`Found text ${JSON.stringify(args.text)}`));
        break;
      case "browser_screenshot":
        reply(id, { content: [{ type: "image", mimeType: "image/png", data: screenshot(args.width, args.height) }], isError: false });
        break;
      case "browser_pdf":
        reply(id, { content: [{ type: "resource", resource: { uri: "obscura://capture/current-page.pdf", mimeType: "application/pdf", blob: Buffer.from("%PDF-1.4 fake").toString("base64") } }], isError: false });
        break;
      case "browser_markdown":
        reply(id, text(`# ${title}\n\n${body}\n\n[Next](${new URL("/next", currentUrl().startsWith("http") ? currentUrl() : "https://example.com").href})`.slice(0, args.max_chars ?? 4000)));
        break;
      case "browser_links": {
        const next = new URL("/next", currentUrl().startsWith("http") ? currentUrl() : "https://example.com").href;
        reply(id, text((args.limit ?? 100) > 0 ? `Next → ${next}` : "No links found."));
        break;
      }
      case "browser_search": {
        if (!args.query) throw new Error("Missing required 'query'");
        const haystack = args.case_sensitive ? body : body.toLowerCase();
        const needle = args.case_sensitive ? args.query : args.query.toLowerCase();
        const index = haystack.indexOf(needle);
        const context = args.context_chars ?? 80;
        reply(id, text(index === -1 ? "No matches found." : `1. ${body.slice(Math.max(0, index - context), index + needle.length + context)}`));
        break;
      }
      case "browser_extract": {
        if (!args.schema || typeof args.schema !== "object" || Array.isArray(args.schema)) throw new Error("Missing required 'schema'");
        const output = {};
        for (const [field, selector] of Object.entries(args.schema)) {
          const value = String(selector).includes("@href") ? new URL("/next", currentUrl().startsWith("http") ? currentUrl() : "https://example.com").href : body;
          output[field.replace(/\[\]$/, "")] = field.endsWith("[]") ? [value] : value;
        }
        reply(id, text(JSON.stringify(output, null, 2)));
        break;
      }
      case "browser_detect_forms":
        reply(id, text(JSON.stringify([{ selector: "form", fields: [{ ref: "e1", selector: "#name", name: "name", type: "text" }] }], null, 2)));
        break;
      case "browser_console_messages": reply(id, text("[log] hello from page")); break;
      case "browser_network_requests": reply(id, text(`GET ${currentUrl()} → 200`)); break;
      case "browser_tab_new": {
        if (args.url?.includes("private-block")) throw new Error("Access to private/internal IP address 127.0.0.1 is not allowed");
        const tabId = newTab(args.url);
        reply(id, text(`Opened ${tabId}: ${currentUrl()} — "${title}"`));
        break;
      }
      case "browser_tab_list":
        reply(id, text(tabs.size ? [...tabs].map(([tabId, tab]) => `${tabId}${tabId === activeTab ? " (active)" : ""}: ${tab.url} — "${tab.title}"`).join("\n") : "No open tabs."));
        break;
      case "browser_tab_switch":
        if (!args.tab_id) throw new Error("Missing required 'tab_id'");
        if (!tabs.has(args.tab_id)) throw new Error(`Unknown tab: ${args.tab_id}`);
        activeTab = args.tab_id;
        refs.clear();
        reply(id, text(`Switched to ${activeTab}: ${currentUrl()}`));
        break;
      case "browser_tab_close": {
        const tabId = args.tab_id ?? activeTab;
        if (!tabs.has(tabId)) throw new Error(`Unknown tab: ${tabId}`);
        tabs.delete(tabId);
        if (activeTab === tabId) activeTab = tabs.keys().next().value;
        refs.clear();
        reply(id, text(`Closed ${tabId}.`));
        break;
      }
      case "browser_back":
      case "browser_forward":
      case "browser_reload": {
        const tab = page();
        if (!tab) throw new Error("No active page");
        if (params.name === "browser_back") tab.historyIndex = Math.max(0, tab.historyIndex - 1);
        if (params.name === "browser_forward") tab.historyIndex = Math.min(tab.history.length - 1, tab.historyIndex + 1);
        tab.url = tab.history[tab.historyIndex];
        refs.clear();
        reply(id, text(`Navigated to ${currentUrl()} — "${title}"`));
        break;
      }
      case "browser_get_cookies": {
        const entries = cookies.filter((cookie) => !args.domain || cookie.domain === args.domain.toLowerCase().replace(/^\./, ""));
        reply(id, text(entries.length ? entries.map((cookie) => JSON.stringify(cookie)).join("\n") : "No cookies."));
        break;
      }
      case "browser_set_cookie":
        for (const key of ["name", "value", "domain"]) if (typeof args[key] !== "string") throw new Error(`Missing required '${key}'`);
        setCookie(args);
        reply(id, text(`Set cookie ${args.name} on ${args.domain}${args.path ?? "/"}`));
        break;
      case "browser_clear_cookies": cookies = []; reply(id, text("Cleared all cookies.")); break;
      case "browser_storage_state": {
        const values = storage();
        reply(id, text(JSON.stringify({ cookies, origins: page() ? [{ origin: origin(), localStorage: [...values.localStorage], sessionStorage: [...values.sessionStorage] }] : [] }, null, 2)));
        break;
      }
      case "browser_set_storage_state": {
        if (!args.state || !Array.isArray(args.state.cookies) || !Array.isArray(args.state.origins)) throw new Error("State must contain cookies and origins arrays.");
        for (const cookie of args.state.cookies) setCookie(cookie);
        // Upstream v0.2.3 restores cookies but silently does not restore origin storage.
        reply(id, text(`Restored ${args.state.cookies.length} state entries.`));
        break;
      }
      case "browser_close":
        tabs.clear(); activeTab = undefined; refs.clear();
        reply(id, text("Browser closed."));
        break;
      default: reply(id, text(`Unknown fake tool: ${params.name}`, true));
    }
  } catch (error) { reply(id, text(error.message, true)); }
});
